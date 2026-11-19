import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createAlertService } from '../lib/alerts.mjs';
import { hour } from '../public/indicator-time.mjs';
import { topBottomAlerts } from '../public/top-bottom.mjs';

const start = Date.UTC(2026, 10, 1) / 1000;
const frame = 4 * hour;
const bars = Array.from({ length: 70 }, (_, index) => {
  const time = start + index * frame;
  if (index === 38) return { time, open: 118, high: 120, low: 116, close: 118 };
  if (index === 64) return { time, open: 115, high: 118, low: 113, close: 115.1 };
  if (index === 68) return { time, open: 116, high: 119, low: 114, close: 116.1 };
  if (index === 69) return { time, open: 160, high: 161, low: 159, close: 160 };
  return { time, open: 100, high: 102, low: 98, close: 100 };
});

test('alert events group P5/P10/P15 on the same candle and survive later zone invalidation', () => {
  const events = topBottomAlerts(bars, { interval: '4h', digits: 2, after: bars[63].time });
  assert.deepEqual(events.map(event => [event.barTime, event.pattern, event.price]), [
    [bars[64].time, '双顶', 115.1], [bars[68].time, '三顶', 116.1],
  ]);
  assert.deepEqual(events[0].matches.slice().sort(), ['双顶 P10', '双顶 P15', '双顶 P5']);
  assert.deepEqual(topBottomAlerts(bars.slice(0, 65), {
    interval: '4h', digits: 2, after: bars[64].time,
  }), []);
});

test('the local alert service persists watches, paginates simultaneous alerts and resumes without duplicates', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'yidao-alerts-'));
  const path = join(directory, 'alerts.sqlite');
  let length = 65;
  let clock = (bars[length - 1].time + frame + 1) * 1000;
  const symbols = [{ id: 'ONE' }, { id: 'TWO' }];
  const provider = {
    feedKey: () => 'fixture',
    symbols: () => symbols,
    bars({ interval }) {
      const results = interval === '4h' ? bars.slice(0, length) : Array.from({ length: 128 }, (_, index) => ({
        time: Math.floor(clock / 1000 / hour) * hour - (128 - index) * hour,
        open: 100, high: 102, low: 98, close: 100,
      }));
      return { bars: results, digits: 2 };
    },
  };
  let service = createAlertService(provider, { path, now: () => clock });
  t.after(() => {
    service.close();
    unlinkSync(path);
    rmdirSync(directory);
  });
  service.setWatch('ONE', true);
  service.setWatch('TWO', true);
  await setImmediate();
  const first = service.history({ limit: 1 });
  assert.equal(first.events[0].kind, 'history');
  const second = service.history({ limit: 1, ...first.next });
  assert.equal(first.events[0].closeTime, second.events[0].closeTime);
  assert.notEqual(first.events[0].symbol, second.events[0].symbol);
  assert.equal(second.next, null);
  assert.equal(service.status().latestLive, null);

  length = 69;
  clock = (bars[length - 1].time + frame + 1) * 1000;
  await service.sweep();
  const live = service.history({ limit: 10 }).events;
  assert.deepEqual(live.map(event => event.kind), ['live', 'live', 'history', 'history']);
  assert.ok(service.status().latestLive?.id);
  const [one, two] = service.instruments().sort((a, b) => a.symbol.localeCompare(b.symbol));
  assert.deepEqual([one.total, one.longCount, one.shortCount, one.latest.pattern], [2, 0, 2, '三顶']);
  assert.equal(two.periods['4h'].id, live.find(event => event.symbol === 'TWO').id);
  const onePage = service.history({ limit: 1, symbol: 'ONE' });
  assert.equal(onePage.events[0].symbol, 'ONE');
  assert.equal(service.history({ limit: 20, symbol: 'ONE', ...onePage.next }).events.length, 1);

  service.close();
  service = createAlertService(provider, { path, now: () => clock });
  await service.sweep();
  assert.deepEqual(service.history({ limit: 10 }).events, live);
  assert.deepEqual(service.status().watches.map(item => item.symbol), ['ONE', 'TWO']);
  service.setWatch('ONE', false);
  assert.equal(service.history({ limit: 10 }).events.length, 4);
  clock += 8 * 24 * hour * 1000;
  assert.ok(service.instruments().every(item => item.total === 2 && item.shortCount === 0));
});
