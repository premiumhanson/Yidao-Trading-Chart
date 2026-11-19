import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { barEnd, day, hour } from '../public/indicator-time.mjs';
import { topBottomAlerts, topBottomPeriods } from '../public/top-bottom.mjs';

const defaultPath = fileURLToPath(new URL('../data/alerts.sqlite', import.meta.url));
const historyDays = 7;
const category = '双顶底';

function databaseAt(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { allowExtension: false });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS alert_watch (
      symbol TEXT PRIMARY KEY
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS alert_cursor (
      feed TEXT NOT NULL, symbol TEXT NOT NULL, period TEXT NOT NULL, bar_time INTEGER NOT NULL,
      PRIMARY KEY (feed, symbol, period)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS alert_event (
      id INTEGER PRIMARY KEY, feed TEXT NOT NULL, symbol TEXT NOT NULL, category TEXT NOT NULL,
      period TEXT NOT NULL, direction INTEGER NOT NULL, bar_time INTEGER NOT NULL, close_time INTEGER NOT NULL,
      pattern TEXT NOT NULL, price REAL NOT NULL, digits INTEGER NOT NULL, matches TEXT NOT NULL,
      kind TEXT NOT NULL, recorded_at INTEGER NOT NULL,
      UNIQUE (feed, symbol, category, period, direction, bar_time)
    );
    CREATE INDEX IF NOT EXISTS alert_event_time ON alert_event(close_time DESC, id DESC);
    CREATE INDEX IF NOT EXISTS alert_event_symbol ON alert_event(symbol, close_time DESC, id DESC);
    CREATE INDEX IF NOT EXISTS alert_event_live ON alert_event(id DESC) WHERE kind = 'live';
  `);
  const historyFields = `
    id, symbol, category, period, direction, bar_time AS barTime, close_time AS closeTime, pattern,
    price, digits, matches, kind, recorded_at AS recordedAt
  `;
  return {
    db,
    watches: db.prepare('SELECT symbol FROM alert_watch ORDER BY symbol COLLATE NOCASE'),
    add: db.prepare('INSERT OR IGNORE INTO alert_watch VALUES (?)'),
    remove: db.prepare('DELETE FROM alert_watch WHERE symbol = ?'),
    cursor: db.prepare('SELECT bar_time FROM alert_cursor WHERE feed = ? AND symbol = ? AND period = ?'),
    advance: db.prepare(`
      INSERT INTO alert_cursor VALUES (?, ?, ?, ?)
      ON CONFLICT(feed, symbol, period) DO UPDATE SET bar_time = MAX(bar_time, excluded.bar_time)
    `),
    insert: db.prepare(`
      INSERT OR IGNORE INTO alert_event
      (feed, symbol, category, period, direction, bar_time, close_time, pattern, price, digits, matches, kind, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    history: db.prepare(`SELECT ${historyFields} FROM alert_event
      WHERE (close_time, id) < (?, ?) ORDER BY close_time DESC, id DESC LIMIT ?`),
    symbolHistory: db.prepare(`SELECT ${historyFields} FROM alert_event
      WHERE symbol = ? AND (close_time, id) < (?, ?) ORDER BY close_time DESC, id DESC LIMIT ?`),
    lastId: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM alert_event'),
    instruments: db.prepare(`
      WITH ranked AS (
        SELECT ${historyFields}, ROW_NUMBER() OVER (PARTITION BY symbol, period ORDER BY close_time DESC, id DESC) AS rank,
          COUNT(*) OVER (PARTITION BY symbol) AS total,
          COUNT(*) FILTER (WHERE direction = -1 AND close_time >= ?1) OVER (PARTITION BY symbol) AS longCount,
          COUNT(*) FILTER (WHERE direction = 1 AND close_time >= ?1) OVER (PARTITION BY symbol) AS shortCount
        FROM alert_event
      )
      SELECT * FROM ranked WHERE rank = 1 ORDER BY closeTime DESC, id DESC
    `),
    latestLive: db.prepare(`
      SELECT id, symbol, period, direction, pattern, price, digits, close_time AS closeTime
      FROM alert_event WHERE kind = 'live' ORDER BY id DESC LIMIT 1
    `),
  };
}

export function createAlertService(provider, { path = process.env.YIDAO_ALERT_DB || defaultPath, now = Date.now, pollMs = 5000 } = {}) {
  let db;
  let watches;
  let timer;
  let running = false;
  let stopped = false;
  let activeFeed;
  let summaryCache;
  function initialize() {
    if (db) return;
    db = databaseAt(path);
    watches = new Map(db.watches.all().map(({ symbol }) => [symbol, { nextRead: 0, state: 'waiting' }]));
  }

  function saveSnapshots(symbol, feed, snapshots, timestamp) {
    const higherBars = { '4h': snapshots[1].bars };
    const updates = [];
    const found = [];
    for (const [index, interval] of topBottomPeriods.entries()) {
      const { bars, digits } = snapshots[index];
      const last = bars.at(-1);
      if (!last) continue;
      const cursor = db.cursor.get(feed, symbol, interval)?.bar_time;
      if (cursor !== undefined && cursor >= last.time) continue;
      const after = cursor ?? timestamp - historyDays * day - (interval === '1h' ? hour : 4 * hour);
      for (const signal of topBottomAlerts(bars, { interval, higherBars, digits, after })) {
        const closeTime = barEnd(signal.barTime, interval);
        if (cursor === undefined && closeTime <= timestamp - historyDays * day) continue;
        const kind = cursor === undefined ? 'history' : timestamp - closeTime > 120 ? 'recovered' : 'live';
        found.push({ ...signal, closeTime, kind });
      }
      updates.push([interval, last.time]);
    }
    if (!updates.length) return;
    found.sort((a, b) => a.closeTime - b.closeTime);
    db.db.exec('BEGIN IMMEDIATE');
    try {
      for (const signal of found) {
        db.insert.run(feed, symbol, category, signal.interval, signal.direction, signal.barTime, signal.closeTime,
          signal.pattern, signal.price, signal.digits, JSON.stringify(signal.matches), signal.kind, timestamp);
      }
      for (const [interval, time] of updates) db.advance.run(feed, symbol, interval, time);
      db.db.exec('COMMIT');
    } catch (error) {
      db.db.exec('ROLLBACK');
      throw error;
    }
  }

  async function sweep() {
    if (running || stopped) return;
    initialize();
    const feed = provider.feedKey();
    if (!feed) {
      activeFeed = undefined;
      return;
    }
    if (feed !== activeFeed) {
      activeFeed = feed;
      for (const item of watches.values()) item.nextRead = 0;
    }
    running = true;
    try {
      for (const [symbol, item] of watches) {
        if (stopped || provider.feedKey() !== feed) break;
        if (item.nextRead > now()) continue;
        item.state = 'reading';
        item.message = undefined;
        try {
          const snapshots = await Promise.all(topBottomPeriods.map(interval => provider.bars({ symbol, interval, limit: 1000 })));
          if (stopped || provider.feedKey() !== feed) break;
          if (watches.get(symbol) !== item) continue;
          const current = now();
          if (!snapshots.every(result => result.bars.length)) {
            item.state = 'waiting';
            item.message = '等待 1H 和 4H 收盘行情。';
            item.nextRead = current + 60_000;
            continue;
          }
          saveSnapshots(symbol, feed, snapshots, Math.floor(current / 1000));
          const lastHour = snapshots[0].bars.at(-1).time;
          const lastFourHours = snapshots[1].bars.at(-1).time;
          const nextClose = Math.min(lastHour + 2 * hour, lastFourHours + 8 * hour) * 1000;
          const delay = current - (lastHour + hour) * 1000 > 2 * hour * 1000 ? 60_000 : 15_000;
          item.nextRead = Math.max(nextClose, current + delay);
          item.state = 'ready';
          item.lastCheck = Math.floor(current / 1000);
        } catch (error) {
          item.nextRead = now() + 30_000;
          item.state = 'error';
          item.message = error.status ? error.message : '读取或保存警报失败。';
        }
      }
    } finally {
      running = false;
    }
  }

  function wake() {
    sweep().catch(error => console.error('警报服务读取失败。', error.code || error.name));
  }

  function status() {
    initialize();
    const connected = Boolean(provider.feedKey());
    return {
      connected,
      watches: [...watches].map(([symbol, item]) => ({
        symbol, state: connected ? item.state : 'waiting', lastCheck: item.lastCheck,
        message: connected ? item.message : undefined,
      })),
      latestLive: db.latestLive.get() ?? null,
    };
  }

  return {
    sweep,
    start() {
      if (timer) return;
      timer = setInterval(wake, pollMs);
      timer.unref();
      wake();
    },
    status,
    setWatch(symbol, enabled) {
      initialize();
      if (enabled) {
        if (!watches.has(symbol)) {
          if (!provider.symbols().some(item => item.id === symbol)) {
            throw Object.assign(new Error('cTrader 终端没有这个品种。'), { status: 404 });
          }
          db.add.run(symbol);
          watches.set(symbol, { nextRead: 0, state: 'waiting' });
        }
        wake();
      } else {
        db.remove.run(symbol);
        watches.delete(symbol);
      }
      return status();
    },
    instruments() {
      initialize();
      const revision = db.lastId.get().id;
      const minute = Math.floor(now() / 60_000);
      if (summaryCache?.revision === revision && summaryCache.minute === minute) return summaryCache.items;
      const symbols = new Map();
      for (const { rank, total, longCount, shortCount, ...row } of db.instruments.all(minute * 60 - historyDays * day)) {
        const record = { ...row, matches: JSON.parse(row.matches) };
        if (!symbols.has(row.symbol)) {
          symbols.set(row.symbol, { symbol: row.symbol, total, longCount, shortCount, latest: record, periods: {} });
        }
        symbols.get(row.symbol).periods[row.period] = record;
      }
      const items = [...symbols.values()];
      summaryCache = { revision, minute, items };
      return items;
    },
    history({ limit, symbol, beforeTime = Number.MAX_SAFE_INTEGER, beforeId = Number.MAX_SAFE_INTEGER }) {
      initialize();
      const rows = symbol ? db.symbolHistory.all(symbol, beforeTime, beforeId, limit + 1) :
        db.history.all(beforeTime, beforeId, limit + 1);
      const events = rows.slice(0, limit).map(row => ({ ...row, matches: JSON.parse(row.matches) }));
      const last = events.at(-1);
      return { events, next: rows.length > limit ? { beforeTime: last.closeTime, beforeId: last.id } : null };
    },
    close() {
      stopped = true;
      clearInterval(timer);
      db?.db.close();
    },
  };
}
