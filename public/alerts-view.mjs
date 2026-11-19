const timeFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
const kinds = { live: '实时', history: '历史回填', recovered: '补记' };
const watchStates = { waiting: '等待行情', reading: '读取中', ready: '监测中', error: '读取失败' };
const seenKey = 'yidao.alerts.seen';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timestamp(seconds) {
  const date = new Date(seconds * 1000);
  const node = element('time', '', timeFormat.format(date));
  node.dateTime = date.toISOString();
  return node;
}

function recordNode(record) {
  const row = element('article', 'alert-record');
  const top = element('div', 'alert-record-top');
  top.append(element('b', '', record.symbol),
    element('span', record.direction === 1 ? 'down' : 'up', record.direction === 1 ? '做空' : '做多'),
    element('span', '', `${record.period.toUpperCase()} · ${record.pattern}`),
    element('span', 'alert-price', record.price.toFixed(record.digits)));
  const meta = element('div', 'alert-record-meta');
  meta.append(timestamp(record.closeTime), element('span', '', kinds[record.kind]));
  if (record.matches.length) meta.append(element('span', '', record.matches.join(' · ')));
  row.append(top, meta);
  return row;
}

async function request(path, parameters = {}, method = 'GET') {
  const response = await fetch(`/api/alerts/${path}?${new URLSearchParams(parameters)}`, { method });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本机警报服务暂不可用。');
  return result;
}

