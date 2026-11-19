import { barEnd } from './indicator-time.mjs';

export const topBottomPeriods = ['1h', '4h'];
const lookbacks = [5, 10, 15];
const touchWindow = 3;
const maxZones = 100;
const momentumThreshold = 33;

// Pine rounds float operands to nine decimal places for comparisons.
function compare(left, right) {
  return Math.round(left * 1e9) - Math.round(right * 1e9);
}

function momentumActive(ratio) {
  return compare(ratio, momentumThreshold) < 0;
}

function momentumRatio(body, span, count) {
  const averageSpan = span / 30;
  if (count < 30 || compare(averageSpan, 0) === 0) return undefined;
  return 100 * (body / 3) / averageSpan;
}

function range(bars, from, to) {
  let high = -Infinity;
  let low = Infinity;
  for (let i = from; i <= to; i++) {
    high = Math.max(high, bars[i].high);
    low = Math.min(low, bars[i].low);
  }
  return { high, low };
}

function volatility(bars, tick) {
  let atr = 0;
  let body = 0;
  let span = 0;
  return bars.map((bar, i) => {
    const previous = bars[i - 1]?.close ?? bar.close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
    atr += (tr - atr) / Math.min(i + 1, 200);
    body += Math.abs(bar.close - bar.open);
    span += bar.high - bar.low;
    if (i >= 3) body -= Math.abs(bars[i - 3].close - bars[i - 3].open);
    if (i >= 30) span -= bars[i - 30].high - bars[i - 30].low;
    return { atr: Math.max(atr, tick), ratio: momentumRatio(body, span, i + 1) };
  });
}

function pattern(direction, count) {
  const name = (count === 2 ? '双' : count === 3 ? '三' : '多') + (direction === 1 ? '顶' : '底');
  return count >= 4 ? `${name}×${count}` : name;
}

function overlaps(zone, low, high) {
  return compare(high, zone.lower) >= 0 && compare(low, zone.upper) <= 0;
}
function extreme(direction, a, b) { return direction === 1 ? Math.max(a, b) : Math.min(a, b); }
function farAway(zone, low, high, atr) {
  return zone.direction === 1 ? compare(low, zone.lower - atr) <= 0 : compare(high, zone.upper + atr) >= 0;
}

function spawn(zones, bars, index, atr, period) {
  const anchor = index - period;
  const pivot = bars[anchor];
  const before = range(bars, anchor - period, anchor - 1);
  const after = range(bars, anchor + 1, index);
  for (const direction of [1, -1]) {
    const top = direction === 1;
    // Pine accepts equal extremes on the left and selects the rightmost tie.
    if (top ? pivot.high < before.high || pivot.high <= after.high
      : pivot.low > before.low || pivot.low >= after.low) continue;
    const value = top ? pivot.high : pivot.low;
    if (zones.some(zone => zone.direction === direction && zone.period === period && overlaps(zone, value, value))) continue;
    const upper = top ? value + 1.5 * atr : Math.min(pivot.open, pivot.close) + atr;
    const lower = top ? Math.max(pivot.open, pivot.close) - atr : value - 1.5 * atr;
    const stopRange = range(bars, anchor - 1, anchor + 1);
    const zone = {
      direction, period, upper, lower, anchor, time: pivot.time, value,
      lastTouch: anchor, count: 1, inEpisode: false, triggered: false,
      stopAnchor: value, thickness: stopRange.high - stopRange.low, stopLeft: anchor - 1,
      labels: [], lines: [],
    };
    zone.departed = farAway(zone, after.low, after.high, atr);
    zones.push(zone);
  }
}

function confirm(zone, bar, index, window, ratio, tick, matched) {
  const { direction } = zone;
  const bound = direction === 1 ? window.high : window.low;
  const endpoint = extreme(direction, zone.episodeExtreme, bound);
  const thickness = window.high - window.low;
  const farther = direction * compare(endpoint, zone.stopAnchor) > 0;
  const from = farther ? zone.stopLeft : index - 2;
  const shortStop = farther ? zone.stopAnchor + direction * zone.thickness : endpoint + direction * thickness;
  zone.lines.push({ from, to: from + 19, value: shortStop, endpoint: true });
  if (farther) {
    zone.stopAnchor = endpoint;
    zone.thickness = thickness;
    zone.stopLeft = index - 2;
  }
  const clamp = value => direction * compare(value, bar.close) > 0 ? value : bar.close + direction * tick;
  const stop = clamp(zone.stopAnchor + direction * zone.thickness);
  const labelStop = clamp(endpoint + direction * thickness);
  if (zone.stop === undefined || compare(zone.stop, stop) !== 0) {
    if (zone.stop !== undefined) zone.lines.push({ from: zone.stopFrom, to: index, value: zone.stop });
    zone.stop = stop;
    zone.stopFrom = index;
  }
  zone.triggered = true;
  zone.labelStop = labelStop;
  zone.name = `${pattern(direction, zone.count)} P${zone.period}`;
  zone.labels.push({
    at: index, value: direction === 1 ? bar.high : bar.low, direction, name: zone.name,
    count: zone.count, anchorValue: zone.value, lower: zone.lower, upper: zone.upper,
    ratio, labelStop, endpoint, thickness, stop, stopAnchor: zone.stopAnchor,
    stopThickness: zone.thickness, matched: matched && { lower: matched.lower, upper: matched.upper },
  });
}

