import { CandlestickSeries, CrosshairMode, LineSeries, PriceScaleMode, createChart, createSeriesMarkers } from '/charts.mjs';
import { calculateIndicators } from '/indicators.mjs';

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
const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const localTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
const state = {
  source: 'offline', sourceInfo: {}, catalog: [], symbol: null, favoritesOnly: false,
  activePane: 'main', split: true, replay: null, playing: false, stepping: false,
  drawingTool: 'cursor', drawingStart: null, sma: false, revision: 0, sourceRevision: 0,
  busy: false, syncing: false, liveStream: null, streamKey: null, liveBars: new Map(),
};

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
async function api(path, parameters = {}, source = state.source) {
  const query = new URLSearchParams({ source });
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null) query.set(key, value);
  }
  const response = await fetch(`/api/${path}?${query}`);
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
  const expand = element('button', '', '⤢');
  expand.title = '切换单图';
  expand.setAttribute('aria-label', `展开${name}`);
  const widget = element('div', 'chart-widget');
  const placeholder = element('div', 'chart-placeholder');
  const reason = element('span');
  const changeFeed = element('button', '', '切换到 cTrader');
  changeFeed.addEventListener('click', () => changeSource('ctrader'));
  placeholder.append(reason, changeFeed);
  placeholder.hidden = true;
  top.append(select, ohlc, expand);
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
      borderColor: '#243329', timeVisible: true, secondsVisible: false, rightOffset: 5,
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
  });
  const sma = chart.addSeries(LineSeries, {
    color: '#dfbc65', lineWidth: 1, lastValueVisible: false, priceLineVisible: false,
    crosshairMarkerVisible: false, visible: false,
  });
  const magnet = chart.addSeries(LineSeries, {
    color: '#b39ddb', lineWidth: 3, lastValueVisible: false, priceLineVisible: false,
    crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
  });
  const markers = createSeriesMarkers(series, [], { autoScale: false });
  const pane = {
    id, root, select, ohlc, chart, series, sma, magnet, markers, interval, bars: [], digits: 5,
    widget, overlays: [], hasMore: false, paging: false, dataKey: null,
    placeholder, reason, changeFeed,
  };
  widget.append(placeholder);
  pane.indicatorOverlay = attachIndicatorOverlay(pane);
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
  chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (range && range.from < 16 && range.to < pane.bars.length - 10) pageHistory(pane);
  });
  return pane;
}

const panes = [
  chartPane('upper', '4h', '左上图'), chartPane('intraday', '15m', '右上图'),
  chartPane('lower', '1h', '左下图'), chartPane('main', '1w', '右下图'),
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
  setActive(pane);
  pane.interval = interval;
  pane.dataKey = null;
  renderPeriods();
  refreshCharts();
}

