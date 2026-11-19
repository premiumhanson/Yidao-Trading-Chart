import { CandlestickSeries, CrosshairMode, LineSeries, PriceScaleMode, createChart } from '/charts.mjs';
import { calculateIndicators, indicatorContexts } from '/indicators.mjs';
import { barEnd, hour, rollBars } from '/indicator-time.mjs';
import { topBottomIndicator, topBottomPeriods } from '/top-bottom.mjs';
import { attachTopBottomView } from '/top-bottom-view.mjs';
import { installAlerts } from '/alerts-view.mjs';

const $ = id => document.getElementById(id);
const elements = {
  charts: $('charts'), source: $('source'), periods: $('intervals'), symbols: $('symbols'),
  search: $('symbol-search'), notice: $('chart-notice'), connection: $('connection-status'),
};
const periods = {
  '1m': '1分', '2m': '2分', '3m': '3分', '4m': '4分', '5m': '5分',
  '10m': '10分', '15m': '15分', '30m': '30分', '1h': '1H', '2h': '2H',
  '4h': '4H', '8h': '8H', '12h': '12H', '1d': '日', '1w': '周', '1mo': '月',
};
const commonPeriods = ['1h', '4h', '1d', '1w', '1mo'];
const categoryNames = { MAJOR: '主要货币对', CROSS: '交叉货币对', EXOTIC: '其他货币对', METAL: '贵金属', INDEX: '指数', ENERGY: '能源' };
const categoryOrder = ['MAJOR', 'METAL', 'INDEX', 'ENERGY', 'CROSS', 'EXOTIC', 'BROKER'];
const ohlcKeys = [['O', 'open'], ['H', 'high'], ['L', 'low'], ['C', 'close']];
const defaultSource = 'ctrader-local';
const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const localTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
const quoteTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', timeStyle: 'medium' });
const state = {
  source: defaultSource, sourceInfo: {}, catalog: [], symbol: null, favoritesOnly: false,
  activePane: 'main', split: true, replay: null, playing: false, stepping: false,
  drawingTool: 'cursor', drawingStart: null, sma: false, revision: 0, sourceRevision: 0,
  busy: false, crosshair: null, liveStream: null, streamKey: null,
  liveBars: new Map(), previews: new Map(), contextSources: {}, archiveJob: null,
  pendingSymbol: null, chartCache: new Map(),
};
const liveSource = () => state.source !== 'offline';

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { elements.notice.textContent = '浏览器未能保存本次更改。'; }
}
const favorites = new Set(readStorage('kunhou.favorites', []));
const drawings = readStorage('kunhou.drawings', []);
const backtests = readStorage('kunhou.backtests', []);
const indicatorToggles = { reversal: true, pivots: true, magnet: true, ...readStorage('yidao.indicators', {}) };

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function writeText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
function displayTime(time) { return localTime.format(new Date(time * 1000)); }
function displayDate(time) { return localDate.format(new Date(time * 1000)); }
function price(value, digits) { return Number.isFinite(value) ? value.toFixed(digits ?? 5) : '—'; }
function percent(value) { return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`; }
function press(node, active) { node.setAttribute('aria-pressed', String(active)); }
function displayError(message = '') {
  $('workspace-error').hidden = !message;
  $('error-message').textContent = message;
  $('offline-button').hidden = state.source === 'offline';
}
async function api(path, parameters = {}, source = state.source, signal) {
  const query = new URLSearchParams({ source });
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null) query.set(key, value);
  }
  const response = await fetch(`/api/${path}?${query}`, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法读取行情。');
  return data;
}

function chartPane(id, interval, name) {
  const root = element('section', 'chart-pane');
  root.dataset.pane = id;
  root.setAttribute('aria-label', name);
  const top = element('div', 'pane-top');
  const select = element('select');
  select.setAttribute('aria-label', `${name}周期`);
  const ohlc = element('span', 'pane-ohlc');
  const ohlcValues = ohlcKeys.map(([label]) => {
    const field = element('span', '', label + ' ');
    const value = element('b', '', '—');
    field.append(value);
    ohlc.append(field);
    return value;
  });
  const magneticStatus = element('span', 'magnet-status');
  magneticStatus.hidden = true;
  const expand = element('button', '', '⤢');
  expand.title = '切换单图';
  expand.setAttribute('aria-label', `展开${name}`);
  const latest = element('button', 'pane-latest', '回到最新');
  latest.hidden = true;
  const widget = element('div', 'chart-widget');
  const placeholder = element('div', 'chart-placeholder');
  const reason = element('span');
  const changeFeed = element('button', '', '切换到 cTrader 本地');
  changeFeed.addEventListener('click', () => changeSource('ctrader-local'));
  placeholder.append(reason, changeFeed);
  placeholder.hidden = true;
  top.append(select, ohlc, magneticStatus, latest, expand);
  root.append(top, widget);
  elements.charts.append(root);
  const chart = createChart(widget, {
    autoSize: true,
    layout: {
      background: { color: '#0b110e' }, textColor: '#99ad9f',
      fontFamily: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 10,
      attributionLogo: id === 'main',
    },
    grid: { vertLines: { color: '#18251c' }, horzLines: { color: '#19271e' } },
    rightPriceScale: {
      borderColor: '#243329', mode: PriceScaleMode.Logarithmic, minimumWidth: 59,
      scaleMargins: { top: 0.11, bottom: 0.10 },
    },
    timeScale: {
      borderColor: '#243329', timeVisible: true, secondsVisible: false, rightBarStaysOnScroll: true,
      minBarSpacing: 1, tickMarkFormatter: (time, type) => {
        const date = displayDate(time);
        if (type === 0) return date.slice(0, 4);
        if (type === 1) return date.slice(0, 7);
        if (type === 2) return date.slice(5);
        return displayTime(time).slice(-5);
      },
    },
    localization: { timeFormatter: displayTime },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#648572', labelBackgroundColor: '#345140' },
      horzLine: { color: '#648572', labelBackgroundColor: '#345140' },
    },
  });
  const series = chart.addSeries(CandlestickSeries, {
    upColor: '#47d779', downColor: '#f36870', borderVisible: false,
    wickUpColor: '#4ad37b', wickDownColor: '#ed646d',
    autoscaleInfoProvider: stableLiveScale,
  });
  const sma = chart.addSeries(LineSeries, {
    color: '#dfbc65', lineWidth: 1, lastValueVisible: false, priceLineVisible: false,
    crosshairMarkerVisible: false, visible: false,
  });
  const magnetOptions = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null };
  const magnetGlow = chart.addSeries(LineSeries, { ...magnetOptions, lineWidth: 4 });
  const magnet = chart.addSeries(LineSeries, { ...magnetOptions, color: '#b39ddb', lineWidth: 2 });
  const magnetUpper = chart.addSeries(LineSeries, { ...magnetOptions, lineWidth: 1 });
  const magnetLower = chart.addSeries(LineSeries, { ...magnetOptions, lineWidth: 1 });
  const pane = {
    id, root, select, ohlc, ohlcValues, chart, series, sma, magnet, magnetGlow, magnetUpper, magnetLower,
    magneticStatus, interval, bars: [], digits: 5,
    widget, overlays: [], hasMore: false, paging: false, dataKey: null,
    placeholder, reason, changeFeed,
  };
  widget.append(placeholder);
  pane.latestView = attachLatestViewport(pane, latest);
  pane.indicatorOverlay = attachIndicatorOverlay(pane);
  pane.topBottomView = attachTopBottomView(pane);
  pane.ohlc.addEventListener('click', () => setActive(pane));
  select.addEventListener('change', () => changeInterval(pane, select.value));
  expand.addEventListener('click', () => {
    setActive(pane);
    state.split = !state.split;
    updateLayout();
    refreshCharts();
  });
  chart.subscribeClick(param => chartClick(pane, param));
  chart.subscribeCrosshairMove(param => syncCrosshair(pane, param));
  for (const type of ['pointerleave', 'pointercancel']) {
    widget.addEventListener(type, () => {
      if (state.crosshair?.pane === pane) clearCrosshair();
    });
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (state.crosshair && state.crosshair.pane !== pane) renderCrosshair(pane);
    if (range && range.from < 16 && range.to < pane.bars.length - 10) pageHistory(pane);
  });
  return pane;
}

function attachLatestViewport(pane, button) {
  const scale = pane.chart.timeScale();
  let following = true;
  let drag;
  let scheduled = false;

  function keepOffset() {
    if (!following || scheduled || !pane.bars.length) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!following || scale.width() <= 0 || !pane.bars.length) return;
      const spacing = scale.options().barSpacing;
      const target = Math.ceil(pane.widget.clientWidth / 6) / spacing;
      if (Math.abs(scale.scrollPosition() - target) * spacing > 0.25) scale.scrollToPosition(target, false);
    });
  }

  function align(initial = false) {
    const width = scale.width();
    if (!following || width <= 0 || !pane.bars.length) return;
    const rightOffsetPixels = Math.ceil(pane.widget.clientWidth / 6);
    const options = {};
    if (rightOffsetPixels !== scale.options().rightOffsetPixels) options.rightOffsetPixels = rightOffsetPixels;
    if (initial) {
      const count = Math.min(pane.bars.length, pane.id === 'main' ? 165 : 105);
      options.barSpacing = Math.max(1, (width - rightOffsetPixels) / count);
    }
    if (Object.keys(options).length) scale.applyOptions(options);
    keepOffset();
  }

  function follow(enabled) {
    following = enabled;
    button.hidden = enabled || !pane.bars.length;
  }

  button.addEventListener('click', () => {
    follow(true);
    align();
  });
  pane.widget.addEventListener('pointerdown', event => {
    drag = event.isPrimary && event.button === 0 ? { id: event.pointerId, x: event.clientX } : undefined;
  }, { passive: true });
  pane.widget.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId || (event.pointerType !== 'touch' && !(event.buttons & 1))) return;
    if (Math.abs(event.clientX - drag.x) > 8) {
      follow(false);
      drag = undefined;
    }
  }, { passive: true });
  for (const type of ['pointerup', 'pointercancel']) {
    pane.widget.addEventListener(type, () => { drag = undefined; }, { passive: true });
  }
  pane.widget.addEventListener('wheel', event => {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) follow(false);
  }, { passive: true });
  scale.subscribeSizeChange(() => align());
  scale.subscribeVisibleLogicalRangeChange(keepOffset);
  return {
    align,
    reset() { follow(true); align(true); },
    fit() { follow(true); align(); scale.fitContent(); },
  };
}

const panes = [
  chartPane('upper', '1h', '左上图'), chartPane('intraday', '15m', '右上图'),
  chartPane('lower', '4h', '左下图'), chartPane('main', '1w', '右下图'),
];
const activePane = () => panes.find(pane => pane.id === state.activePane);
const visiblePanes = () => state.split ? panes : [activePane()];
const supportedPeriods = () => state.sourceInfo.intervals || commonPeriods;
const supportsPane = pane => supportedPeriods().includes(pane.interval);
const toolbarPeriods = () => state.source === 'offline' ? commonPeriods :
  ['1m', '5m', '15m', '30m', ...commonPeriods].filter(value => supportedPeriods().includes(value));

function updateLayout() {
  press($('grid-toggle'), state.split);
  elements.charts.classList.toggle('solo', !state.split);
  for (const pane of panes) {
    pane.root.hidden = !state.split && pane !== activePane();
    pane.root.classList.toggle('active', pane === activePane());
  }
  if (state.crosshair?.pane.root.hidden) clearCrosshair();
}
function renderPeriods() {
  elements.periods.replaceChildren();
  for (const interval of toolbarPeriods()) {
    const button = element('button', '', periods[interval]);
    press(button, activePane().interval === interval);
    button.addEventListener('click', () => changeInterval(activePane(), interval));
    elements.periods.append(button);
  }
  for (const pane of panes) {
    const options = pane.id === 'intraday' && !supportedPeriods().includes('15m') ?
      ['15m', ...supportedPeriods()] : supportedPeriods();
    pane.select.replaceChildren(...options.map(value => new Option(periods[value] || value, value)));
    pane.select.value = pane.interval;
    updatePlaceholder(pane);
  }
}
function updatePlaceholder(pane) {
  const missing15m = state.source === 'offline' && pane.interval === '15m';
  pane.placeholder.hidden = !missing15m;
  pane.reason.textContent = missing15m ? '本地库最低为 1H。15 分钟图需要 M15 行情。' : '';
  pane.changeFeed.hidden = !missing15m;
}
function setActive(pane) {
  if (state.activePane === pane.id) return;
  state.activePane = pane.id;
  updateLayout();
  renderPeriods();
}
function changeInterval(pane, interval) {
  clearCrosshair();
  setActive(pane);
  pane.interval = interval;
  pane.dataKey = null;
  renderPeriods();
  refreshCharts();
}

function renderOHLC(pane, bar = pane.appliedPreview || pane.bars.at(-1)) {
  for (const [index, [, key]] of ohlcKeys.entries()) {
    writeText(pane.ohlcValues[index], price(bar?.[key], pane.digits));
  }
  const status = bar?.time === pane.appliedPreview?.time ? ' · 未收盘' : '';
  const title = bar?.time ? `${displayTime(bar.time)} UTC+8${status}` : '';
  if (pane.ohlc.title !== title) pane.ohlc.title = title;
}
function stableLiveScale(original) {
  const result = original();
  const range = result?.priceRange;
  if (state.source !== 'ctrader-local' || !range) return result;
  const span = range.maxValue - range.minValue;
  if (!(span > 0)) return result;
  const step = 10 ** Math.floor(Math.log10(span * 0.04));
  return { ...result, priceRange: {
    minValue: Math.floor(range.minValue / step) * step,
    maxValue: Math.ceil(range.maxValue / step) * step,
  } };
}
function sameCandle(a, b) {
  return a === b || Boolean(a && b && a.time === b.time && a.open === b.open &&
    a.high === b.high && a.low === b.low && a.close === b.close);
}
function sameCandles(a, b) {
  return a === b || (a?.length === b.length && b.every((bar, i) => sameCandle(a[i], bar)));
}
function movingAverage(bars) {
  let sum = 0;
  const points = [];
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= 20) sum -= bars[i - 20].close;
    if (i >= 19) points.push({ time: bars[i].time, value: sum / 20 });
  }
  return points;
}
function displayMovingAverage(pane) {
  pane.sma.applyOptions({ visible: state.sma });
  if (state.sma) pane.sma.setData(movingAverage(pane.bars));
}
function attachIndicatorOverlay(pane) {
  let update;
  let data = [];
  const renderer = {
    draw(target) {
      target.useMediaCoordinateSpace(({ context, mediaSize }) => {
        const { width, height } = mediaSize;
        const scale = pane.chart.timeScale();
        context.save();
        context.font = '10px "Microsoft YaHei UI", monospace';
        context.textBaseline = 'bottom';
        for (const annotation of data) {
          const x0 = scale.timeToCoordinate(annotation.from);
          const x1 = annotation.future ? width : scale.timeToCoordinate(annotation.to);
          if (x0 === null || x1 === null || x1 < 0 || x0 > width) continue;
          const left = Math.max(0, x0);
          const right = Math.min(width, x1);
          const color = annotation.color || '#ddca99';
          if (annotation.fromPrice !== undefined) {
            const start = pane.series.priceToCoordinate(annotation.fromPrice);
            const end = pane.series.priceToCoordinate(annotation.toPrice);
            if (start === null || end === null) continue;
            context.globalAlpha = 0.57;
            context.strokeStyle = color;
            context.lineWidth = 1.4;
            context.beginPath();
            context.moveTo(x0, start);
            context.lineTo(x1, end);
            context.stroke();
          } else {
            const y = pane.series.priceToCoordinate(annotation.price);
            if (y === null || y < 0 || y > height) continue;
            const isCentral = annotation.label?.startsWith('P ');
            context.globalAlpha = isCentral ? 0.92 : annotation.major ? 0.76 : 0.58;
            context.strokeStyle = color;
            context.lineWidth = isCentral ? 1.6 : annotation.major ? 1.2 : 0.8;
            context.beginPath();
            context.moveTo(left, y);
            context.lineTo(Math.max(left + 1, right), y);
            context.stroke();
            if (annotation.label && right - left > 24) {
              context.fillStyle = color;
              const label = annotation.label;
              const labelWidth = context.measureText(label).width;
              if (right - left > labelWidth + 6) context.fillText(label, right - labelWidth - 3, y - 2);
            }
          }
        }
        context.restore();
      });
    },
  };
  const views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
  pane.series.attachPrimitive({
    attached({ requestUpdate }) { update = requestUpdate; },
    detached() { update = undefined; },
    paneViews() { return views; },
  });
  return annotations => { data = annotations; update?.(); };
}
function renderIndicators(pane) {
  const options = {
    interval: pane.interval, higherBars: state.contextBars, digits: pane.digits,
    cutoff: state.replay === null ? undefined : state.replay + hour,
  };
  const result = calculateIndicators(pane.bars, {
    ...options, showPivots: indicatorToggles.pivots, showMagnet: indicatorToggles.magnet,
  });
  const cutoff = options.cutoff ?? (state.source === 'offline' && Number.isFinite(state.latestObserved)
    ? state.latestObserved + hour : undefined);
  pane.topBottom = indicatorToggles.reversal ? topBottomIndicator(pane.bars, { ...options, cutoff }) : undefined;
  pane.topBottomView.set(pane.topBottom);
  pane.magnet.setData(result.magnet);
  pane.magnetGlow.setData(result.glow);
  pane.magnetUpper.setData(result.upper);
  pane.magnetLower.setData(result.lower);
  pane.indicatorOverlay(result.pivots);
  pane.magneticStatus.hidden = !result.latest;
  if (result.latest) {
    const { score, price: magneticPrice, strength, slope, resonance } = result.latest;
    pane.magneticStatus.textContent = `磁力 ${score > 0 ? '+' : ''}${score}${resonance ? ' · 共振' + resonance : ''}`;
    pane.magneticStatus.title = `磁力价 ${price(magneticPrice, pane.digits)} · 斜率 ${slope.toFixed(3)}% ${strength}`;
  }
}
function applyBars(pane, data, { reset = false } = {}) {
  const digits = data.digits ?? 5;
  pane.hasMore = data.hasMore;
  if (!reset && digits === pane.digits && sameCandles(pane.bars, data.bars)) return false;
  if (digits !== pane.digits || reset) {
    pane.digits = digits;
    pane.series.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } });
  }
  pane.bars = data.bars;
  pane.series.setData(pane.bars);
  pane.appliedPreview = undefined;
  displayPreview(pane);
  displayMovingAverage(pane);
  renderDrawings(pane);
  if (reset) pane.latestView.reset();
  else pane.latestView.align();
  renderCrosshair(pane);
  return true;
}
function renderInstrument(bars, digits) {
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const change = last && prev?.close ? (last.close / prev.close - 1) * 100 : null;
  writeText($('last-close'), price(last?.close, digits));
  writeText($('last-change'), change === null ? '' : percent(change));
  $('last-change').className = change === null ? '' : change >= 0 ? 'up' : 'down';
}
function clearChartData() {
  state.revision++;
  state.refreshController?.abort();
  state.refreshController = undefined;
  state.pendingSymbol = null;
  state.busy = false;
  clearCrosshair();
  state.contextSources = {};
  state.contextBars = {};
  state.latestObserved = undefined;
  for (const pane of panes) {
    pane.dataKey = null;
    applyBars(pane, { bars: [], digits: 5, hasMore: false }, { reset: true });
    renderIndicators(pane);
  }
  renderInstrument([], 5);
}
function candleKey(pane) { return `${state.source}:${state.symbol?.id}:${pane.interval}`; }
function barParameters({ interval }, before = state.replay === null ? undefined : state.replay + 1, symbol = state.symbol) {
  const deepHistory = ['15m', '30m'].includes(interval) || (indicatorToggles.reversal && topBottomPeriods.includes(interval));
  return { symbol: symbol.id, interval, limit: deepHistory ? 1000 : 500, before };
}
function mergeBars(first, second) {
  return [...new Map([...first, ...second].map(bar => [bar.time, bar])).values()].sort((a, b) => a.time - b.time);
}
const aggregatedFeeds = { '2h': '1h', '8h': '4h' };
function contextPlan(chartPanes) {
  const requested = new Set(chartPanes.flatMap(pane => [...indicatorContexts(pane.interval, {
    reversal: indicatorToggles.reversal, magnet: indicatorToggles.magnet,
  })]));
  const plan = new Map();
  for (const period of requested) {
    const source = supportedPeriods().includes(period) ? period : aggregatedFeeds[period];
    if (supportedPeriods().includes(source)) plan.set(period, source);
  }
  return plan;
}
function rebuildContext() {
  const available = visiblePanes().filter(supportsPane);
  const raw = { ...state.contextSources };
  for (const pane of available) {
    if (pane.dataKey === candleKey(pane)) raw[pane.interval] = mergeBars(raw[pane.interval] || [], pane.bars);
  }
  const previous = state.contextBars || {};
  const next = { ...raw };
  for (const [period, source] of contextPlan(available)) {
    if (period !== source && raw[source]?.length) next[period] = rollBars(raw[source], period);
  }
  state.contextBars = next;
  return Object.keys(previous).length !== Object.keys(next).length ||
    Object.entries(next).some(([interval, bars]) => !sameCandles(previous[interval], bars));
}
async function requestContexts(plan, load, signal) {
  const intervals = [...new Set(plan.values())];
  const read = async interval => {
    try {
      return [interval, (await load(interval)).bars];
    } catch {
      // An unavailable auxiliary period still leaves the main chart usable.
      return [interval, []];
    }
  };
  if (state.source !== 'ctrader-local' || !signal) return Promise.all(intervals.map(read));
  // Give symbol clicks priority over auxiliary reads on the cBot's single execution thread.
  const pairs = [];
  for (const interval of intervals) {
    signal.throwIfAborted();
    pairs.push(await read(interval));
  }
  return pairs;
}
function rememberChartSnapshot() {
  if (!liveSource() || !state.symbol) return;
  const history = new Map();
  for (const pane of panes) {
    if (pane.dataKey !== candleKey(pane) || !pane.bars.length) continue;
    const { limit } = barParameters(pane);
    history.set(pane.interval, {
      bars: pane.bars.slice(-limit), digits: pane.digits, hasMore: pane.hasMore || pane.bars.length > limit,
    });
  }
  if (!history.size) return;
  const contexts = Object.fromEntries(Object.entries(state.contextSources).map(([interval, bars]) =>
    [interval, bars.slice(-1000)]));
  state.chartCache.delete(state.symbol.id);
  state.chartCache.set(state.symbol.id, { history, contexts, savedAt: Date.now() });
  while (state.chartCache.size > 12) state.chartCache.delete(state.chartCache.keys().next().value);
}

function showChartSnapshot(item, byInterval, primary, { keepHistory, contexts = {} } = {}) {
  const switching = state.pendingSymbol === item;
  if (switching) {
    rememberChartSnapshot();
    stopMarketStream();
    selectInstrument(item);
    state.pendingSymbol = null;
    clearCrosshair();
    state.contextSources = contexts;
    state.contextBars = {};
    setDrawingTool('cursor');
  }
  const changed = [];
  for (const pane of panes) {
    if (pane.root.hidden && !switching) continue;
    const key = candleKey(pane);
    const result = byInterval.get(pane.interval);
    if (!result) {
      if ((!supportsPane(pane) || switching) && pane.bars.length) {
        pane.dataKey = null;
        applyBars(pane, { bars: [], digits: 5, hasMore: false });
        changed.push(pane);
      }
      continue;
    }
    const data = { ...result };
    const reset = pane.dataKey !== key || !pane.bars.length;
    if (keepHistory && !reset) {
      if (pane.bars[0].time < (data.bars[0]?.time ?? Infinity)) data.hasMore = pane.hasMore;
      data.bars = mergeBars(pane.bars, data.bars);
    }
    const pushed = state.liveBars.get(pane.interval);
    if (pushed?.length) data.bars = mergeBars(data.bars, pushed);
    pane.dataKey = key;
    if (applyBars(pane, data, { reset })) changed.push(pane);
  }
  const quotePeriod = byInterval.get(primary)?.bars.length ? primary :
    [...byInterval].find(([, result]) => result.bars.length)?.[0] ?? primary;
  const quote = byInterval.get(quotePeriod);
  const last = quote?.bars.at(-1);
  const observedChanged = state.latestObserved !== last?.time;
  state.latestObserved = last?.time;
  const contextChanged = rebuildContext();
  for (const pane of panes) {
    if (changed.includes(pane) || ((contextChanged || (state.source === 'offline' && observedChanged)) &&
      !pane.root.hidden && supportsPane(pane))) renderIndicators(pane);
  }
  renderInstrument(quote?.bars ?? [], quote?.digits);
  elements.notice.textContent = state.replay !== null
    ? `历史回放 · ${displayTime(state.replay)}`
    : last ? `最后一根 ${periods[quotePeriod]} · ${displayTime(last.time)}` : '当前区间暂无 K 线';
  displayError();
  updateMarketStream();
}

async function refreshCharts({ quiet = false } = {}) {
  const item = state.pendingSymbol ?? state.symbol;
  if (!item) return;
  const revision = ++state.revision;
  state.refreshController?.abort();
  const controller = new AbortController();
  state.refreshController = controller;
  const chartPanes = visiblePanes().filter(supportsPane);
  const primary = state.source === 'offline' || chartPanes.some(pane => pane.interval === '1h') ? '1h' : activePane().interval;
  const intervals = [...new Set([...chartPanes.map(pane => pane.interval), primary])];
  const source = state.source;
  const getBars = interval => api('bars', barParameters({ interval }, undefined, item), source, controller.signal);
  const switching = state.pendingSymbol === item;
  const firstLiveLoad = switching && !state.symbol && liveSource();
  const cached = switching && state.chartCache.get(item.id);
  const useCache = cached && Date.now() - cached.savedAt < 5 * 60_000 &&
    intervals.every(interval => cached.history.has(interval));
  if (switching && state.symbol && !useCache) elements.notice.textContent = `正在切换至 ${item.name}…`;
  else if (!quiet && !useCache) elements.notice.textContent = '正在载入 K 线…';
  state.busy = true;
  try {
    if (useCache) showChartSnapshot(item, cached.history, primary, { contexts: cached.contexts });
    const byInterval = new Map();
    const failures = new Map();
    await Promise.all(intervals.map(async interval => {
      try {
        byInterval.set(interval, await getBars(interval));
      } catch (error) {
        failures.set(interval, error);
        return;
      }
      if (firstLiveLoad && revision === state.revision && byInterval.get(interval).bars.length) {
        showChartSnapshot(item, byInterval, primary);
        const loading = intervals.filter(period => !byInterval.has(period) && !failures.has(period));
        if (loading.length) elements.notice.textContent = `正在载入 ${loading.map(period => periods[period]).join('、')} K 线…`;
      }
    }));
    if (revision !== state.revision) return;
    if (!byInterval.size) throw failures.values().next().value;
    showChartSnapshot(item, byInterval, primary, { keepHistory: quiet || useCache });
    if (failures.size) {
      const failed = intervals.filter(interval => failures.has(interval)).map(interval => periods[interval]);
      elements.notice.textContent = `${failed.join('、')} K 线暂未载入 · ${failures.values().next().value.message}`;
    }
    const plan = contextPlan(chartPanes);
    for (const [period, from] of plan) if (byInterval.has(from)) plan.delete(period);
    if (plan.size && switching && source === 'ctrader-local') {
      await new Promise(resolve => setTimeout(resolve, 750));
      if (revision !== state.revision) return;
    }
    const pairs = await requestContexts(plan, getBars, controller.signal);
    if (revision !== state.revision) return;
    for (const [interval, bars] of pairs) {
      state.contextSources[interval] = mergeBars(state.contextSources[interval] || [], bars);
    }
    if (rebuildContext()) for (const pane of chartPanes) renderIndicators(pane);
  } catch (error) {
    if (revision !== state.revision) return;
    const pending = state.pendingSymbol === item;
    if (pending) state.pendingSymbol = null;
    if (pending && state.symbol) elements.notice.textContent = `切换至 ${item.name} 失败 · ${error.message}`;
    else if (quiet || useCache) elements.notice.textContent = `刷新失败 · ${error.message}`;
    else {
      elements.notice.textContent = '';
      displayError(error.message);
    }
  } finally {
    if (revision === state.revision) {
      state.busy = false;
      state.refreshController = undefined;
    }
  }
}
async function pageHistory(pane) {
  if (pane.paging || state.busy || !pane.hasMore || !pane.bars.length || pane.dataKey !== candleKey(pane)) return;
  const revision = state.revision;
  pane.paging = true;
  try {
    const oldLength = pane.bars.length;
    const before = pane.bars[0].time;
    const [data, context] = await Promise.all([
      api('bars', barParameters(pane, before)),
      requestContexts(contextPlan([pane]), interval => api('bars', barParameters({ interval }, before))),
    ]);
    if (state.revision !== revision) return;
    for (const [interval, bars] of context) {
      state.contextSources[interval] = mergeBars(bars, state.contextSources[interval] || []);
    }
    const range = pane.chart.timeScale().getVisibleLogicalRange();
    data.bars = mergeBars(data.bars, pane.bars);
    applyBars(pane, data);
    if (rebuildContext()) {
      for (const linked of visiblePanes().filter(supportsPane)) {
        if (linked !== pane) renderIndicators(linked);
      }
    }
    renderIndicators(pane);
    const offset = data.bars.length - oldLength;
    if (range && offset) pane.chart.timeScale().setVisibleLogicalRange({ from: range.from + offset, to: range.to + offset });
  } catch (error) {
    if (state.revision === revision) elements.notice.textContent = error.message;
  } finally {
    pane.paging = false;
  }
}

function findBar(bars, time) {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (bars[middle].time <= time) low = middle + 1;
    else high = middle - 1;
  }
  return bars[high];
}
function renderCrosshair(pane) {
  const cursor = state.crosshair;
  const time = cursor?.time;
  const preview = pane.appliedPreview;
  const bar = time === undefined || pane.root.hidden ? undefined :
    preview?.time <= time ? preview : findBar(pane.bars, time);
  const matching = bar && time < barEnd(bar.time, pane.interval) ? bar : undefined;

  if (cursor?.pane === pane) {
    pane.linkedCrosshair = undefined;
    renderOHLC(pane, matching);
    return;
  }
  const scale = pane.chart.timeScale();
  const x = matching ? scale.timeToCoordinate(matching.time) : null;
  const visible = x !== null && x >= 0 && x < scale.width() ? matching : undefined;
  const key = visible ? `${visible.time}:${visible.close}:${x}` : undefined;
  if (key !== pane.linkedCrosshair) {
    pane.linkedCrosshair = key;
    if (visible) pane.chart.setCrosshairPosition(visible.close, visible.time, pane.series);
    else pane.chart.clearCrosshairPosition();
  }
  renderOHLC(pane, visible);
}

function clearCrosshair(keepNative) {
  if (!state.crosshair) return;
  const { pane } = state.crosshair;
  state.crosshair = null;
  if (keepNative) keepNative.linkedCrosshair = undefined;
  if (pane !== keepNative) pane.chart.clearCrosshairPosition();
  for (const linked of panes) renderCrosshair(linked);
}

function syncCrosshair(pane, point) {
  // Chart redraws also emit crosshair moves, including those caused by linked panes.
  if (!point.sourceEvent) return;
  if (!point.point || !Number.isFinite(point.time) || !point.seriesData?.has(pane.series)) {
    clearCrosshair(pane);
    return;
  }
  if (state.crosshair?.pane !== pane) clearCrosshair(pane);
  state.crosshair = { pane, time: point.time };
  for (const linked of visiblePanes()) renderCrosshair(linked);
}

function matchingDrawings(pane) {
  return drawings.filter(drawing => drawing.key === candleKey(pane) &&
    (state.replay === null || drawing.knownAt <= state.replay));
}
function renderDrawings(pane) {
  for (const { type, value } of pane.overlays) {
    if (type === 'level') pane.series.removePriceLine(value);
    else pane.chart.removeSeries(value);
  }
  pane.overlays = [];
  if (!pane.bars.length) return;
  for (const drawing of matchingDrawings(pane)) {
    if (drawing.type === 'level') {
      const value = pane.series.createPriceLine({
        price: drawing.a.value, color: '#d9ad5c', lineWidth: 1, axisLabelVisible: true,
      });
      pane.overlays.push({ type: 'level', value });
    } else {
      if (!pane.bars.some(bar => bar.time === drawing.a.time) || !pane.bars.some(bar => bar.time === drawing.b.time)) continue;
      const value = pane.chart.addSeries(LineSeries, {
        color: '#d9ad5c', lineWidth: 2, lastValueVisible: false, priceLineVisible: false,
        crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
      });
      value.setData([drawing.a, drawing.b].sort((a, b) => a.time - b.time));
      pane.overlays.push({ type: 'trend', value });
    }
  }
}
function setDrawingTool(tool) {
  state.drawingTool = tool;
  state.drawingStart = null;
  for (const choice of ['cursor', 'level', 'trend']) press($(`${choice}-tool`), tool === choice);
  for (const pane of panes) pane.widget.classList.toggle('drawing', tool !== 'cursor');
  elements.notice.textContent = {
    cursor: state.replay === null ? '' : `历史回放 · ${displayTime(state.replay)}`,
    level: '在图上选择水平线的价格。',
    trend: '在同一张图上选择趋势线的两个点。',
  }[tool];
}
function chartClick(pane, param) {
  setActive(pane);
  if (!state.symbol || state.drawingTool === 'cursor' || !param.point || !param.time) return;
  const value = pane.series.coordinateToPrice(param.point.y);
  if (!Number.isFinite(value)) return;
  const point = { time: param.time, value };
  const knownAt = state.replay ?? state.latestObserved ?? point.time;
  if (state.drawingTool === 'level') {
    drawings.push({ type: 'level', key: candleKey(pane), a: point, knownAt });
  } else {
    const anchor = state.drawingStart;
    if (anchor?.pane !== pane.id || anchor.key !== candleKey(pane)) {
      state.drawingStart = { pane: pane.id, key: candleKey(pane), point };
      elements.notice.textContent = '请选择趋势线的第二个点。';
      return;
    }
    if (anchor.point.time === point.time) return;
    drawings.push({ type: 'trend', key: candleKey(pane), a: anchor.point, b: point, knownAt });
  }
  saveStorage('kunhou.drawings', drawings);
  for (const linked of visiblePanes()) renderDrawings(linked);
  setDrawingTool('cursor');
}
function undoDrawing() {
  const key = candleKey(activePane());
  const i = drawings.findLastIndex(drawing => drawing.key === key);
  if (i < 0) return;
  drawings.splice(i, 1);
  saveStorage('kunhou.drawings', drawings);
  for (const pane of visiblePanes()) renderDrawings(pane);
}

function favoriteKey(item) { return `${state.source}:${item.name}`; }
function renderWatchlist() {
  $('symbol-count').textContent = state.catalog.length ? String(state.catalog.length) : '';
  $('watch-quote-label').textContent = state.replay !== null ? '历史回放' :
    state.source === 'offline' ? '收盘 / H1 涨跌' : '券商品种';
  const clean = value => value.toLowerCase().replace(/[\s/]+/g, '');
  const query = clean(elements.search.value);
  const groups = new Map();
  for (const item of state.catalog) {
    if (state.favoritesOnly && !favorites.has(favoriteKey(item))) continue;
    if (query && !clean(item.name).includes(query) && !clean(item.description || '').includes(query)) continue;
    const category = categoryOrder.includes(item.category) ? item.category : 'BROKER';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }
  const fragment = document.createDocumentFragment();
  for (const category of categoryOrder) {
    const items = groups.get(category);
    if (!items?.length) continue;
    fragment.append(element('div', 'watch-group', categoryNames[category] || '其他券商品种'));
    for (const item of items) {
      const selected = state.symbol?.id === item.id;
      const row = element('div', `symbol-row${selected ? ' selected' : ''}`);
      const star = element('button', 'star', favorites.has(favoriteKey(item)) ? '★' : '☆');
      star.setAttribute('aria-label', `收藏 ${item.name}`);
      press(star, favorites.has(favoriteKey(item)));
      star.addEventListener('click', () => {
        const key = favoriteKey(item);
        if (favorites.has(key)) favorites.delete(key);
        else favorites.add(key);
        saveStorage('kunhou.favorites', [...favorites]);
        renderWatchlist();
      });
      const button = element('button', 'symbol-select');
      if (selected) button.setAttribute('aria-current', 'true');
      const text = element('span', 'symbol-text');
      text.append(element('strong', '', item.name), element('small', '', item.description || ''));
      button.append(text);
      if (state.replay === null && Number.isFinite(item.lastPrice)) {
        const quote = element('span', 'symbol-quote');
        quote.append(element('span', '', price(item.lastPrice, item.digits)));
        if (Number.isFinite(item.changePercent)) {
          quote.append(element('small', item.changePercent >= 0 ? 'up' : 'down', percent(item.changePercent)));
        }
        button.append(quote);
      }
      button.addEventListener('click', () => {
        document.querySelector('.watchlist').classList.remove('open');
        chooseSymbol(item);
      });
      row.append(star, button);
      fragment.append(row);
    }
  }
  if (!groups.size) fragment.append(element('div', 'empty', state.catalog.length ? '没有匹配的品种。' : '暂无品种。'));
  const scrollTop = elements.symbols.scrollTop;
  elements.symbols.replaceChildren(fragment);
  elements.symbols.scrollTop = scrollTop;
}

function stopMarketStream() {
  state.liveStream?.close();
  state.liveStream = null;
  clearTimeout(state.streamRecovery);
  state.streamRecovery = undefined;
  state.streamKey = null;
  state.liveBars.clear();
  state.previews.clear();
  $('live-bid').textContent = '—';
  $('live-ask').textContent = '—';
  $('live-time').textContent = '';
  $('live-quote').hidden = true;
  $('live-quote').removeAttribute('title');
}
function displayPreview(pane) {
  const preview = state.previews.get(pane.interval);
  if (!preview || preview.bar.time <= (pane.bars.at(-1)?.time || 0)) return;
  if (pane.digits !== preview.digits) {
    pane.digits = preview.digits;
    pane.series.applyOptions({ priceFormat: { type: 'price', precision: pane.digits, minMove: 10 ** -pane.digits } });
  }
  if (!sameCandle(pane.appliedPreview, preview.bar)) {
    const newCandle = pane.appliedPreview?.time !== preview.bar.time;
    pane.series.update(preview.bar);
    pane.appliedPreview = preview.bar;
    if (newCandle) pane.latestView.align();
    if (pane.topBottom && topBottomPeriods.includes(pane.interval)) {
      pane.topBottomView.showWindows(pane.topBottom, preview.bar);
    }
  }
  return preview.bar;
}
function updateMarketStream() {
  if (!liveSource() || !state.symbol || document.hidden) return;
  const intervals = [...new Set(visiblePanes().filter(supportsPane).map(pane => pane.interval))].sort();
  const key = `${state.source}:${state.symbol.id}:${intervals.join(',')}`;
  if (state.streamKey === key) return;
  stopMarketStream();
  state.streamKey = key;
  const parameters = new URLSearchParams({ source: state.source, symbol: state.symbol.id });
  for (const interval of intervals) parameters.append('interval', interval);
  const stream = new EventSource(`/api/stream?${parameters}`);
  state.liveStream = stream;
  let disconnected = false;
  let lastRecovery = -Infinity;
  const recover = () => {
    if (state.liveStream !== stream || disconnected) return;
    if (state.busy) {
      state.streamRecovery = setTimeout(recover, 500);
      return;
    }
    lastRecovery = performance.now();
    refreshCharts({ quiet: true });
  };
  stream.addEventListener('status', event => {
    if (state.liveStream !== stream) return;
    const status = JSON.parse(event.data);
    elements.connection.textContent = status.message ||
      (status.connected ? 'cTrader · 已订阅行情' : 'cTrader · 实时连接暂不可用');
    if (!status.connected) {
      disconnected = true;
      clearTimeout(state.streamRecovery);
    } else if (disconnected) {
      disconnected = false;
      state.streamRecovery = setTimeout(recover, Math.max(500, lastRecovery + 5000 - performance.now()));
    }
  });
  stream.addEventListener('open', () => {
    if (state.liveStream !== stream || state.source === 'ctrader-local' || !disconnected) return;
    disconnected = false;
    state.streamRecovery = setTimeout(recover, 500);
  });
  stream.addEventListener('quote', event => {
    if (state.liveStream !== stream) return;
    const quote = JSON.parse(event.data);
    const digits = state.symbol.digits ?? activePane().digits;
    if (Number.isFinite(quote.bid)) writeText($('live-bid'), price(quote.bid, digits));
    if (Number.isFinite(quote.ask)) writeText($('live-ask'), price(quote.ask, digits));
    if (Number.isFinite(quote.time)) {
      const time = quoteTime.format(new Date(quote.time * 1000));
      if ($('live-time').textContent !== time) {
        $('live-time').textContent = time;
        $('live-quote').title = `最近报价 ${time} UTC+8`;
      }
    }
    if ($('live-quote').hidden) $('live-quote').hidden = false;
  });
  stream.addEventListener('preview', event => {
    if (state.liveStream !== stream) return;
    const { interval, bar, digits } = JSON.parse(event.data);
    const previous = state.previews.get(interval);
    if (!intervals.includes(interval) || !Number.isFinite(bar?.time) ||
      (previous && (bar.time < previous.bar.time || (digits === previous.digits && sameCandle(previous.bar, bar))))) return;
    state.previews.set(interval, { bar, digits });
    for (const pane of visiblePanes()) {
      if (pane.interval !== interval || pane.dataKey !== candleKey(pane)) continue;
      if (displayPreview(pane)) renderCrosshair(pane);
    }
  });
  stream.addEventListener('bar', event => {
    if (state.liveStream !== stream) return;
    const { interval, bar, digits } = JSON.parse(event.data);
    if (!intervals.includes(interval) || !Number.isFinite(bar?.time)) return;
    const latest = state.liveBars.get(interval) || [];
    if (latest.some(current => sameCandle(current, bar))) return;
    state.liveBars.set(interval, mergeBars(latest, [bar]).slice(-10));
    for (const pane of visiblePanes()) {
      if (pane.interval !== interval || pane.dataKey !== candleKey(pane)) continue;
      const current = pane.bars.at(-1);
      if (current && current.time > bar.time) continue;
      const bars = mergeBars(pane.bars, [bar]);
      applyBars(pane, { bars, digits, hasMore: pane.hasMore });
      if (interval === '1h' || (!intervals.includes('1h') && pane === activePane())) {
        renderInstrument(bars, digits);
        if (!state.pendingSymbol) elements.notice.textContent = `最后一根 ${periods[interval]} · ${displayTime(bar.time)}`;
      }
    }
    rebuildContext();
    for (const pane of visiblePanes().filter(supportsPane)) renderIndicators(pane);
    if (interval === '1h') syncSelectedHistory();
  });
  stream.addEventListener('error', () => {
    if (state.liveStream !== stream) return;
    disconnected = true;
    clearTimeout(state.streamRecovery);
    elements.connection.textContent = 'cTrader · 实时重连中';
  });
}

function setFavoritesOnly(only) {
  state.favoritesOnly = only;
  press($('all-symbols'), !only);
  press($('favorite-symbols'), only);
  renderWatchlist();
}
function selectInstrument(item) {
  state.symbol = item;
  alertView.refreshSelection();
  $('active-symbol').textContent = item?.name || '—';
  $('instrument-name').textContent = item?.name || '请选择品种';
  if (!item) $('instrument-meta').textContent = '';
  else $('instrument-meta').textContent = [item.description, categoryNames[item.category]]
    .filter(Boolean).join(' · ') || (liveSource() ? 'cTrader' : '本地历史库');
  $('replay-toggle').disabled = state.source !== 'offline' || !item;
  $('archive-strip').hidden = state.source !== 'ctrader-local' || !item?.localHistory;
  writeText($('archive-note'), '');
  renderWatchlist();
}
async function chooseSymbol(item) {
  if (state.pendingSymbol === item || (!state.pendingSymbol && state.symbol === item)) return;
  const preserveReplay = state.replay !== null;
  const time = state.replay;
  stopPlaying();
  if (preserveReplay) {
    await moveReplay('start', { time, symbol: item.id, reset: true });
    return;
  }
  clearTimeout(state.archiveTimer);
  state.pendingSymbol = item;
  await refreshCharts();
  if (!state.busy && state.symbol === item && item.localHistory && state.source === 'ctrader-local') {
    state.archiveTimer = setTimeout(() => {
      if (state.symbol === item && !state.pendingSymbol) syncSelectedHistory();
    }, 1500);
  }
}
async function changeSource(source, { startup = false, symbol } = {}) {
  const previousId = state.source === source ? state.symbol?.id : undefined;
  const revision = ++state.sourceRevision;
  stopPlaying();
  clearTimeout(state.archiveTimer);
  stopMarketStream();
  state.source = source;
  state.replay = null;
  state.catalog = [];
  state.chartCache.clear();
  state.sourceInfo = {};
  elements.source.value = source;
  elements.search.value = '';
  selectInstrument(null);
  clearChartData();
  displayError();
  updateReplayControls();
  elements.notice.textContent = '正在读取品种…';
  elements.connection.textContent = '正在连接数据源…';
  $('watch-note').textContent = '';
  try {
    const info = await api('source');
    if (revision !== state.sourceRevision) return;
    state.sourceInfo = info;
    const valid = supportedPeriods();
    for (const pane of panes) {
      if (!valid.includes(pane.interval) && !(pane.id === 'intraday' && pane.interval === '15m')) pane.interval = '1h';
    }
    renderPeriods();
    if (!info.connected) throw new Error(info.message || '行情数据源暂不可用。');
    const items = await api('symbols');
    if (revision !== state.sourceRevision) return;
    state.catalog = items;
    renderWatchlist();
    const item = items.find(item => item.id === symbol) || items.find(item => item.id === previousId) ||
      items.find(item => item.id === info.preferredSymbol) || items.find(item => item.name === 'EURUSD') || items[0];
    if (!item) throw new Error('这个账户没有返回可用的品种。');
    const label = elements.source.selectedOptions[0].textContent;
    elements.connection.textContent = source === 'offline' ? '本地历史库 · 只读' : `${label} · 正在连接实时行情`;
    $('watch-note').textContent = source === 'offline'
      ? `${info.symbols} 个品种 · ${info.bars.toLocaleString('zh-CN')} 根 H1${info.addedBars ? ' · cTrader 续接 ' + info.addedBars : ''}`
      : '搜索代码或中文名，点击品种切换四图';
    await chooseSymbol(item);
    if (startup && !state.symbol && !state.pendingSymbol && !state.busy) {
      throw new Error($('error-message').textContent || 'cTrader 暂未返回 K 线。');
    }
  } catch (error) {
    if (revision !== state.sourceRevision) return;
    if (startup && source === defaultSource) {
      await changeSource('offline');
      if (state.sourceRevision === revision + 1 && state.symbol) {
        elements.connection.textContent = 'cTrader 本地暂不可用 · 正在查看本地历史';
      }
      return;
    }
    displayError(error.message);
    elements.connection.textContent = '数据源未连接';
    elements.notice.textContent = '';
  }
}

async function openAlertSymbol(symbol) {
  if (state.source !== defaultSource) await changeSource(defaultSource, { symbol });
  else {
    const item = state.catalog.find(item => item.id === symbol);
    if (item) await chooseSymbol(item);
  }
  return state.source === defaultSource && state.symbol?.id === symbol;
}

async function syncSelectedHistory() {
  if (state.pendingSymbol || state.source !== 'ctrader-local' || !state.symbol?.localHistory) return;
  const { id, name } = state.symbol;
  const revision = state.sourceRevision;
  if (state.archiveJob?.id === id && state.archiveJob.revision === revision) return;
  const job = { id, revision };
  state.archiveJob = job;
  const current = () => state.archiveJob === job && state.sourceRevision === revision && state.symbol?.id === id;
  try {
    const query = new URLSearchParams({ symbol: name });
    const response = await fetch(`/api/history/sync?${query}`, { method: 'POST' });
    const info = await response.json();
    if (!current()) return;
    if (!response.ok) throw new Error(info.error || 'H1 续接暂不可用');
    const notes = {
      ready: info.count ? `H1 续接至 ${displayTime(info.latest)}` : '本地 H1 已到最新收盘',
      gap: 'cTrader 历史未覆盖原库断点',
      unaligned: '两源 H1 开盘时间不对齐',
    };
    writeText($('archive-note'), notes[info.state] || '');
  } catch (error) {
    if (current()) writeText($('archive-note'), error.message);
  } finally {
    if (state.archiveJob === job) state.archiveJob = null;
  }
}

function updateReplayControls() {
  const active = state.replay !== null;
  $('replay-panel').hidden = !active;
  press($('replay-toggle'), active);
  $('replay-cursor').textContent = active ? displayTime(state.replay) + ' UTC+8' : '';
  const player = $('replay-play');
  player.textContent = state.playing ? 'Ⅱ' : '▶';
  const label = state.playing ? '暂停' : '播放';
  player.title = label;
  player.setAttribute('aria-label', label);
  for (const name of ['next', 'prev', 'start', 'random']) $(`replay-${name}`).disabled = state.stepping;
}
let playTimer;
function stopPlaying() {
  clearTimeout(playTimer);
  state.playing = false;
  updateReplayControls();
}
function scheduleStep() {
  if (!state.playing) return;
  playTimer = setTimeout(async () => {
    const moved = await moveReplay('next');
    if (!moved) stopPlaying();
    scheduleStep();
  }, Number($('replay-speed').value));
}
function togglePlaying() {
  if (state.playing) stopPlaying();
  else if (state.replay !== null) {
    state.playing = true;
    updateReplayControls();
    scheduleStep();
  }
}
async function moveReplay(mode, { time = state.replay, symbol = state.symbol?.id, reset = false } = {}) {
  if (state.source !== 'offline' || !symbol || state.stepping) return false;
  const sourceRevision = state.sourceRevision;
  state.stepping = true;
  updateReplayControls();
  try {
    const next = await api('replay', { mode, time, symbol });
    if (sourceRevision !== state.sourceRevision) return false;
    if (next.time === null) {
      elements.notice.textContent = mode === 'previous' ? '已到该品种的历史起点。' : '该日期之后没有更多 H1 数据。';
      return false;
    }
    if (state.replay === null || next.time < state.replay || next.symbol !== state.symbol.id || reset) clearChartData();
    state.replay = next.time;
    selectInstrument(state.catalog.find(item => item.id === next.symbol));
    $('replay-date').value = displayDate(next.time);
    updateReplayControls();
    await refreshCharts();
    return true;
  } catch (error) {
    if (sourceRevision === state.sourceRevision) displayError(error.message);
    return false;
  } finally {
    state.stepping = false;
    updateReplayControls();
  }
}
function toggleReplay() {
  if (state.stepping) return;
  if (state.replay === null) {
    moveReplay('start', { time: undefined, reset: true });
    return;
  }
  stopPlaying();
  state.replay = null;
  clearChartData();
  updateReplayControls();
  renderWatchlist();
  refreshCharts();
}
function recordResult(result) {
  if (state.replay === null || !state.symbol) return;
  backtests.push({ symbol: state.symbol.name, time: state.replay, result });
  saveStorage('kunhou.backtests', backtests);
  renderPaperStats();
}
function renderPaperStats() {
  const wins = backtests.filter(trade => trade.result > 0).length;
  const total = backtests.reduce((sum, trade) => sum + trade.result, 0);
  const rate = backtests.length ? ` · 胜率 ${(wins / backtests.length * 100).toFixed(0)}%` : '';
  const text = `累计 ${total > 0 ? '+' : ''}${total}R${rate}`;
  $('paper-status').textContent = text;
  $('paper-count').textContent = String(backtests.length);
  $('paper-undo').disabled = !backtests.length;
  $('paper-summary').textContent = `${backtests.length} 笔 · ${text}`;
  $('paper-rows').replaceChildren(...backtests.slice().reverse().map(trade => {
    const row = element('tr');
    row.append(element('td', '', trade.symbol), element('td', '', displayTime(trade.time)),
      element('td', trade.result > 0 ? 'up' : 'down', trade.result > 0 ? '+3R' : '−1R'));
    return row;
  }));
}
function focusSymbolSearch() {
  document.querySelector('.watchlist').classList.add('open');
  elements.search.focus();
  elements.search.select();
}

$('symbol-button').addEventListener('click', focusSymbolSearch);
elements.search.addEventListener('input', renderWatchlist);
elements.search.addEventListener('keydown', event => {
  if (event.key === 'Enter') elements.symbols.querySelector('.symbol-select')?.click();
});
elements.source.addEventListener('change', () => changeSource(elements.source.value));
$('all-symbols').addEventListener('click', () => setFavoritesOnly(false));
$('favorite-symbols').addEventListener('click', () => setFavoritesOnly(true));
$('offline-button').addEventListener('click', () => changeSource('offline'));
$('retry-button').addEventListener('click', () => state.symbol ? refreshCharts() : changeSource(state.source));
$('grid-toggle').addEventListener('click', () => {
  state.split = !state.split;
  updateLayout();
  refreshCharts();
});
for (const tool of ['cursor', 'trend', 'level']) $(`${tool}-tool`).addEventListener('click', () => setDrawingTool(tool));
$('undo-tool').addEventListener('click', undoDrawing);
$('sma-tool').addEventListener('click', () => {
  state.sma = !state.sma;
  press($('sma-tool'), state.sma);
  for (const pane of panes) displayMovingAverage(pane);
});
$('fit-tool').addEventListener('click', () => activePane().latestView.fit());
for (const indicator of Object.keys(indicatorToggles)) {
  const button = $(`indicator-${indicator}`);
  if (!button) continue;
  press(button, indicatorToggles[indicator]);
  button.addEventListener('click', () => {
    indicatorToggles[indicator] = !indicatorToggles[indicator];
    press(button, indicatorToggles[indicator]);
    saveStorage('yidao.indicators', indicatorToggles);
    for (const pane of visiblePanes()) renderIndicators(pane);
    if (indicator !== 'pivots' && indicatorToggles[indicator]) refreshCharts({ quiet: true });
  });
}
$('replay-toggle').addEventListener('click', toggleReplay);
$('replay-prev').addEventListener('click', () => { stopPlaying(); moveReplay('previous'); });
$('replay-next').addEventListener('click', () => { stopPlaying(); moveReplay('next'); });
$('replay-random').addEventListener('click', () => { stopPlaying(); moveReplay('random', { reset: true }); });
$('replay-play').addEventListener('click', togglePlaying);
$('replay-start').addEventListener('click', () => {
  stopPlaying();
  const day = $('replay-date').value;
  if (day) moveReplay('start', { time: Date.parse(`${day}T00:00:00+08:00`) / 1000, reset: true });
});
$('paper-win').addEventListener('click', () => recordResult(3));
$('paper-loss').addEventListener('click', () => recordResult(-1));
$('paper-undo').addEventListener('click', () => {
  backtests.pop();
  saveStorage('kunhou.backtests', backtests);
  renderPaperStats();
});
$('paper-log').addEventListener('click', () => $('paper-dialog').showModal());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
    setDrawingTool('cursor');
    document.querySelector('.watchlist').classList.remove('open');
  }
  if (event.key === '/' && !document.querySelector('dialog[open]') &&
    !event.ctrlKey && !event.metaKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) {
    event.preventDefault();
    focusSymbolSearch();
  }
});
setInterval(() => {
  if (liveSource() && !state.busy && !document.hidden) refreshCharts({ quiet: true });
}, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearCrosshair();
    stopMarketStream();
  }
  else if (liveSource()) {
    for (const pane of visiblePanes()) pane.latestView.align();
    refreshCharts({ quiet: true });
    syncSelectedHistory();
  }
});
$('archive-sync').addEventListener('click', syncSelectedHistory);
setInterval(() => {
  if (!document.hidden && !state.busy) syncSelectedHistory();
}, 60000);

updateLayout();
renderPeriods();
renderPaperStats();
const alertView = installAlerts(() => state.source === 'ctrader-local' ? state.symbol?.id : state.symbol?.name, openAlertSymbol);
changeSource(defaultSource, { startup: true });