function drawZone(zone, to) {
  return { from: zone.anchor, to, upper: zone.upper, lower: zone.lower, direction: zone.direction,
    name: zone.name, kind: zone.name ? 'confirmed' : 'candidate' };
}

function engine(bars, tick, gap, drawing, onSignal) {
  const metrics = volatility(bars, tick);
  const active = [];
  const boxes = [];
  const labels = [];
  const lines = [];
  function freeze(zone, index) {
    if (!drawing || !zone.name) return;
    boxes.push(drawZone(zone, index));
    labels.push(...zone.labels, { at: zone.anchor, value: zone.value, direction: zone.direction, mark: true });
    lines.push(...zone.lines, { from: zone.stopFrom, to: index, value: zone.stop });
  }
  function step(index, higher) {
    const bar = bars[index];
    const { atr, ratio } = metrics[index];
    for (const period of lookbacks) if (index > 2 * period) spawn(active, bars, index, atr, period);
    const window = drawing && momentumActive(ratio) ? range(bars, index - 2, index) : undefined;
    for (let i = active.length - 1; i >= 0; i--) {
      const zone = active[i];
      const top = zone.direction === 1;
      if (top ? compare(bar.close, zone.upper) > 0 : compare(bar.close, zone.lower) < 0) {
        active.splice(i, 1);
        continue;
      }
      if (index - zone.lastTouch > gap) {
        freeze(zone, index);
        active.splice(i, 1);
        continue;
      }
      const bound = top ? bar.high : bar.low;
      if (overlaps(zone, bar.low, bar.high)) {
        zone.lastTouch = index;
        if (zone.departed) {
          zone.departed = false;
          zone.inEpisode = true;
          zone.count++;
          zone.triggered = false;
          zone.episodeExtreme = bound;
        }
      } else if (farAway(zone, bar.low, bar.high, atr)) {
        zone.departed = true;
        zone.inEpisode = false;
      }
      if (!zone.inEpisode) continue;
      zone.episodeExtreme = extreme(zone.direction, zone.episodeExtreme, bound);
      if (!window || zone.triggered || index - zone.lastTouch >= touchWindow) continue;
      const matched = higher?.find(item => item.direction === zone.direction &&
        overlaps(item, Math.min(window.low, zone.episodeExtreme), Math.max(window.high, zone.episodeExtreme)));
      if (!higher || matched) {
        confirm(zone, bar, index, window, ratio, tick, matched);
        onSignal?.(bar, zone.labels.at(-1));
      }
    }
    while (active.length > maxZones) freeze(active.shift(), index);
    if (boxes.length > (drawing === '1h' ? 200 : 300)) boxes.shift();
    if (labels.length > 480) labels.splice(0, labels.length - 480);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  }
  return { step, active, boxes, labels, lines };
}

function firstAtOrAfter(bars, time) {
  let left = 0;
  let right = bars.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (bars[mid].time < time) left = mid + 1;
    else right = mid;
  }
  return left;
}

