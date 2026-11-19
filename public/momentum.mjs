import { barEnd, day, seconds, wilderAtr } from './indicator-time.mjs';

export const momentumPeriods = ['15m', '30m', '1h', '2h'];
export const structurePeriods = ['15m', '30m', '1h', '2h', '4h'];
const radii = [5, 10, 15];
const bodyTop = bar => Math.max(bar.open, bar.close);
const bodyBottom = bar => Math.min(bar.open, bar.close);

function kineticSeries(bars, interval) {
  const bodies = [0];
  const ranges = [0];
  return bars.map((bar, index) => {
    bodies.push(bodies.at(-1) + Math.abs(bar.close - bar.open));
    ranges.push(ranges.at(-1) + bar.high - bar.low);
    const available = barEnd(bar.time, interval);
    const range = (ranges[index] - ranges[index - 30]) / 30;
    return {
      available,
      quiet: [3, 4].map(length => range > 0 && (bodies[index] - bodies[index - length]) / length / range < 0.33),
    };
  });
}

function pivot(values, center, radius, direction) {
  const price = values[center];
  for (let i = center - radius; i <= center + radius; i++) {
    if ((values[i] - price) * direction > 0 || (i > center && values[i] === price)) return false;
  }
  return true;
}

function makeCandidate(points, current, direction, tolerance, pulse, radius) {
  if (points.length < 2) return undefined;
  const [left, right] = points.slice(-2);
  const middle = (current.high + current.low) / 2;
  if ((left.price - right.price) * direction <= 0 || (right.price - middle) * direction <= 0) return undefined;
  const slope = (right.price - left.price) / (right.time - left.time);
  const endSlope = (middle - right.price) / (current.time - right.time);
  if (Math.abs(slope - endSlope) * (current.time - left.time) >= tolerance) return undefined;
  return { left, right, slope, direction, pulse, radius, key: `${left.time}:${right.time}` };
}

export function structureSignals(bars, { interval, higherBars, digits, cutoff }) {
  const duration = seconds[interval];
  const ticks = 10 ** -digits;
  const closed = cutoff === undefined ? bars : bars.filter(bar => barEnd(bar.time, interval) <= cutoff);
  const outcomes = [];
  const reversals = [];
  const candidates = new Map();
  const drawn = new Set();
  const groups = radii.map(radius => ({ radius, highs: [], lows: [] }));
  const upperBodies = closed.map(bodyTop);
  const lowerBodies = closed.map(bodyBottom);
  const atr = wilderAtr(closed, 14);
  const averages = [0];
  const maxAge = (interval === '4h' ? 180 : interval === '2h' ? 90 : interval === '1h' ? 60 : 30) * day;
  const sources = momentumPeriods.map(period => ({
    period,
    data: kineticSeries(period === interval ? closed : higherBars?.[period] || [], period),
    index: -1, quiet: [false, false],
  }));
  for (const [index, current] of closed.entries()) {
    averages.push(averages.at(-1) + current.high - current.low);
    const available = barEnd(current.time, interval);
    const previous = closed[index - 1];
    const pulses = [];
    for (const source of sources) {
      while (source.data[source.index + 1]?.available <= available) source.index++;
      const quiet = source.data[source.index]?.quiet || [false, false];
      for (let j = 0; j < quiet.length; j++) {
        if (quiet[j] && !source.quiet[j]) pulses.push({ period: source.period, length: j + 3 });
      }
      source.quiet = quiet;
    }
    const prevAtr = Math.max(atr[index - 1] ?? ticks, ticks);
    for (const group of groups) {
      const radius = group.radius;
      const center = index - radius;
      if (center < radius) continue;
      const anchor = closed[center];
      for (const [direction, points, values] of [[1, group.highs, upperBodies], [-1, group.lows, lowerBodies]]) {
        while (points.length && current.time - points[0].time > maxAge) points.shift();
        if (pivot(values, center, radius, direction)) points.push({ time: anchor.time, price: values[center] });
      }
    }
    for (const pulse of pulses) {
      for (const { radius, highs, lows } of groups) {
        for (const [direction, points] of [[1, highs], [-1, lows]]) {
          const candidate = makeCandidate(points, current, direction, 2 * prevAtr, pulse, radius);
          if (candidate && candidates.size < 200 && !candidates.has(candidate.key) && !drawn.has(candidate.key)) {
            candidates.set(candidate.key, candidate);
          }
        }
      }
    }
    if (!previous) continue;
    for (const [key, candidate] of [...candidates].reverse()) {
      const { left, slope, direction, pulse, radius, breakIndex } = candidate;
      const trendValue = left.price + slope * (previous.time - left.time);
      const body = direction === 1 ? lowerBodies[index - 1] : upperBodies[index - 1];
      const displacement = (body - trendValue) * direction;
      const buffer = 0.3 * prevAtr;
      if (breakIndex === undefined) {
        if (displacement > buffer) candidate.breakIndex = index;
      } else if (index - breakIndex > 10 || displacement < -buffer) {
        candidates.delete(key);
        continue;
      } else if (index > breakIndex + 2 && displacement <= buffer) {
        const meanRange = index >= 29 ? Math.max((averages[index + 1] - averages[index - 29]) / 30, ticks) : ticks;
        const perBar = Math.abs(slope) * duration;
        const extension = 20 * duration * (perBar > 1e-10 ? Math.min(Math.sqrt(meanRange / perBar), 200) : 200);
        const endAt = previous.time + Math.floor(extension);
        const color = direction === 1 ? '#49cf89' : '#ed5b5c';
        outcomes.push({ left, slope, endAt, color });
        reversals.push({
          time: previous.time, confirmedAt: current.time,
          position: direction === 1 ? 'belowBar' : 'aboveBar',
          shape: direction === 1 ? 'arrowUp' : 'arrowDown', color,
          text: `${direction === 1 ? '上破回踩' : '下破回踩'} P${radius} · ${pulse.period} CO${pulse.length}`,
        });
        drawn.add(key);
        if (drawn.size > 500) drawn.delete(drawn.values().next().value);
        candidates.delete(key);
        continue;
      }
      if (current.time - left.time > 14 * day) candidates.delete(key);
    }
  }
  const trends = outcomes.slice(-200).map(({ left, slope, endAt, color }) => {
    const to = bars.findLast(bar => bar.time <= endAt).time;
    return { from: left.time, to, fromPrice: left.price, toPrice: left.price + slope * (to - left.time), color };
  });
  return { reversals: reversals.slice(-100), trends };
}