export function installAlerts(getSymbol, openSymbol) {
  const $ = id => document.getElementById(id);
  const dialog = $('alerts-dialog');
  const badge = $('alerts-new');
  const watch = $('alerts-watch-current');
  const watches = $('alerts-watches');
  const list = $('alerts-list');
  const toast = $('alert-toast');
  const groupedButton = $('alerts-grouped');
  const search = $('alerts-search');
  const more = $('alerts-more');
  const statusText = text => { $('alerts-status').textContent = text; };
  const histories = new Map();
  const expanded = new Set();
  let instruments = [];
  let instrumentSignature;
  let status;
  let watchSignature;
  let seen = 0;
  let previousLive;
  let toastTimer;
  let grouped = true;
  let refreshing = false;
  let changingWatch = false;
  try { seen = Number(localStorage.getItem(seenKey)) || 0; } catch {}

  function refreshSelection() {
    const symbol = getSymbol();
    const isWatched = status?.watches.some(item => item.symbol === symbol);
    watch.textContent = symbol ? `${isWatched ? '停止监测' : '监测'} ${symbol}` : '监测当前品种';
    watch.disabled = changingWatch || !symbol || (!status?.connected && !isWatched);
  }

  function updateWatches() {
    $('alerts-connection').textContent = status.connected ? 'cTrader 本地已连接' : '等待 cTrader 本地桥';
    refreshSelection();
    const signature = JSON.stringify(status.watches);
    if (signature === watchSignature) return;
    watchSignature = signature;
    const nodes = status.watches.map(item => {
      const chip = element('div', 'alert-watch');
      const mark = element('span', 'alert-watch-mark');
      mark.dataset.state = item.state;
      chip.title = item.message || watchStates[item.state];
      const remove = element('button', '', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `停止监测 ${item.symbol}`);
      remove.addEventListener('click', () => setWatch(item.symbol, false));
      chip.append(mark, element('span', '', item.symbol), remove);
      return chip;
    });
    watches.replaceChildren(...nodes);
  }

  function historyFor(symbol) {
    if (!histories.has(symbol)) {
      histories.set(symbol, { records: new Map(), head: null, loaded: false, loading: false, loadError: '' });
    }
    return histories.get(symbol);
  }

  function ordered({ records }) {
    return [...records.values()].sort((a, b) => b.closeTime - a.closeTime || b.id - a.id);
  }

  async function loadHistory(symbol, older = false) {
    const history = historyFor(symbol);
    if (history.loading || (older && !history.next)) return false;
    history.loading = true;
    const previousSize = history.records.size;
    const wasLoaded = history.loaded;
    const previousError = history.loadError;
    try {
      const parameters = { limit: symbol ? 15 : 80, ...(older ? history.next : {}) };
      if (symbol) parameters.symbol = symbol;
      const result = await request('history', parameters);
      for (const record of result.events) history.records.set(record.id, record);
      if (older) history.loadedOlder = true;
      else history.head = result.events[0]?.id ?? null;
      if (older || !history.loadedOlder) history.next = result.next;
      history.loaded = true;
      history.loadError = '';
    } catch (error) {
      history.loadError = error.message;
    } finally {
      history.loading = false;
    }
    return history.records.size !== previousSize || history.loaded !== wasLoaded || history.loadError !== previousError;
  }

  function signalSummary(record) {
    return `${record.pattern} ${record.direction === 1 ? '做空' : '做多'}`;
  }

  function periodNode(period, record) {
    const tile = element('div', 'alert-period');
    tile.append(element('strong', '', period.toUpperCase()));
    if (record) {
      tile.append(element('span', record.direction === 1 ? 'down' : 'up', signalSummary(record)),
        element('small', 'alert-period-price', record.price.toFixed(record.digits)), timestamp(record.closeTime));
    } else tile.append(element('small', 'quiet', '暂无信号'));
    return tile;
  }

  async function showChart(symbol, button) {
    button.disabled = true;
    try {
      if (await openSymbol(symbol)) dialog.close();
      else statusText(`暂时无法打开 ${symbol} 的 cTrader 图表。`);
    } catch {
      statusText(`暂时无法打开 ${symbol} 的 cTrader 图表。`);
    } finally {
      button.disabled = !status?.connected;
    }
  }

  function instrumentNode(item) {
    const { symbol, latest, total, longCount, shortCount, periods } = item;
    const card = element('article', 'alert-instrument');
    const heading = element('div', 'alert-instrument-title');
    const title = element('strong', '', symbol);
    const chart = element('button', '', '查看图表');
    chart.setAttribute('aria-label', `查看 ${symbol} 图表`);
    chart.disabled = !status?.connected;
    chart.addEventListener('click', () => showChart(symbol, chart));
    heading.append(title, element('small', 'quiet', 'cTrader 本地'), chart);

    const headline = element('div', 'alert-instrument-latest');
    headline.append(element('span', latest.direction === 1 ? 'down' : 'up', signalSummary(latest)),
      element('span', '', `${latest.period.toUpperCase()} · ${latest.category}`),
      element('b', 'alert-price', latest.price.toFixed(latest.digits)));
    const meta = element('div', 'alert-record-meta');
    meta.append(timestamp(latest.closeTime), element('span', '', kinds[latest.kind]),
      element('span', '', latest.matches.join(' · ')));
    const context = element('div', 'alert-periods');
    context.append(periodNode('1h', periods['1h']), periodNode('4h', periods['4h']));
    const counts = element('div', 'alert-instrument-counts');
    counts.append(element('span', 'quiet', '近 7 天'), element('span', 'up', `做多 ${longCount}`),
      element('span', 'down', `做空 ${shortCount}`));

    const detail = element('details', 'alert-instrument-history');
    detail.open = expanded.has(symbol);
    detail.append(element('summary', '', `警报历史 · ${total} 条`));
    if (detail.open) {
      const history = historyFor(symbol);
      const rows = ordered(history);
      const entries = element('div', 'alert-instrument-rows');
      if (history.loadError) entries.append(element('small', 'down', history.loadError));
      if (!history.loaded && !history.loadError) entries.append(element('small', 'quiet', '正在读取警报历史…'));
      entries.append(...rows.map(recordNode));
      if (history.next) {
        const earlier = element('button', 'alert-earlier', '更早记录');
        earlier.addEventListener('click', async () => {
          earlier.disabled = true;
          if (await loadHistory(symbol, true)) renderHistory();
          earlier.disabled = false;
        });
        entries.append(earlier);
      }
      detail.append(entries);
    }
    detail.addEventListener('toggle', async () => {
      if (!detail.isConnected || detail.open === expanded.has(symbol)) return;
      if (detail.open) {
        expanded.add(symbol);
        renderHistory();
        if (await loadHistory(symbol)) renderHistory();
      } else expanded.delete(symbol);
    });
    card.append(heading, headline, meta, context, counts, detail);
    return card;
  }

  function renderHistory() {
    const query = search.value.trim().toUpperCase();
    const flat = historyFor('');
    const entries = grouped ? instruments : ordered(flat);
    const filtered = entries.filter(item => item.symbol.toUpperCase().includes(query));
    const scroll = list.scrollTop;
    if (filtered.length) list.replaceChildren(...filtered.map(grouped ? instrumentNode : recordNode));
    else list.replaceChildren(element('div', 'empty', query ? '没有匹配的品种。' :
      '暂无警报记录。添加监测品种后会读取最近 7 天的信号。'));
    list.scrollTop = scroll;
    more.hidden = grouped || !flat.next;
  }

  async function loadPanel(connectionChanged) {
    if (!grouped) {
      if (await loadHistory('') || !list.childNodes.length) renderHistory();
      if (historyFor('').loadError) statusText(historyFor('').loadError);
      return;
    }
    const incoming = await request('instruments');
    const signature = JSON.stringify(incoming);
    const changed = signature !== instrumentSignature;
    instrumentSignature = signature;
    instruments = incoming;
    const updated = await Promise.all(instruments
      .filter(item => expanded.has(item.symbol) && historyFor(item.symbol).head !== item.latest.id)
      .map(item => loadHistory(item.symbol)));
    if (grouped && (changed || connectionChanged || updated.some(Boolean) || !list.childNodes.length)) renderHistory();
  }

  function updateLive() {
    const event = status.latestLive;
    if (event && dialog.open && event.id > seen) {
      seen = event.id;
      try { localStorage.setItem(seenKey, String(seen)); } catch {}
    }
    badge.hidden = !event || event.id <= seen;
    if (event && previousLive !== undefined && event.id > previousLive && !dialog.open) {
      const side = event.direction === 1 ? '做空' : '做多';
      toast.textContent = `${event.symbol} ${event.period.toUpperCase()} · ${event.pattern} ${side} · ${event.price.toFixed(event.digits)}`;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 6500);
    }
    previousLive = event?.id ?? 0;
  }

  async function refresh() {
    if (refreshing || changingWatch || document.hidden) return;
    refreshing = true;
    try {
      const connectedBefore = status?.connected;
      status = await request('status');
      updateLive();
      if (dialog.open) {
        updateWatches();
        await loadPanel(connectedBefore !== status.connected);
      }
    } catch (error) {
      if (dialog.open) statusText(error.message);
    } finally {
      refreshing = false;
    }
  }

  async function setWatch(symbol, enabled) {
    if (!symbol || changingWatch) return;
    changingWatch = true;
    refreshSelection();
    try {
      status = await request('watch', { symbol, enabled: enabled ? '1' : '0' }, 'POST');
      updateWatches();
      statusText(enabled ? `已添加 ${symbol}，正在读取收盘行情。` : `已停止监测 ${symbol}。`);
    } catch (error) {
      statusText(error.message);
    } finally {
      changingWatch = false;
      refreshSelection();
    }
  }

  $('alerts-button').addEventListener('click', () => {
    dialog.showModal();
    if (status) {
      updateLive();
      updateWatches();
    }
    refresh();
  });
  watch.addEventListener('click', () => {
    const symbol = getSymbol();
    setWatch(symbol, !status?.watches.some(item => item.symbol === symbol));
  });
  groupedButton.addEventListener('click', async () => {
    grouped = !grouped;
    groupedButton.setAttribute('aria-pressed', String(grouped));
    renderHistory();
    try { await loadPanel(false); } catch (error) { statusText(error.message); }
  });
  search.addEventListener('input', renderHistory);
  more.addEventListener('click', async () => {
    more.disabled = true;
    if (await loadHistory('', true)) renderHistory();
    if (historyFor('').loadError) statusText(historyFor('').loadError);
    more.disabled = false;
  });
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 5000);
  refresh();
  return { refreshSelection };
}