export function topBottomIndicator(bars, { interval, higherBars = {}, digits, cutoff, onSignal } = {}) {
  if (!topBottomPeriods.includes(interval) || !bars.length) return;
  const tick = 10 ** -(digits ?? 5);
  const closed = cutoff === undefined ? bars : bars.filter(bar => barEnd(bar.time, interval) <= cutoff);
  const higherInput = interval === '1h' ? higherBars['4h'] || [] : undefined;
  const higher = higherInput && engine(higherInput, tick, 100);
  let next = 0;
  function advanceHigher(time) {
    if (!higher) return;
    while (next < higherInput.length) {
      const end = Math.min(barEnd(higherInput[next].time, '4h'), higherInput[next + 1]?.time ?? Infinity);
      if (end > time) break;
      higher.step(next++);
    }
  }
  const chart = engine(closed, tick, interval === '1h' ? 300 : 100, interval, onSignal);
  for (let index = 0; index < closed.length; index++) {
    advanceHigher(barEnd(closed[index].time, interval));
    chart.step(index, higher?.active);
  }
  const partial = bars.length > closed.length ? bars.at(-1) : undefined;
  const projected = higher?.active.map(zone => ({
    from: firstAtOrAfter(bars, zone.time), upper: zone.upper, lower: zone.lower, direction: zone.direction,
    kind: 'higher', name: `4H ${zone.direction === 1 ? '顶区' : '底区'} P${zone.period}` +
      (zone.count >= 2 ? ` ×${zone.count}` : ''),
  })) || [];
  return { bars: closed, partial, projected, filtered: Boolean(higher),
    active: chart.active, boxes: chart.boxes, labels: chart.labels, lines: chart.lines };
}

export function topBottomAlerts(bars, { after, ...options }) {
  const events = new Map();
  topBottomIndicator(bars, {
    ...options,
    onSignal(bar, label) {
      if (bar.time <= after) return;
      const key = `${bar.time}:${label.direction}`;
      const signal = events.get(key) ?? {
        interval: options.interval, barTime: bar.time, direction: label.direction,
        price: bar.close, digits: options.digits ?? 5, matches: new Set(),
      };
      // The same-direction winner follows the Pine engine's reverse zone traversal.
      signal.pattern = pattern(label.direction, label.count);
      signal.matches.add(label.name);
      events.set(key, signal);
    },
  });
  return [...events.values()].map(signal => ({ ...signal, matches: [...signal.matches] }));
}

export function entryWindows(result, preview) {
  if (!result) return [];
  const { bars, partial, active, projected } = result;
  const live = preview?.time > (bars.at(-1)?.time ?? 0) ? preview : partial;
  const bar = live || bars.at(-1);
  if (!bar) return [];
  const index = live ? bars.length : bars.length - 1;
  const recent = bars.slice(-30);
  if (live) {
    if (recent.length === 30) recent.shift();
    recent.push(live);
  }
  const lastThree = recent.slice(-3);
  const window = range(lastThree, 0, lastThree.length - 1);
  const span = recent.reduce((sum, item) => sum + item.high - item.low, 0);
  const body = lastThree.reduce((sum, item) => sum + Math.abs(item.close - item.open), 0);
  const ratio = momentumRatio(body, span, recent.length);
  const windows = [];
  for (const zone of active) {
    const touching = overlaps(zone, bar.low, bar.high);
    const arrival = zone.departed && touching;
    const episode = zone.inEpisode && (touching || index - zone.lastTouch < touchWindow);
    if (!arrival && !episode) continue;
    if (result.filtered && !projected.some(item => item.direction === zone.direction &&
      overlaps(item, Math.min(bar.low, zone.episodeExtreme ?? bar.low), Math.max(bar.high, zone.episodeExtreme ?? bar.high)))) continue;
    const { direction } = zone;
    const locked = episode && zone.triggered;
    const bound = direction === 1 ? window.high : window.low;
    const endpoint = zone.inEpisode ? extreme(direction, zone.episodeExtreme, bound) : bound;
    const estimated = endpoint + direction * (window.high - window.low);
    const stop = direction * compare(endpoint, zone.stopAnchor) > 0 ? estimated : zone.stopAnchor + direction * zone.thickness;
    windows.push({
      direction, period: zone.period, name: pattern(direction, Math.max(2, zone.count + Number(arrival))),
      lower: zone.lower, upper: zone.upper, ratio, momentumActive: momentumActive(ratio), locked,
      stop: locked ? zone.stop : stop, labelStop: locked ? zone.labelStop : estimated,
    });
    if (windows.length === 5) break;
  }
  return windows;
}

export function topBottomDrawings(result) {
  if (!result) return { boxes: [], labels: [], lines: [] };
  const boxes = [...result.projected, ...result.boxes];
  const labels = [...result.labels];
  const lines = [...result.lines];
  for (const zone of result.active) {
    boxes.push(drawZone(zone));
    if (!zone.name) continue;
    labels.push(...zone.labels, { at: zone.anchor, value: zone.value, direction: zone.direction, mark: true });
    lines.push(...zone.lines, { from: zone.stopFrom, value: zone.stop });
  }
  return { boxes, labels: labels.slice(-500), lines: lines.slice(-500) };
}
