import { day, hour, week, monthIndex, weekStart } from './indicator-time.mjs';
import { magnetIndicator, resonancePeriods } from './magnet.mjs';

const pivotStyles = [
  [0, 'P', '#d5d1ab'],
  [0.382, '0.382', '#fcec60'], [-0.382, '−0.382', '#4695a8'],
  [0.618, '0.618', '#f19d38'], [-0.618, '−0.618', '#3051ca'],
  [1, '1', '#dd484c'], [-1, '−1', '#508448'],
];
const fibRatios = [0.236, 0.5, 0.715, 0.786, 1.618, 2.618];
const previewPeriods = ['30m', '1h', '2h', '4h', '8h', '1d', '1w', '1mo'];
const specs = {
  weekly: { key: 'weekly', delay: 36 * hour },
  monthly: { key: 'monthly', months: 1, delay: 10 * day },
  quarterly: { key: 'quarterly', months: 3, delay: 30 * day, badge: '3M' },
  annual: { key: 'annual', months: 12, years: 1, delay: 17 * week, badge: '1Y' },
  triennial: { key: 'triennial', months: 36, years: 3, delay: 52 * week, badge: '3Y' },
  decennial: { key: 'decennial', months: 120, years: 10, delay: 156 * week },
};

export function pivotPeriod(bars, interval) {
  if (interval === '4h' || interval === '8h') return specs.monthly;
  if (interval === '1d') return specs.quarterly;
  if (interval !== '1w' && interval !== '1mo') return specs.weekly;
  const years = bars.length ? Math.floor(monthIndex(bars.at(-1).time) / 12) - Math.floor(monthIndex(bars[0].time) / 12) : 0;
  if (interval === '1w') return years >= 3 ? specs.triennial : years >= 1 ? specs.annual : specs.quarterly;
  return years >= 10 ? specs.decennial : years >= 3 ? specs.triennial : specs.annual;
}

function aggregatePeriods(bars, spec) {
  const aggregate = [];
  const bucket = time => spec.months ? Math.floor(monthIndex(time) / Math.min(12, spec.months)) : weekStart(time);
  let current;
  let changes = 0;
  let previousBucket;
  for (const bar of bars) {
    const key = bucket(bar.time);
    if (key !== previousBucket) {
      if (current) changes++;
      previousBucket = key;
    }
    if (!current || changes >= (spec.years || 1)) {
      current = { from: bar.time, to: bar.time, high: bar.high, low: bar.low, close: bar.close };
      aggregate.push(current);
      changes = 0;
    } else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.to = bar.time;
    }
  }
  return aggregate;
}

function levels(reference, protectedBy, span, digits, badge, extension = false) {
  const center = (reference.high + reference.low + reference.close) / 3;
  const range = reference.high - reference.low;
  const tolerance = (protectedBy.high - protectedBy.low) * 0.1;
  const min = protectedBy.low - tolerance;
  const max = protectedBy.high + tolerance;
  const lines = [];
  for (const [ratio, name, color] of pivotStyles) {
    const price = center + ratio * range;
    if (Math.abs(ratio) > 0.382 && (price < min || price > max)) continue;
    const text = ratio === 0 && badge ? 'P [' + badge + ']' : name;
    lines.push({
      ...span, price, label: extension ? '' : text + ' (' + price.toFixed(digits) + ')',
      color: extension ? color + '8c' : color, major: true, extension,
    });
  }
  if (extension) return lines;
  for (const ratio of fibRatios) {
    for (const sign of [-1, 1]) {
      const price = center + sign * ratio * range;
      if (ratio !== 0.236 && (price < min || price > max)) continue;
      lines.push({ ...span, price, label: String(ratio), color: 'rgba(219, 219, 219, .30)', major: false });
    }
  }
  return lines;
}

export function pivotLines(bars, interval, digits) {
  const spec = pivotPeriod(bars, interval);
  const groups = aggregatePeriods(bars, spec);
  const badge = (interval === '1w' && spec !== specs.triennial) ||
    (interval === '1mo' && spec !== specs.decennial) ? spec.badge : undefined;
  const result = [];
  for (let index = Math.max(1, groups.length - 200); index < groups.length; index++) {
    const current = groups[index];
    const previous = groups[index - 1];
    const following = groups[index + 1];
    const span = { from: current.from, to: following?.from ?? current.to, active: !following };
    if (!following && index >= 2) {
      result.push(...levels(groups[index - 2], previous, span, digits, badge, true));
    }
    result.push(...levels(previous, current, span, digits, badge));
  }
  const current = groups.at(-1);
  if (current && previewPeriods.includes(interval) && current.to - current.from >= spec.delay) {
    result.push(...levels(current, current, { from: current.to, to: current.to, future: true }, digits, badge));
  }
  return result;
}

export function indicatorContexts(interval, { reversal, magnet }) {
  const periods = new Set();
  if (reversal && interval === '1h') periods.add('4h');
  if (magnet) {
    for (const period of resonancePeriods[interval] || []) periods.add(period);
    if (interval === '1mo') periods.add('1w');
  }
  periods.delete(interval);
  return periods;
}

export function calculateIndicators(bars, {
  interval = '1h', higherBars, digits = 5, cutoff,
  showPivots = true, showMagnet = true,
} = {}) {
  const visible = cutoff === undefined ? bars : bars.filter(bar => bar.time < cutoff);
  const magnetic = showMagnet ? magnetIndicator(visible, { interval, higherBars, cutoff }) :
    { magnet: [], glow: [], upper: [], lower: [] };
  return {
    ...magnetic,
    pivots: showPivots ? pivotLines(visible, interval, digits) : [],
  };
}
