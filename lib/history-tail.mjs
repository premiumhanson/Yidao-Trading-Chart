import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const hour = 3600;
const defaultPath = fileURLToPath(new URL('../data/ctrader-h1.sqlite', import.meta.url));

export function createHistoryTail(path = defaultPath) {
  let db;
  let statements;

  function open(create = false) {
    if (statements) return statements;
    if (!create && !existsSync(path)) return undefined;
    if (create) mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path, { allowExtension: false });
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS h1_tail (
        symbol TEXT NOT NULL, feed TEXT NOT NULL, ts_hour INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
        PRIMARY KEY (symbol, feed, ts_hour)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS h1_active (
        symbol TEXT PRIMARY KEY, base_hour INTEGER NOT NULL, feed TEXT NOT NULL
      );
    `);
    const select = 'FROM h1_tail WHERE symbol = ? AND feed = ? AND ts_hour > ?';
    statements = {
      active: db.prepare('SELECT feed FROM h1_active WHERE symbol = ? AND base_hour = ?'),
      summary: db.prepare(`SELECT count(*) AS count, max(ts_hour) AS latest ${select}`),
      before: db.prepare(`SELECT ts_hour, open, high, low, close ${select} AND ts_hour < ? ORDER BY ts_hour DESC LIMIT ?`),
      next: db.prepare(`SELECT ts_hour ${select} AND ts_hour >= ? ORDER BY ts_hour LIMIT 1`),
      prior: db.prepare(`SELECT ts_hour ${select} AND ts_hour < ? ORDER BY ts_hour DESC LIMIT 1`),
      put: db.prepare(`
        INSERT INTO h1_tail VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, feed, ts_hour) DO UPDATE SET
          open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close
      `),
      activate: db.prepare(`
        INSERT INTO h1_active VALUES (?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET base_hour = excluded.base_hour, feed = excluded.feed
      `),
    };
    return statements;
  }

  function query(kind, item, args = [], feed) {
    let sql;
    try { sql = open(); }
    catch { return undefined; }
    if (!sql) return undefined;
    const base = item.last / hour;
    const current = feed ?? sql.active.get(item.name, base)?.feed;
    if (!current) return undefined;
    const values = [item.name, current, base, ...args];
    return kind === 'before' ? sql.before.all(...values) : sql[kind].get(...values);
  }

  return {
    summary(item, feed) {
      const data = query('summary', item, [], feed);
      return { count: data?.count || 0, latest: data?.latest ? data.latest * hour : item.last };
    },
    checkpoint(item, feed) {
      const active = open()?.active.get(item.name, item.last / hour)?.feed;
      return active === feed ? this.summary(item, feed) : { count: 0, latest: item.last };
    },
    before: (item, cursor, limit) => query('before', item, [cursor, limit]) || [],
    next: (item, cursor) => query('next', item, [cursor]),
    prior: (item, cursor) => query('prior', item, [cursor]),
    save(item, feed, bars) {
      if (!bars.length && !query('summary', item, [], feed)?.count) return;
      const sql = open(true);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const bar of bars) {
          sql.put.run(item.name, feed, bar.time / hour, bar.open, bar.high, bar.low, bar.close);
        }
        sql.activate.run(item.name, item.last / hour, feed);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close() { db?.close(); },
  };
}

export function createHistorySync(offline, local, tail) {
  const pending = new Map();

  async function fill(item, brokerSymbol, feed) {
    const previous = tail.checkpoint(item, feed);
    const bars = [];
    let before;
    for (let page = 0; page < 16; page++) {
      const data = await local.bars({ symbol: brokerSymbol, interval: '1h', limit: 500, before });
      if (local.feedKey() !== feed) throw Object.assign(new Error('cTrader 已重新连接，请重试补历史。'), { status: 503 });
      const anchor = data.bars[0]?.time;
      if (!anchor) break;
      const additions = data.bars.filter(bar => bar.time > previous.latest);
      if (additions.some(bar => bar.time % hour !== 0)) {
        return { state: 'unaligned', ...previous };
      }
      bars.push(...additions);
      if (anchor <= previous.latest) {
        tail.save(item, feed, bars);
        return { state: 'ready', ...tail.summary(item, feed), added: bars.length };
      }
      if (!data.hasMore || anchor === before) break;
      before = anchor;
    }
    return { state: 'gap', ...previous };
  }

  return function sync(symbol) {
    const item = offline.findByName(symbol);
    const feed = local.feedKey();
    if (!item) return Promise.resolve({ state: 'unmapped' });
    if (!feed) throw Object.assign(new Error(local.status().message), { status: 503 });
    const key = feed + ':' + symbol;
    if (!pending.has(key)) {
      const work = fill(item, symbol, feed).finally(() => pending.delete(key));
      pending.set(key, work);
    }
    return pending.get(key);
  };
}
