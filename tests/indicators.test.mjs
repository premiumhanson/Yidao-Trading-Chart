import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateIndicators, magnetLine, pivotAnchor } from '../public/indicators.mjs';

const ts = date => Date.parse(`${date}T00:00:00Z`) / 1000;
const candle = (time, high, low, close) => ({ time, open: close, high, low, close });

test('magnet line applies TEMA(200) and uses no future closing prices', () => {
  const bars = [
    candle(ts('2026-10-01'), 100, 100, 100),
    candle(ts('2026-10-02'), 200, 100, 200),
    candle(ts('2026-10-03'), 320, 200, 320),
  ];
  const alpha = 2 / 201;
  const expectedSecond = 100 + 100 * (3 * alpha - 3 * alpha ** 2 + alpha ** 3);
  assert.ok(Math.abs(magnetLine(bars)[1].value - expectedSecond) < 1e-12);
  assert.deepEqual(magnetLine(bars).slice(0, 2), magnetLine(bars.slice(0, 2)));
});

test('H4 November pivots reproduce the screenshot from October HLC', () => {
  const past = candle(ts('2026-10-01'), 1.13404, 1.11293, 1.12);
  const end = candle(ts('2026-10-30'), 1.12296, 1.11136, 1.1162);
  const current = candle(ts('2026-11-02'), 1.1283, 1.106, 1.11);
  const visible = calculateIndicators([past, end, current], { interval: '4h' }).pivots;
  const november = visible.filter(line => !line.future && line.from === current.time);
  assert.ok(november.some(({ label }) => label === 'P (1.12053)'));
  assert.ok(november.some(({ label }) => label === '−0.382 (1.11187)'));
  const next = visible.find(line => line.future && line.label.startsWith('P '));
  assert.ok(next);
  assert.equal(next.to, current.time);
  assert.equal(pivotAnchor(ts('2021-11-10'), '1w'), ts('2019-01-01'));
  assert.equal(pivotAnchor(ts('2026-11-15'), '15m'), ts('2026-11-15'));
});

test('repeated highs emit a signal at confirmation and only on H1/H4', () => {
  const start = ts('2026-10-01');
  const bars = Array.from({ length: 50 }, (_, i) =>
    candle(start + i * 3600, i === 10 || i === 28 ? 110 : 101, 99, 100),
  );
  assert.equal(calculateIndicators(bars.slice(0, 33)).reversals.length, 0);
  const confirmed = calculateIndicators(bars.slice(0, 34));
  assert.equal(confirmed.reversals[0].time, bars[33].time);
  assert.match(confirmed.reversals[0].text, /双顶 P5/);
  assert.equal(confirmed.reversals[0].position, 'aboveBar');
  assert.equal(confirmed.zones[0].direction, 'top');
  assert.equal(calculateIndicators(bars, { interval: '15m' }).reversals.length, 0);
});
