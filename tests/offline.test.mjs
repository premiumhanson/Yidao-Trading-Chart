import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createOfflineProvider } from '../lib/offline.mjs';
import { createHistorySync, createHistoryTail } from '../lib/history-tail.mjs';

const directory = mkdtempSync(join(tmpdir(), 'yidao-test-'));
const path = join(directory, 'market_1h.sqlite');
const days = ['2026-11-01T00:00:00Z', '2026-11-09T00:00:00Z', '2026-11-12T00:00:00Z', '2026-11-12T08:00:00Z'];
const times = days.map(day => Date.parse(day) / 1000);
const fixture = new DatabaseSync(path);
fixture.exec(`
  CREATE TABLE symbols (
    id INTEGER PRIMARY KEY, symbol TEXT, display_name TEXT, category TEXT,
    digits INTEGER, mintick REAL, valid_from_ts INTEGER, valid_to_ts INTEGER, bar_count INTEGER
  );
  CREATE TABLE bars_1h (
    symbol_id INTEGER, ts_hour INTEGER, open_i INTEGER, high_d INTEGER, low_d INTEGER, close_d INTEGER,
    PRIMARY KEY (symbol_id, ts_hour)
  ) WITHOUT ROWID;
`);
fixture.prepare('INSERT INTO symbols VALUES (1, ?, ?, ?, 5, 0.00001, ?, ?, ?)').run(
  'EURUSD', '欧美', 'MAJOR', times[0], times.at(-1) + 3600, times.length * 2,
);
const insert = fixture.prepare('INSERT INTO bars_1h VALUES (1, ?, ?, ?, ?, ?)');
for (const time of times) {
  insert.run(time / 3600, 110266, 24, 37, -12);
  insert.run(time / 3600 + 1, 110254, 55, 30, 19);
}
fixture.close();
const tailPath = join(directory, 'ctrader-tail.sqlite');
const tail = createHistoryTail(tailPath);
const provider = createOfflineProvider(path, tail);

test('H1 data decodes and the history cursor excludes its anchor', () => {
  const page = provider.bars({ symbol: 'EURUSD', interval: '1h', limit: 3 });
  assert.ok(page.hasMore);
  assert.equal(page.digits, 5);
  assert.deepEqual(page.bars.at(-2), {
    time: times.at(-1), open: 1.10266, high: 1.10290, low: 1.10229, close: 1.10254,
  });
  const earlier = provider.bars({ symbol: 'EURUSD', interval: '1h', limit: 3, before: page.bars[0].time });
  assert.ok(earlier.bars.at(-1).time < page.bars[0].time);
  assert.throws(() => provider.bars({ symbol: 'EURUSD', interval: '15m', limit: 3 }), /1 小时/);
});

test('each replay period starts with just the revealed H1 candle', () => {
  for (const [index, interval] of ['1mo', '1w', '1d', '4h'].entries()) {
    const time = times[index];
    const cursor = provider.replay({ symbol: 'EURUSD', mode: 'start', time });
    const [hour] = provider.bars({ symbol: 'EURUSD', interval: '1h', limit: 1, before: cursor.time + 1 }).bars;
    const [rolled] = provider.bars({ symbol: 'EURUSD', interval, limit: 1, before: cursor.time + 1 }).bars;
    assert.equal(hour.time, cursor.time);
    assert.deepEqual(rolled, { ...hour, time });
    const next = provider.replay({ symbol: 'EURUSD', mode: 'next', time: cursor.time });
    assert.equal(next.time, time + 3600);
  }
});

test('H1 backfill leaves the original boundary candle intact and replay crosses it', async () => {
  const anchor = times.at(-1) + 3600;
  const source = (time, close) => ({ time, open: close - .001, high: close + .001, low: close - .002, close });
  const older = source(anchor, 1.2);
  const additions = [source(anchor + 3600, 1.201), source(anchor + 3 * 3600, 1.205)];
  const local = {
    feedKey: () => 'tape-a',
    async bars({ symbol, interval, before }) {
      assert.equal(symbol, 'EURUSD');
      assert.equal(interval, '1h');
      return before === undefined ? { bars: additions, hasMore: true } : { bars: [older], hasMore: false };
    },
  };
  const sync = createHistorySync(provider, local, tail);
  const result = await sync('EURUSD');
  assert.deepEqual(result, { state: 'ready', count: 2, added: 2, latest: additions.at(-1).time });
  const page = provider.bars({ symbol: 'EURUSD', interval: '1h', limit: 3 }).bars;
  assert.equal(page[0].time, anchor);
  assert.equal(page[0].close, 1.10273);
  assert.deepEqual(page.slice(1), additions);
  assert.equal(provider.status().addedBars, 2);
  assert.equal(provider.replay({ symbol: 'EURUSD', mode: 'next', time: anchor }).time, additions[0].time);
  assert.equal(provider.replay({ symbol: 'EURUSD', mode: 'previous', time: additions[0].time }).time, anchor);
  assert.equal(provider.replay({ symbol: 'EURUSD', mode: 'next', time: additions[0].time }).time, additions[1].time);
  assert.equal(provider.bars({ symbol: 'EURUSD', interval: '1h', limit: 1, before: anchor + 1 }).bars[0].close, 1.10273);
  assert.equal((await sync('EURUSD')).added, 0);
  const anotherFeed = {
    feedKey: () => 'tape-b',
    async bars() { return { bars: [source(anchor + 5 * 3600, 1.3)], hasMore: false }; },
  };
  assert.equal((await createHistorySync(provider, anotherFeed, tail)('EURUSD')).state, 'gap');
  assert.equal(provider.status().addedBars, 2);
});

test.after(() => {
  provider.close();
  tail.close();
  if (existsSync(tailPath)) unlinkSync(tailPath);
  unlinkSync(path);
  rmdirSync(directory);
});
