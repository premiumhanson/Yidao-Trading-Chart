import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pivotLines, pivotPeriod } from '../public/indicators.mjs';
import { magnetIndicator, magnetPrices } from '../public/magnet.mjs';
import { day, hour } from '../public/indicator-time.mjs';
import { structureSignals } from '../public/momentum.mjs';
import { entryWindows, topBottomDrawings, topBottomIndicator } from '../public/top-bottom.mjs';

const ts = date => Date.parse(date + 'T00:00:00Z') / 1000;
const candle = (time, high, low, close, open = close) => ({ time, open, high, low, close });

test('TEMA(200) smooths the S+ score-derived price, including its weekly warmup', () => {
  const bars = [
    candle(ts('2026-10-05'), 130, 70, 100),
    candle(ts('2026-10-12'), 112, 99, 101),
    candle(ts('2026-10-13'), 140, 99, 102),
  ];
  const scores = magnetPrices(bars);
  assert.equal(scores[0], undefined);
  assert.equal(scores[1].score, 1);
  assert.equal(scores[2].score, 4);
  assert.ok(Math.abs(scores[1].price - 111.46) < 1e-12);
  assert.ok(Math.abs(scores[2].price - 137.08) < 1e-12);
  const options = { interval: '1d' };
  const result = magnetIndicator(bars, options).magnet;
  const alpha = 2 / 201;
  const expected = scores[1].price + (scores[2].price - scores[1].price) * (3 * alpha - 3 * alpha ** 2 + alpha ** 3);
  assert.ok(Math.abs(result[1].value - expected) < 1e-12);
  assert.deepEqual(result.slice(0, 1), magnetIndicator(bars.slice(0, 2), options).magnet);
});

test('W and M pivot fallbacks follow observed calendar year boundaries', () => {
  const history = (...dates) => dates.map((date, i) => candle(ts(date), 10 + i, 5, 7));
  assert.equal(pivotPeriod(history('2026-01-05', '2026-10-05'), '1w').key, 'quarterly');
  assert.equal(pivotPeriod(history('2025-12-08', '2026-02-02'), '1w').key, 'annual');
  assert.equal(pivotPeriod(history('2023-12-04', '2026-02-02'), '1w').key, 'triennial');
  assert.equal(pivotPeriod(history('2025-03-01', '2026-02-01'), '1mo').key, 'annual');
  assert.equal(pivotPeriod(history('2023-03-01', '2026-02-01'), '1mo').key, 'triennial');
  assert.equal(pivotPeriod(history('2016-03-01', '2026-02-01'), '1mo').key, 'decennial');
  const bars = history('2017-12-25', '2018-01-01', '2019-01-07', '2020-01-06');
  const visible = pivotLines(bars, '1w', 4).find(line => line.label.startsWith('P '));
  assert.equal(visible.from, bars[3].time);
});

test('pivot protection keeps both 0.236 levels and delays the next H4 preview', () => {
  const bars = [
    candle(ts('2026-10-01'), 1.13404, 1.11293, 1.12),
    candle(ts('2026-10-30'), 1.12296, 1.11136, 1.1162),
    candle(ts('2026-11-02'), 1.1283, 1.106, 1.11),
    candle(ts('2026-11-12'), 1.125, 1.105, 1.12),
  ];
  const november = pivotLines(bars.slice(0, 3), '4h', 5);
  assert.ok(november.some(({ label }) => label === 'P (1.12053)'));
  assert.ok(november.some(({ label }) => label === '−0.382 (1.11187)'));
  const minor = november.filter(line => line.label === '0.236').map(line => line.price);
  assert.equal(minor.length, 2);
  assert.ok(Math.abs((minor[0] + minor[1]) / 2 - (1.13404 + 1.11136 + 1.1162) / 3) < 1e-12);
  assert.ok(!november.some(line => line.label === '1.618' || line.future));
  assert.ok(pivotLines(bars, '4h', 5).some(line => line.future && line.label.startsWith('P ')));
  assert.equal(pivotPeriod(bars, '15m').key, 'weekly');
  assert.ok(!pivotLines(bars, '15m', 5).some(line => line.future));
});

