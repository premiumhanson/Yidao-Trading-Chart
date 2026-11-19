import { createHash } from 'node:crypto';
import WebSocket from './vendor/ws/index.js';

const intervals = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '1w', '1mo'];
const bridgePath = '/api/bridge/ctrader-local';
const protocolVersion = 1;
const limitSymbols = 3000;

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function validBar(bar) {
  return bar && Number.isSafeInteger(bar.time) && bar.time > 0 &&
    [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) &&
    bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close);
}

function validDigits(value) {
  return Number.isInteger(value) && value >= 0 && value <= 20;
}

export function createLocalCTraderProvider() {
  const websocket = new WebSocket.WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const requests = new Map();
  const watchers = new Set();
  let connection;
  let catalog;
  let preferredSymbol;
  let sourceKey;
  let nextId = 0;

  const status = () => ({
    configured: true, connected: Boolean(catalog), intervals, preferredSymbol,
    message: catalog ? 'cTrader 本地桥已连接' : '请在 cTrader 本地启动 YidaoFeed，再点重试。',
  });

  function send(message) {
    const socket = connection;
    if (socket?.readyState !== 1) return false;
    socket.send(JSON.stringify(message), failure => {
      if (failure) socket.terminate();
    });
    return true;
  }

  function shareStatus() {
    const current = status();
    for (const watcher of watchers) watcher.onEvent('status', current);
  }

  function updateSubscriptions() {
    if (!catalog) return;
    const groups = new Map();
    for (const watcher of watchers) {
      if (!catalog.has(watcher.symbol)) continue;
      if (!groups.has(watcher.symbol)) groups.set(watcher.symbol, new Set());
      for (const interval of watcher.intervals) groups.get(watcher.symbol).add(interval);
    }
    send({
      type: 'watch',
      subscriptions: [...groups].map(([symbol, current]) => ({ symbol, intervals: [...current] })),
    });
  }

  function settle(id, failure, result) {
    const task = requests.get(id);
    if (!task) return;
    clearTimeout(task.timer);
    requests.delete(id);
    if (failure) task.reject(failure);
    else task.resolve(result);
  }

  function acceptEvent(event) {
    if (!catalog.has(event?.symbol)) return;
    const { symbol, type, interval, bar, digits, bid, ask, time } = event;
    if (type === 'quote' && [bid, ask, time].every(Number.isFinite)) {
      for (const target of watchers) {
        if (target.symbol === symbol) target.onEvent(type, { bid, ask, time });
      }
    } else if (['bar', 'preview'].includes(type) && intervals.includes(interval) && validBar(bar) && validDigits(digits)) {
      catalog.get(symbol).digits = digits;
      for (const target of watchers) {
        if (target.symbol === symbol && target.intervals.has(interval)) target.onEvent(type, { interval, bar, digits });
      }
    }
  }

  function receive(socket, raw, isBinary) {
    if (isBinary) return socket.close(1003);
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { return socket.close(1007); }
    if (!catalog) {
      if (message?.type !== 'hello' || message.version !== protocolVersion ||
        !Array.isArray(message.symbols) || !message.symbols.length ||
        message.symbols.length > limitSymbols ||
        !message.symbols.every(name => typeof name === 'string' && name.length > 0 && name.length <= 120)) {
        return socket.close(1008);
      }
      catalog = new Map(message.symbols.map(name => [name, { id: name, name, description: '', digits: null }]));
      preferredSymbol = catalog.has(message.currentSymbol) ? message.currentSymbol : undefined;
      sourceKey = createHash('sha256').update(JSON.stringify([...catalog.keys()].sort())).digest('hex');
      shareStatus();
      updateSubscriptions();
      return;
    }
    if (message?.type === 'batch' && Array.isArray(message.events) && message.events.length <= 512) {
      for (const event of message.events) acceptEvent(event);
      return;
    }
    if (message?.type !== 'result') return;
    const task = requests.get(message.id);
    if (!task) return;
    if (message.error) return settle(message.id, error(502, 'cTrader 终端无法读取该品种的这个周期。'));
    const { bars, digits, hasMore } = message;
    if (!validDigits(digits) || !Array.isArray(bars) || bars.length > task.limit ||
        bars.some((bar, i) => !validBar(bar) || (i > 0 && bars[i - 1].time >= bar.time) ||
          (task.before != null && bar.time >= task.before))) {
      return settle(message.id, error(502, 'cTrader 本地桥返回的 K 线格式不符。'));
    }
    catalog.get(task.symbol).digits = digits;
    settle(message.id, null, { bars, digits, hasMore: Boolean(hasMore) });
  }

  function accept(socket) {
    connection = socket;
    const helloTimeout = setTimeout(() => { if (!catalog) socket.terminate(); }, 3000);
    // YidaoFeed uses a two-second WebSocket operation timeout. A text message
    // also reaches its receive loop while the browser isn't requesting bars.
    const keepAlive = setInterval(() => {
      if (catalog && socket.bufferedAmount === 0) send({ type: 'heartbeat' });
    }, 750);
    socket.on('message', (raw, binary) => receive(socket, raw, binary));
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(helloTimeout);
      clearInterval(keepAlive);
      if (connection !== socket) return;
      connection = undefined;
      catalog = undefined;
      preferredSymbol = undefined;
      sourceKey = undefined;
      for (const id of requests.keys()) settle(id, error(503, 'cTrader 本地桥已断开。'));
      shareStatus();
    });
  }

  return {
    label: 'cTrader 本地',
    configured: true,
    intervals,
    status,
    feedKey: () => sourceKey,
    attach(server) {
      server.on('upgrade', (request, socket, head) => {
        if (request.url !== bridgePath || request.headers.host !== `127.0.0.1:${server.address().port}` ||
          request.headers.origin !== undefined || connection) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        websocket.handleUpgrade(request, socket, head, accept);
      });
    },
    symbols() {
      if (!catalog) throw error(503, status().message);
      return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    bars({ symbol, interval, limit, before }) {
      if (!catalog) throw error(503, status().message);
      if (!catalog.has(symbol)) throw error(404, 'cTrader 终端没有这个品种。');
      if (requests.size >= 24) throw error(429, 'cTrader 正在读取历史，请稍后重试。');
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(id, error(504, 'cTrader 读取历史超时，请稍后重试。')), 20000);
        requests.set(id, { resolve, reject, timer, symbol, limit, before });
        if (!send({ type: 'bars', id, symbol, interval, limit, before: before ?? null })) {
          settle(id, error(503, 'cTrader 本地桥已断开。'));
        }
      });
    },
    async subscribe({ symbol, intervals: periods, onEvent }) {
      if (!catalog) throw error(503, status().message);
      if (!catalog.has(symbol)) throw error(404, 'cTrader 终端没有这个品种。');
      if (watchers.size >= 16) throw error(429, '实时订阅过多，请关闭其他看盘标签页。');
      const watcher = { symbol, intervals: new Set(periods), onEvent };
      watchers.add(watcher);
      updateSubscriptions();
      onEvent('status', status());
      return () => {
        watchers.delete(watcher);
        updateSubscriptions();
      };
    },
    close() {
      connection?.terminate();
      websocket.close();
    },
  };
}
