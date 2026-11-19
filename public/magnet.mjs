import { barEnd, observedAt, weekStart, wilderAtr } from './indicator-time.mjs';

export const resonancePeriods = {
  '15m': ['30m', '1h'], '30m': ['1h', '2h'], '1h': ['2h', '4h'], '2h': ['4h', '8h'],
  '4h': ['8h', '1d'], '8h': ['1d', '1w'], '1d': ['1w', '1mo'],
};
const slopeLengths = { '15m': 50, '30m': 20, '1h': 25, '2h': 25 };
const offsets = [0, 0.191, 0.382, 0.5, 0.618, 0.809, 1, 1.236];

function sideScore(distance, range) {
  const buffer = range * 0.05;
  if (distance <= buffer) return 0;
  let score = 1;
  for (const level of [0.382, 0.618, 1]) {
    if (distance < range * level - buffer) return score;
    if (distance <= range * level + buffer) return score + 1;
    score += 2;
  }
  return 7;
}

export function magnetPrices(bars) {
  let current;
  let previous;
  return bars.map(bar => {
    const start = weekStart(bar.time);
    if (current?.start !== start) {
      previous = current;
      current = { start, high: bar.high, low: bar.low, close: bar.close };
    } else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
    }
    if (!previous) return undefined;
    const center = (previous.high + previous.low + previous.close) / 3;
    const range = previous.high - previous.low;
    const score = sideScore(current.high - center, range) - sideScore(center - current.low, range);
    return { price: center + Math.sign(score) * range * offsets[Math.abs(score)], score };
  });
}

function ema(values, length) {
  const alpha = 2 / (length + 1);
  let last;
  return values.map(value => {
    if (value !== undefined) last = last === undefined ? value : last + (value - last) * alpha;
    return last;
  });
}

function weeklyTema(prices) {
  const first = ema(prices.map(point => point?.price), 200);
  const second = ema(first, 200);
  const third = ema(second, 200);
  return first.map((value, index) => value === undefined ? undefined : 3 * (value - second[index]) + third[index]);
}

function slopes(values, length) {
  const window = [];
  let sum = 0;
  return values.map((value, index) => {
    const previous = values[index - 1];
    if (index < length || value === undefined || !previous) return 0;
    const delta = (value - previous) / previous * 100;
    window.push(delta);
    sum += delta;
    if (window.length > length) sum -= window.shift();
    return window.length === length ? sum / length : 0;
  });
}

function higherSlopes(bars, interval, base, isMonthlyFallback) {
  const length = base === '2h' && interval === '8h' ? 50 : slopeLengths[interval] || 50;
  const closeEma = ema(bars.map(bar => bar.close), 100);
  const tema = isMonthlyFallback ? [] : weeklyTema(magnetPrices(bars));
  const magnetSlopes = slopes(tema, length);
  const fallbackSlopes = slopes(closeEma, length);
  return bars.map((bar, index) => ({
    available: barEnd(bar.time, interval),
    slope: tema[index] === undefined ? fallbackSlopes[index] : magnetSlopes[index],
  }));
}

function sampleMonthlyMagnet(bars, weekly, cutoff) {
  const prices = magnetPrices(weekly);
  let index = -1;
  return bars.map(bar => {
    const available = observedAt(bar.time, '1mo', cutoff);
    while (weekly[index + 1] && barEnd(weekly[index + 1].time, '1w') <= available) index++;
    return prices[index];
  });
}

export function magnetIndicator(bars, { interval, higherBars, cutoff }) {
  const periods = resonancePeriods[interval] || [];
  const enabled = periods.length > 0;
  const prices = interval === '1mo' ? sampleMonthlyMagnet(bars, higherBars?.['1w'] || [], cutoff) : magnetPrices(bars);
  const tema = weeklyTema(prices);
  const slopeValues = slopes(tema, slopeLengths[interval] || 50);
  const shield = enabled ? wilderAtr(bars, 14) : [];
  const references = periods.map(period => higherSlopes(
    higherBars?.[period] || [], period, interval, interval === '1d' && period === '1mo',
  ));
  const indexes = periods.map(() => -1);
  const magnet = [];
  const glow = [];
  const upper = [];
  const lower = [];
  let latest;
  for (const [index, { time }] of bars.entries()) {
    const value = tema[index];
    if (value === undefined) continue;
    const available = observedAt(time, interval, cutoff);
    const signs = references.map((series, i) => {
      while (series[indexes[i] + 1]?.available <= available) indexes[i]++;
      return Math.sign(series[indexes[i]]?.slope || 0);
    });
    const slope = slopeValues[index];
    const sign = Math.sign(slope);
    const resonance = sign && sign === signs[0] ? (sign === signs[1] ? 2 : 1) : 0;
    const color = resonance === 2 ? (sign > 0 ? '#76ff03' : '#ff1744') :
      resonance === 1 ? (sign > 0 ? '#00e5ff' : '#ff2975') : '#b39ddb';
    const rail = resonance === 2 && shield[index] !== undefined ? shield[index] * 0.618 : undefined;
    magnet.push({ time, value, color });
    glow.push(resonance ? { time, value, color: color + '66' } : { time });
    upper.push(rail === undefined ? { time } : { time, value: value + rail, color });
    lower.push(rail === undefined ? { time } : { time, value: value - rail, color });
    const strength = Math.abs(slope);
    latest = {
      score: prices[index].score, price: prices[index].price, resonance, slope,
      strength: strength >= 0.005 ? '健康' : strength >= 0.003 ? '渐弱' : strength >= 0.001 ? '谨慎' : '平缓',
    };
  }
  return { magnet, glow, upper, lower, latest };
}