test('the last active pivot extends only prior major levels and labels fallback', () => {
  const bars = [
    candle(ts('2026-01-05'), 14, 8, 10),
    candle(ts('2026-04-06'), 17, 10, 11),
    candle(ts('2026-07-06'), 19, 11, 16),
  ];
  const result = pivotLines(bars, '1w', 2);
  assert.ok(result.some(line => line.label.startsWith('P [3M]')));
  assert.ok(result.some(line => line.extension && line.from === bars[2].time));
  assert.ok(result.filter(line => line.extension).every(line => line.major && !line.label));
});

test('a descending CO candidate must break and retest before the next closed candle confirms it', () => {
  const bars = Array.from({ length: 75 }, (_, i) => {
    const time = ts('2026-11-02') + i * hour;
    const trend = 120 - 0.25 * (i - 35);
    if (i === 35 || i === 46) return candle(time, trend + 0.5, trend - 7, trend, trend - 4);
    if (i >= 57 && i <= 59) return candle(time, trend + 3.75, trend - 3.75, trend - 0.95, trend - 1);
    if (i >= 61 && i <= 63) return candle(time, trend + 5, trend - 2.5, trend + 4.2, trend + 4);
    if (i === 64) return candle(time, trend + 3.75, trend - 3.75, trend + 0.5, trend + 0.25);
    return candle(time, trend + 0.5, trend - 7, trend - 2.5, trend - 6.5);
  });
  const options = { interval: '1h', digits: 5 };
  const cutoff = bars[65].time;
  assert.equal(structureSignals(bars.filter(bar => bar.time < cutoff), { ...options, cutoff }).reversals.length, 0);
  const confirmed = structureSignals(bars.filter(bar => bar.time <= cutoff), { ...options, cutoff: cutoff + hour });
  assert.ok(confirmed.trends.length > 0);
  assert.equal(confirmed.reversals[0].time, bars[64].time);
  assert.equal(confirmed.reversals[0].confirmedAt, bars[65].time);
  assert.match(confirmed.reversals[0].text, /上破回踩 P5.*CO3/);
});

function topBottomFixture(start, spacing, length = 220) {
  return Array.from({ length }, (_, i) => {
    const time = start + i * spacing;
    if (i === 38) return candle(time, 120, 116, 118);
    if (i === 64) return candle(time, 118, 113, 115.1, 115);
    if (i === 68) return candle(time, 119, 114, 116.1, 116);
    return candle(time, 102, 98, 100);
  });
}

test('P5/P10/P15 show live previews, then confirm zones, counted endpoints and both stop prices on close', () => {
  const bars = topBottomFixture(ts('2026-09-01'), 4 * hour);
  const options = { interval: '4h', digits: 2 };
  const preClose = topBottomIndicator(bars.slice(0, 65), { ...options, cutoff: bars[64].time + hour });
  assert.ok(topBottomDrawings(preClose).boxes.every(box => box.kind === 'candidate'));
  assert.equal(topBottomDrawings(preClose).labels.length, 0);
  assert.deepEqual(entryWindows(preClose).map(row => [row.period, row.name, row.locked]),
    [[5, '双顶', false], [10, '双顶', false], [15, '双顶', false]]);
  const closed = topBottomIndicator(bars.slice(0, 65), options);
  const { boxes, labels, lines } = topBottomDrawings(closed);
  assert.deepEqual(boxes.map(box => [box.name, box.from, box.kind]),
    [[5], [10], [15]].map(([period]) => [`双顶 P${period}`, 38, 'confirmed']));
  assert.ok(labels.some(label => label.mark && label.at === 38));
  assert.equal(labels.find(label => label.name === '双顶 P5').labelStop, 138);
  assert.ok(lines.some(line => line.value === 142 && line.from === 64 && line.to === undefined));
  assert.ok(lines.some(line => line.value === 138 && line.endpoint && line.to - line.from === 19));
  assert.ok(entryWindows(closed).every(row => row.locked && row.stop === 142 && row.labelStop === 138));
  const third = topBottomIndicator(bars.slice(0, 69), options);
  assert.equal(topBottomDrawings(third).boxes.find(box => box.from === 38).name, '三顶 P5');
  const frozen = topBottomDrawings(topBottomIndicator(bars, options));
  assert.equal(frozen.boxes.find(box => box.from === 38).to, 169);
  const broken = bars.slice(0, 70);
  broken[69] = candle(bars[69].time, 161, 159, 160);
  const invalidated = topBottomDrawings(topBottomIndicator(broken, options));
  assert.equal(invalidated.labels.length, 0);
  assert.equal(invalidated.lines.length, 0);
  assert.equal(invalidated.boxes.length, 0);
});

