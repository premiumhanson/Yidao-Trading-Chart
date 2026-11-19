export const hour = 3600;
export const day = 24 * hour;
export const week = 7 * day;
export const seconds = {
  '1m': 60, '2m': 120, '3m': 180, '4m': 240, '5m': 300, '10m': 600,
  '15m': 900, '30m': 1800, '1h': hour, '2h': 2 * hour, '4h': 4 * hour,
  '8h': 8 * hour, '12h': 12 * hour, '1d': day, '1w': week, '1mo': 30.436875 * day,
};

export function monthIndex(time) {
  const date = new Date(time * 1000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

export function monthStart(time, months = 1) {
  const month = Math.floor(monthIndex(time) / months) * months;
  return Date.UTC(Math.floor(month / 12), month % 12, 1) / 1000;
}

export function weekStart(time) {
  return Math.floor((time - 4 * day) / week) * week + 4 * day;
}

export function barEnd(time, interval) {
  if (interval !== '1mo') return time + (seconds[interval] || hour);
  const following = monthIndex(time) + 1;
  return Date.UTC(Math.floor(following / 12), following % 12, 1) / 1000;
}

export function observedAt(time, interval, cutoff) {
  return Math.min(barEnd(time, interval), cutoff ?? Infinity);
}

export function rollBars(bars, interval) {
  const result = [];
  for (const bar of bars) {
    const time = Math.floor(bar.time / seconds[interval]) * seconds[interval];
    const current = result.at(-1);
    if (current?.time === time) {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
    } else {
      result.push({ ...bar, time });
    }
  }
  return result;
}

export function wilderAtr(bars, length) {
  let total = 0;
  let average;
  return bars.map((bar, index) => {
    const previous = bars[index - 1]?.close ?? bar.close;
    const range = Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
    if (index < length) {
      total += range;
      if (index + 1 === length) average = total / length;
    } else {
      average += (range - average) / length;
    }
    return average;
  });
}
