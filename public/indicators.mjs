const magnetPeriod = 200;
const swingWindows = [5, 10, 15];
const atrPeriod = 200;
const hour = 3600;
const day = 24 * hour;
const resolution = {
  '1m': 60, '2m': 120, '3m': 180, '4m': 240, '5m': 300, '10m': 600,
  '15m': 900, '30m': 1800, '1h': hour, '2h': 2 * hour, '4h': 4 * hour,
  '8h': 8 * hour, '12h': 12 * hour, '1d': day, '1w': 7 * day, '1mo': 30 * day,
};
const pivotStyles = [
  [0, 'P', '#d5d1ab'],
  [0.382, '0.382', '#fcec60'], [-0.382, '−0.382', '#4695a8'],
  [0.618, '0.618', '#f19d38'], [-0.618, '−0.618', '#3051ca'],
  [1, '1', '#dd484c'], [-1, '−1', '#508448'],
];
const fibRatios = [0.236, 0.5, 0.715, 0.786, 1.618, 2.618];

export function magnetLine(bars) {
  if (!bars.length) return [];
  const alpha = 2 / (magnetPeriod + 1);
  let first = bars[0].close;
  let second = first;
  let third = first;
  return bars.map(({ time, close }) => {
    first += alpha * (close - first);
    second += alpha * (first - second);
    third += alpha * (second - third);
    return { time, value: 3 * first - 3 * second + third };
  });
}

