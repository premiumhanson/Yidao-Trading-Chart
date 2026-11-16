import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createOfflineProvider } from '../lib/offline.mjs';

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
const provider = createOfflineProvider(path);

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

test.after(() => {
  provider.close();
  unlinkSync(path);
  rmdirSync(directory);
});
