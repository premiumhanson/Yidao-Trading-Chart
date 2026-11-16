import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const bundledPath = fileURLToPath(new URL('../resources/market_1h.sqlite', import.meta.url));
export const offlineIntervals = ['1h', '2h', '4h', '8h', '12h', '1d', '1w', '1mo'];
const offlineHours = { '1h': 1, '2h': 2, '4h': 4, '8h': 8, '12h': 12, '1d': 24 };
const hourSeconds = 3600;

export function bucketHour(hour, interval) {
  const step = offlineHours[interval];
  if (step) return Math.floor(hour / step) * step;
  if (interval === '1w') return Math.floor((hour - 96) / 168) * 168 + 96;
  const date = new Date(hour * hourSeconds * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 3600000;
}

export function createOfflineProvider(path = process.env.KUNHOU_DB || bundledPath) {
  let db;
  let message = '已连接本地历史库';
  let catalog = [];
  let scan;
  let recent;
  let after;
  let prior;
  try {
    if (!existsSync(path)) throw new Error('missing');
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF');
    catalog = db.prepare(
      'SELECT id, symbol AS name, display_name AS description, category, digits, mintick, ' +
      'valid_from_ts AS first, valid_to_ts AS last, bar_count AS count FROM symbols ORDER BY id',
    ).all();
    scan = db.prepare(
      'SELECT ts_hour, open_i, high_d, low_d, close_d FROM bars_1h ' +
      'WHERE symbol_id = ? AND ts_hour < ? ORDER BY ts_hour DESC LIMIT ?',
    );
    recent = db.prepare(
      'SELECT open_i + close_d AS value FROM bars_1h ' +
      'WHERE symbol_id = ? AND ts_hour < ? ORDER BY ts_hour DESC LIMIT 2',
    );
    after = db.prepare(
      'SELECT ts_hour FROM bars_1h WHERE symbol_id = ? AND ts_hour >= ? ORDER BY ts_hour LIMIT 1',
    );
    prior = db.prepare(
      'SELECT ts_hour FROM bars_1h WHERE symbol_id = ? AND ts_hour < ? ORDER BY ts_hour DESC LIMIT 1',
    );
  } catch {
    db?.close();
    db = undefined;
    message = '无法读取历史库，请检查 KUNHOU_DB 指向的 SQLite 文件。';
  }

  const index = new Map(catalog.flatMap(item => [
    [String(item.id), item], [item.name.toUpperCase(), item],
  ]));

  function status() {
    return {
      configured: Boolean(db), connected: Boolean(db), message, intervals: offlineIntervals,
      symbols: catalog.length,
      bars: catalog.reduce((total, item) => total + item.count, 0),
      latest: catalog.reduce((latest, item) => Math.max(latest, item.last), 0),
    };
  }

  function symbols() {
    return catalog.map(item => {
      const pair = recent.all(item.id, Number.MAX_SAFE_INTEGER);
      const last = pair[0]?.value * item.mintick;
      const previous = pair[1]?.value * item.mintick;
      return {
        ...item, id: String(item.id), lastPrice: Number.isFinite(last) ? last : null,
        changePercent: previous ? (last / previous - 1) * 100 : null,
      };
    });
  }

  function bars({ symbol, interval, limit, before }) {
    if (!db) throw Object.assign(new Error(message), { status: 503 });
    const item = index.get(String(symbol).toUpperCase());
    if (!item) throw Object.assign(new Error('本地历史库中没有这个品种。'), { status: 404 });
    if (!offlineIntervals.includes(interval)) {
      throw Object.assign(new Error('本地历史库支持 1 小时及以上周期。'), { status: 400 });
    }

    const result = [];
    const scale = item.mintick;
    // With an H1 replay cutoff, higher periods contain only hours seen so far.
    let cursor = before == null ? Number.MAX_SAFE_INTEGER : Math.ceil(before / hourSeconds);
    const batchSize = interval === '1h' ? limit + 1 : 8192;
    while (result.length < limit + 2) {
      const batch = scan.all(item.id, cursor, batchSize);
      if (!batch.length) break;
      for (const row of batch) {
        const time = bucketHour(row.ts_hour, interval) * hourSeconds;
        const open = Number((row.open_i * scale).toFixed(item.digits));
        const high = Number(((row.open_i + row.high_d) * scale).toFixed(item.digits));
        const low = Number(((row.open_i - row.low_d) * scale).toFixed(item.digits));
        const close = Number(((row.open_i + row.close_d) * scale).toFixed(item.digits));
        const last = result.at(-1);
        if (last?.time === time) {
          last.open = open;
          last.high = Math.max(last.high, high);
          last.low = Math.min(last.low, low);
        } else {
          result.push({ time, open, high, low, close });
          if (result.length > limit) break;
        }
      }
      if (batch.length < batchSize || result.length > limit) break;
      cursor = batch.at(-1).ts_hour;
    }
    return { bars: result.slice(0, limit).reverse(), hasMore: result.length > limit, digits: item.digits };
  }

  function replay({ symbol, mode, time }) {
    if (!db) throw Object.assign(new Error(message), { status: 503 });
    const item = mode === 'random' ? catalog[Math.floor(Math.random() * catalog.length)] :
      index.get(String(symbol).toUpperCase());
    if (!item) throw Object.assign(new Error('本地历史库中没有这个品种。'), { status: 404 });
    const hour = Math.floor(time / hourSeconds);
    const start = mode === 'random' ? item.first + (item.last - item.first) * (0.2 + Math.random() * 0.65) :
      time ?? item.last - 7 * 86400;
    const row = mode === 'previous' ? prior.get(item.id, hour) :
      after.get(item.id, mode === 'next' ? hour + 1 : Math.floor(start / hourSeconds));
    return { symbol: String(item.id), time: row ? row.ts_hour * hourSeconds : null };
  }

  return {
    label: '本地历史库', intervals: offlineIntervals, status, symbols, bars, replay,
    close: () => db?.close(),
  };
}