function monthIndex(time) {
  const date = new Date(time * 1000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

function firstOfMonth(time, months) {
  const first = Math.floor(monthIndex(time) / months) * months;
  return Date.UTC(Math.floor(first / 12), first % 12, 1) / 1000;
}

export function pivotAnchor(time, interval) {
  const seconds = resolution[interval] || hour;
  if (seconds < hour) return Math.floor(time / day) * day;
  if (seconds < 4 * hour) return Math.floor((time - 4 * day) / (7 * day)) * 7 * day + 4 * day;
  if (seconds < day) return firstOfMonth(time, 1);
  if (interval === '1d') return firstOfMonth(time, 3);
  if (interval === '1w') return firstOfMonth(time, 36);
  return firstOfMonth(time, 60);
}

function aggregateAnchors(bars, interval) {
  const groups = new Map();
  for (const bar of bars) {
    const anchor = pivotAnchor(bar.time, interval);
    const current = groups.get(anchor);
    if (current) {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.to = bar.time;
    } else {
      groups.set(anchor, { ...bar, anchor, from: bar.time, to: bar.time });
    }
  }
  return groups;
}

function levels({ high, low, close }, span, digits) {
  const center = (high + low + close) / 3;
  const range = high - low;
  if (!(range > 0)) return [];
  const major = pivotStyles.map(([ratio, name, color]) => {
    const price = center + ratio * range;
    return { ...span, price, label: `${name} (${price.toFixed(digits)})`, color, major: true };
  });
  const minor = fibRatios.map(ratio => ({
    ...span, price: high - ratio * range, label: String(ratio),
    color: 'rgba(164, 170, 174, .46)', major: false,
  }));
  return [...minor, ...major];
}

function pivotLines(bars, interval, digits, higherBars) {
  const chartGroups = [...aggregateAnchors(bars, interval).values()];
  const reference = interval === '1w' && higherBars?.['1mo']?.length ?
    // A monthly candle bounds its calendar year precisely. Exclude the incomplete current month.
    higherBars['1mo'].filter(bar => firstOfMonth(bar.time, 1) < firstOfMonth(bars.at(-1).time, 1)) :
    [];
  const exact = aggregateAnchors(reference, interval);
  const result = [];
  for (let i = 1; i < chartGroups.length; i++) {
    const current = chartGroups[i];
    const previous = chartGroups[i - 1];
    // The earliest displayed group can be truncated by the history window.
    // Use the alternate monthly history only when it covers the complete three calendar years.
    const full = exact.get(previous.anchor);
    const anchored = full && firstOfMonth(full.from, 1) === previous.anchor &&
      monthIndex(full.to) - monthIndex(full.from) === 35 ? full : previous;
    const active = i === chartGroups.length - 1;
    result.push(...levels(anchored, { from: current.from, to: current.to, active }, digits));
    if (active && i >= 2) {
      result.push(...levels(chartGroups[i - 2], { from: current.from, to: current.to, extension: true }, digits)
        .filter(line => line.major)
        .map(line => ({ ...line, label: '', color: line.color + '77' })));
    }
  }
  const current = chartGroups.at(-1);
  if (current) {
    result.push(...levels(current, { from: current.to, to: current.to, future: true }, digits)
      .filter(line => line.major));
  }
  return result;
}

function averageTrueRanges(bars) {
  let window = 0;
  return bars.map((bar, i) => {
    const previous = bars[i - 1]?.close ?? bar.close;
    const range = Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
    if (i < atrPeriod) {
      window += range;
      return window / (i + 1);
    }
    window += range - window / atrPeriod;
    return window / atrPeriod;
  });
}

function isSwing(bars, center, radius, isTop) {
  const field = isTop ? 'high' : 'low';
  const value = bars[center][field];
  for (let i = center - radius; i <= center + radius; i++) {
    if (i === center) continue;
    const other = bars[i][field];
    if ((isTop ? other > value : other < value) || (i < center && other === value)) return false;
  }
  return true;
}

function swingZones(bars, interval) {
  const zones = [];
  const reversals = [];
  const atr = averageTrueRanges(bars);
  const maxGap = interval === '1h' ? 240 : 80;
  for (let i = 0; i < bars.length; i++) {
    const current = bars[i];
    for (const zone of zones) {
      if (zone.broken) continue;
      zone.to = current.time;
      zone.broken = zone.direction === 'top' ? current.close > zone.high : current.close < zone.low;
    }
    const events = new Map();
    for (const radius of swingWindows) {
      const center = i - radius;
      if (center < radius) continue;
      for (const direction of ['top', 'bottom']) {
        if (!isSwing(bars, center, radius, direction === 'top')) continue;
        const key = `${center}:${direction}`;
        if (!events.has(key)) events.set(key, { center, direction, windows: [] });
        events.get(key).windows.push(radius);
      }
    }
    for (const { center, direction, windows } of events.values()) {
      const isTop = direction === 'top';
      const anchor = bars[center];
      const price = isTop ? anchor.high : anchor.low;
      const width = atr[center];
      if (!(width > 0)) continue;
      const zone = zones.findLast(candidate => !candidate.broken && candidate.direction === direction &&
        i - candidate.index <= maxGap && Math.abs(candidate.price - price) <= width * 1.5);
      const color = isTop ? '#ed5b5c' : '#49cf89';
      const next = zone || {
        from: current.time, to: current.time, direction, price, color, index: i,
        high: price + width * (isTop ? 1.5 : 1), low: price - width * (isTop ? 1 : 1.5),
        occurrences: new Set(), windows: new Set(), broken: false,
      };
      const before = next.occurrences.size;
      next.occurrences.add(anchor.time);
      for (const radius of windows) next.windows.add(radius);
      const side = isTop ? '顶' : '底';
      const count = next.occurrences.size;
      const label = { 1: side, 2: `双${side}`, 3: `三${side}` }[count] || `多${side}×${count}`;
      next.label = `${label} ${[...next.windows].sort((a, b) => a - b).map(n => `P${n}`).join('/')}`;
      if (!zone) {
        zones.push(next);
        if (zones.length > 100) zones.shift();
      }
      if (count < 2 || count === before) continue;
      reversals.push({
        time: current.time, position: isTop ? 'aboveBar' : 'belowBar',
        shape: isTop ? 'arrowDown' : 'arrowUp', color, text: next.label,
      });
    }
  }
  return {
    reversals: reversals.slice(-50),
    zones: zones.filter(zone => zone.occurrences.size >= 2).map(zone => ({
      from: zone.from, to: zone.to, low: zone.low, high: zone.high, direction: zone.direction,
      color: zone.color, label: zone.label, broken: zone.broken,
    })),
  };
}

function projectHigherZones(bars, source) {
  if (!source?.length) return [];
  const first = bars[0].time;
  const last = bars.at(-1).time;
  // The H4 bar must have closed before the revealed H1 candle closes.
  const fullyObserved = source.filter(bar => bar.time + 4 * hour <= last + hour);
  const times = bars.map(({ time }) => time);
  return swingZones(fullyObserved, '4h').zones.filter(zone => zone.to + 4 * hour >= first).map(zone => ({
    ...zone,
    from: times.find(time => time >= zone.from + 3 * hour),
    to: zone.broken ? times.findLast(time => time <= zone.to + 3 * hour) : last,
    label: `4H ${zone.label}`, higher: true,
  })).filter(zone => zone.from !== undefined && zone.to !== undefined && zone.from <= zone.to);
}

export function calculateIndicators(bars, {
  interval = '1h', higherBars, digits = 5, showReversals = true, showPivots = true, showMagnet = true,
} = {}) {
  if (!bars.length) return { reversals: [], zones: [], pivots: [], magnet: [] };
  const canDetect = showReversals && (interval === '1h' || interval === '4h');
  const structure = canDetect ? swingZones(bars, interval) : { reversals: [], zones: [] };
  if (canDetect && interval === '1h') structure.zones.unshift(...projectHigherZones(bars, higherBars?.['4h']));
  return {
    ...structure,
    pivots: showPivots ? pivotLines(bars, interval, digits, higherBars) : [],
    magnet: showMagnet ? magnetLine(bars) : [],
  };
}