function renderOHLC(pane, bar = pane.bars.at(-1)) {
  pane.ohlc.replaceChildren();
  if (!bar) {
    pane.ohlc.textContent = '暂无 K 线';
    return;
  }
  for (const [label, key] of [['O', 'open'], ['H', 'high'], ['L', 'low'], ['C', 'close']]) {
    const text = element('span', '', `${label} `);
    text.append(element('b', '', price(bar[key], pane.digits)));
    pane.ohlc.append(text);
  }
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
          if (annotation.price === undefined) {
            const top = pane.series.priceToCoordinate(annotation.high);
            const bottom = pane.series.priceToCoordinate(annotation.low);
            if (top === null || bottom === null || bottom < 0 || top > height) continue;
            context.globalAlpha = 0.15;
            context.fillStyle = color;
            context.fillRect(left, top, Math.max(2, right - left), bottom - top);
            context.globalAlpha = 0.55;
            context.strokeStyle = color;
            context.setLineDash([4, 3]);
            context.strokeRect(left, top, Math.max(2, right - left), bottom - top);
            context.setLineDash([]);
            if (right - left > 36) {
              context.fillStyle = color;
              context.fillText(annotation.label || '', left + 4, top + 13);
            }
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
  const result = calculateIndicators(pane.bars, {
    interval: pane.interval, higherBars: state.contextBars, digits: pane.digits,
    showReversals: indicatorToggles.reversal, showPivots: indicatorToggles.pivots,
    showMagnet: indicatorToggles.magnet,
  });
  pane.magnet.setData(result.magnet);
  pane.markers.setMarkers(result.reversals);
  pane.indicatorOverlay([...result.zones, ...result.pivots]);
}
function applyBars(pane, data, { reset = false } = {}) {
  pane.bars = data.bars;
  pane.digits = data.digits ?? 5;
  pane.hasMore = data.hasMore;
  pane.series.applyOptions({ priceFormat: { type: 'price', precision: pane.digits, minMove: 10 ** -pane.digits } });
  pane.series.setData(pane.bars);
  displayMovingAverage(pane);
  renderOHLC(pane);
  renderDrawings(pane);
  if (reset && pane.bars.length) {
    const last = pane.bars.length - 1;
    pane.chart.timeScale().setVisibleLogicalRange({ from: Math.max(-1, last - (pane.id === 'main' ? 165 : 105)), to: last + 6 });
  }
}
function renderInstrument(bars, digits) {
  const last = bars.at(-1);
  const prev = bars.at(-2);
  const change = last && prev?.close ? (last.close / prev.close - 1) * 100 : null;
  $('last-close').textContent = price(last?.close, digits);
  $('last-change').textContent = change === null ? '' : percent(change);
  $('last-change').className = change === null ? '' : change >= 0 ? 'up' : 'down';
}
function clearChartData() {
  state.revision++;
  state.busy = false;
  state.contextBars = {};
  for (const pane of panes) {
    pane.dataKey = null;
    applyBars(pane, { bars: [], digits: 5, hasMore: false });
    renderIndicators(pane);
  }
  renderInstrument([], 5);
}
function candleKey(pane) { return `${state.source}:${state.symbol?.id}:${pane.interval}`; }
function barParameters(pane, before = state.replay === null ? undefined : state.replay + 1) {
  return { symbol: state.symbol.id, interval: pane.interval, limit: 500, before };
}
function mergeBars(first, second) {
  return [...new Map([...first, ...second].map(bar => [bar.time, bar])).values()].sort((a, b) => a.time - b.time);
}
async function refreshCharts({ quiet = false } = {}) {
  if (!state.symbol) return;
  const revision = ++state.revision;
  const chartPanes = visiblePanes().filter(supportsPane);
  const jobs = new Map();
  const getBars = interval => {
    if (!jobs.has(interval)) jobs.set(interval, api('bars', barParameters({ interval })));
    return jobs.get(interval);
  };
  if (!quiet) elements.notice.textContent = '正在载入 K 线…';
  state.busy = true;
  try {
    const primary = state.source === 'offline' || chartPanes.some(pane => pane.interval === '1h') ? '1h' : activePane().interval;
    const work = [...chartPanes.map(pane => getBars(pane.interval)), getBars(primary)];
    const contextIntervals = new Set();
    if (chartPanes.some(pane => pane.interval === '1h')) contextIntervals.add('4h');
    if (chartPanes.some(pane => pane.interval === '1w')) contextIntervals.add('1mo');
    const [results, pairs] = await Promise.all([
      Promise.all(work),
      Promise.all([...contextIntervals].map(async interval => [interval, (await getBars(interval)).bars])),
    ]);
    if (revision !== state.revision) return;
    state.contextBars = {
      ...Object.fromEntries(pairs), ...Object.fromEntries(chartPanes.map((pane, i) => [pane.interval, results[i].bars])),
    };
    for (const pane of visiblePanes()) {
      if (supportsPane(pane)) continue;
      applyBars(pane, { bars: [], digits: 5, hasMore: false });
      renderIndicators(pane);
    }
    for (const [i, pane] of chartPanes.entries()) {
      const data = { ...results[i] };
      const key = candleKey(pane);
      const reset = pane.dataKey !== key || !pane.bars.length;
      const latestView = pane.chart.timeScale().scrollPosition() >= -5;
      if (quiet && !reset && pane.bars.length) {
        if (pane.bars[0].time < (data.bars[0]?.time ?? Infinity)) data.hasMore = pane.hasMore;
        data.bars = mergeBars(pane.bars, data.bars);
      }
      const pushed = state.liveBars.get(pane.interval);
      if (pushed?.length) data.bars = mergeBars(data.bars, pushed);
      applyBars(pane, data, { reset });
      renderIndicators(pane);
      pane.dataKey = key;
      if (!reset && latestView && data.bars.length) pane.chart.timeScale().scrollToRealTime();
    }
    const quote = results.at(-1);
    state.latestObserved = quote.bars.at(-1)?.time;
    renderInstrument(quote.bars, quote.digits);
    if (state.replay === null) {
      const last = quote.bars.at(-1);
      elements.notice.textContent = last ? `最后一根 ${periods[primary]} · ${displayTime(last.time)}` : '当前区间暂无 K 线';
    } else {
      elements.notice.textContent = `历史回放 · ${displayTime(state.replay)}`;
    }
    displayError();
    updateMarketStream();
  } catch (error) {
    if (revision === state.revision) {
      elements.notice.textContent = quiet ? `刷新失败 · ${error.message}` : '';
      if (!quiet) displayError(error.message);
    }
  } finally {
    if (revision === state.revision) state.busy = false;
  }
}
async function pageHistory(pane) {
  if (pane.paging || state.busy || !pane.hasMore || !pane.bars.length || pane.dataKey !== candleKey(pane)) return;
  const revision = state.revision;
  pane.paging = true;
  try {
    const oldLength = pane.bars.length;
    const data = await api('bars', barParameters(pane, pane.bars[0].time));
    if (state.revision !== revision) return;
    const range = pane.chart.timeScale().getVisibleLogicalRange();
    data.bars = mergeBars(data.bars, pane.bars);
    applyBars(pane, data);
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
function syncCrosshair(pane, point) {
  if (state.syncing) return;
  state.syncing = true;
  renderOHLC(pane, point.seriesData?.get(pane.series) || pane.bars.at(-1));
  for (const linked of visiblePanes()) {
    if (linked === pane) continue;
    const closest = point.time && point.time <= (state.replay ?? linked.bars.at(-1)?.time + 32 * 86400) ?
      findBar(linked.bars, point.time) : undefined;
    if (closest) linked.chart.setCrosshairPosition(closest.close, closest.time, linked.series);
    else linked.chart.clearCrosshairPosition();
    renderOHLC(linked, closest || linked.bars.at(-1));
  }
  state.syncing = false;
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
  const query = elements.search.value.trim().toLowerCase();
  const groups = new Map();
  for (const item of state.catalog) {
    if (state.favoritesOnly && !favorites.has(favoriteKey(item))) continue;
    if (query && !`${item.name} ${item.description || ''}`.toLowerCase().includes(query)) continue;
    const category = categoryNames[item.category] || item.category || '券商品种';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }
  const fragment = document.createDocumentFragment();
  for (const [category, items] of groups) {
    fragment.append(element('div', 'watch-group', category));
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
  state.streamKey = null;
  state.liveBars.clear();
  $('live-bid').textContent = '—';
  $('live-ask').textContent = '—';
  $('live-quote').hidden = true;
  $('live-quote').removeAttribute('title');
}
function updateMarketStream() {
  if (state.source !== 'ctrader' || !state.symbol || document.hidden) return;
  const intervals = [...new Set(visiblePanes().filter(supportsPane).map(pane => pane.interval))].sort();
  const key = `${state.symbol.id}:${intervals.join(',')}`;
  if (state.streamKey === key) return;
  stopMarketStream();
  state.streamKey = key;
  const parameters = new URLSearchParams({ source: 'ctrader', symbol: state.symbol.id });
  for (const interval of intervals) parameters.append('interval', interval);
  const stream = new EventSource(`/api/stream?${parameters}`);
  state.liveStream = stream;
  stream.addEventListener('status', event => {
    if (state.liveStream !== stream) return;
    const status = JSON.parse(event.data);
    elements.connection.textContent = status.message ||
      (status.connected ? 'cTrader · 已订阅行情' : 'cTrader · 实时连接暂不可用');
    if (!status.connected) $('live-quote').hidden = true;
  });
  stream.addEventListener('quote', event => {
    if (state.liveStream !== stream) return;
    const quote = JSON.parse(event.data);
    const digits = state.symbol.digits ?? activePane().digits;
    if (Number.isFinite(quote.bid)) $('live-bid').textContent = price(quote.bid, digits);
    if (Number.isFinite(quote.ask)) $('live-ask').textContent = price(quote.ask, digits);
    if (Number.isFinite(quote.time)) $('live-quote').title = `最近报价 ${displayTime(quote.time)} UTC+8`;
    $('live-quote').hidden = false;
  });
  stream.addEventListener('bar', event => {
    if (state.liveStream !== stream) return;
    const { interval, bar, digits } = JSON.parse(event.data);
    if (!intervals.includes(interval) || !Number.isFinite(bar?.time)) return;
    state.liveBars.set(interval, mergeBars(state.liveBars.get(interval) || [], [bar]).slice(-10));
    for (const pane of visiblePanes()) {
      if (pane.interval !== interval || pane.dataKey !== candleKey(pane) || !pane.bars.length) continue;
      const current = pane.bars.at(-1);
      if (current && current.time > bar.time) continue;
      const latestView = pane.chart.timeScale().scrollPosition() >= -5;
      const bars = mergeBars(pane.bars, [bar]);
      state.contextBars[interval] = bars;
      applyBars(pane, { bars, digits, hasMore: pane.hasMore });
      renderIndicators(pane);
      if (latestView) pane.chart.timeScale().scrollToRealTime();
      if (interval === '1h' || (!intervals.includes('1h') && pane === activePane())) {
        renderInstrument(bars, digits);
        elements.notice.textContent = `最后一根 ${periods[interval]} · ${displayTime(bar.time)}`;
      }
    }
  });
  stream.addEventListener('error', () => {
    if (state.liveStream !== stream) return;
    $('live-quote').hidden = true;
    elements.connection.textContent = 'cTrader · 实时重连中，历史 K 线仍会刷新';
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
  $('active-symbol').textContent = item?.name || '—';
  $('instrument-name').textContent = item?.name || '请选择品种';
  if (!item) $('instrument-meta').textContent = '';
  else $('instrument-meta').textContent = [item.description, categoryNames[item.category]]
    .filter(Boolean).join(' · ') || (state.source === 'ctrader' ? 'cTrader' : '本地历史库');
  $('replay-toggle').disabled = state.source !== 'offline' || !item;
  renderWatchlist();
}
async function chooseSymbol(item) {
  const preserveReplay = state.replay !== null;
  const time = state.replay;
  stopPlaying();
  if (preserveReplay) {
    await moveReplay('start', { time, symbol: item.id, reset: true });
    return;
  }
  stopMarketStream();
  selectInstrument(item);
  setDrawingTool('cursor');
  clearChartData();
  await refreshCharts();
}
async function changeSource(source) {
  const revision = ++state.sourceRevision;
  stopPlaying();
  stopMarketStream();
  state.source = source;
  state.replay = null;
  state.catalog = [];
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
    const item = items.find(item => item.name === 'EURUSD') || items[0];
    if (!item) throw new Error('这个账户没有返回可用的品种。');
    elements.connection.textContent = source === 'offline' ? '本地历史库 · 只读' : 'cTrader Open API · 正在连接实时行情';
    $('watch-note').textContent = source === 'offline'
      ? `${info.symbols} 个品种 · ${info.bars.toLocaleString('zh-CN')} 根 H1`
      : '品种列表由授权券商账户提供';
    await chooseSymbol(item);
  } catch (error) {
    if (revision !== state.sourceRevision) return;
    displayError(error.message);
    elements.connection.textContent = '数据源未连接';
    elements.notice.textContent = '';
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
$('fit-tool').addEventListener('click', () => activePane().chart.timeScale().fitContent());
for (const indicator of Object.keys(indicatorToggles)) {
  const button = $(`indicator-${indicator}`);
  if (!button) continue;
  press(button, indicatorToggles[indicator]);
  button.addEventListener('click', () => {
    indicatorToggles[indicator] = !indicatorToggles[indicator];
    press(button, indicatorToggles[indicator]);
    saveStorage('yidao.indicators', indicatorToggles);
    for (const pane of visiblePanes()) renderIndicators(pane);
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
  if (event.key === 'Escape' && !$('paper-dialog').open) {
    setDrawingTool('cursor');
    document.querySelector('.watchlist').classList.remove('open');
  }
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) {
    event.preventDefault();
    focusSymbolSearch();
  }
});
setInterval(() => {
  if (state.source === 'ctrader' && !state.busy && !document.hidden) refreshCharts({ quiet: true });
}, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMarketStream();
  else if (state.source === 'ctrader') refreshCharts({ quiet: true });
});

updateLayout();
renderPeriods();
renderPaperStats();
changeSource('offline');