test('a ratio that rounds to 33% in Pine waits for momentum instead of confirming', () => {
  const bars = topBottomFixture(ts('2026-09-01'), 4 * hour, 65);
  const options = { interval: '4h', digits: 2 };
  const span = bars.slice(-30).reduce((sum, bar) => sum + (bar.high - bar.low), 0);
  const last = bars.at(-1);
  last.close = 117.5;
  last.open = last.close - (33 - 2e-10) * span / 1000;
  const threshold = topBottomIndicator(bars, options);
  const [window] = entryWindows(threshold);
  assert.ok(window.ratio < 33);
  assert.equal(window.momentumActive, false);
  assert.equal(topBottomDrawings(threshold).labels.length, 0);

  last.open += 0.01;
  const below = topBottomIndicator(bars, options);
  assert.equal(entryWindows(below)[0].momentumActive, true);
  assert.ok(topBottomDrawings(below).labels.some(label => label.name === '双顶 P5'));
});

test('H1 bottom signals and windows require an already available, same-direction 4H zone', () => {
  const end = ts('2026-10-01');
  const mirror = bar => candle(bar.time, 220 - bar.low, 220 - bar.high, 220 - bar.close, 220 - bar.open);
  const bars = topBottomFixture(end - 64 * hour, hour, 65).map(mirror);
  const aligned = topBottomFixture(end - 59 * 4 * hour, 4 * hour, 60);
  const late = aligned.map(bar => ({ ...mirror(bar), time: bar.time + 24 * 4 * hour }));
  for (const h4 of [aligned, late]) {
    const result = topBottomIndicator(bars, { interval: '1h', higherBars: { '4h': h4 } });
    assert.ok(topBottomDrawings(result).labels.every(label => label.direction === 1));
    assert.equal(entryWindows(result).length, 0);
  }
  const result = topBottomIndicator(bars, { interval: '1h', higherBars: { '4h': aligned.map(mirror) } });
  const projected = topBottomDrawings(result).boxes.find(box => box.kind === 'higher' && box.direction === -1);
  assert.match(projected.name, /^4H 底区 P/);
  assert.ok(topBottomDrawings(result).labels.some(label => label.name === '双底 P5' && label.matched));
  assert.ok(entryWindows(result).some(row => row.name === '双底'));
  assert.equal(topBottomIndicator(bars, { interval: '15m' }), undefined);
});

test('H4 attachment after a gap waits for the first new H1 close before updating the zone state', () => {
  const h4 = topBottomFixture(ts('2026-09-01'), 4 * hour, 44);
  const start = h4.at(-1).time;
  const bars = [candle(start, 102, 98, 100), candle(start + 4 * hour, 102, 98, 100)];
  const options = { interval: '1h', higherBars: { '4h': h4 } };
  const preview = topBottomIndicator(bars, { ...options, cutoff: start + 4.5 * hour });
  assert.equal(preview.projected.length, 0);
  const confirmed = topBottomIndicator(bars, { ...options, cutoff: start + 5 * hour });
  assert.ok(confirmed.projected.some(zone => zone.name.startsWith('4H 顶区 P5')));
});

test('higher-timeframe S+ resonance cannot use unclosed reference candles in replay', () => {
  const start = ts('2025-01-06');
  const seq = (size, spacing) => Array.from({ length: size }, (_, i) => candle(
    start + i * spacing, 100 + i / 8, 97 + i / 9, 99 + i / 9,
  ));
  const bars = seq(300, hour);
  const all = seq(200, 4 * hour);
  const cutoff = bars.at(-1).time + hour;
  const options = { interval: '1h', cutoff, higherBars: { '2h': seq(400, 2 * hour), '4h': all } };
  const seen = all.filter(bar => bar.time + 4 * hour <= cutoff);
  assert.deepEqual(
    magnetIndicator(bars, options),
    magnetIndicator(bars, { ...options, higherBars: { ...options.higherBars, '4h': seen } }),
  );
  assert.ok(cutoff < start + 2 * 7 * day);
});
