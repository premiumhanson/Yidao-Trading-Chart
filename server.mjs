import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createOfflineProvider } from './lib/offline.mjs';
import { createCTraderProvider } from './lib/ctrader.mjs';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/indicators.mjs', ['indicators.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/charts.mjs', ['vendor/lightweight-charts.mjs', 'text/javascript; charset=utf-8']],
]);
const offline = createOfflineProvider();
const ctrader = createCTraderProvider();
const providers = new Map([['offline', offline], ['ctrader', ctrader]]);
const requestedPort = Number(process.env.KUNHOU_PORT || 17651);

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function integer(raw, low, high, label, fallback) {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) fail(400, `${label}必须是整数。`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < low || value > high) fail(400, `${label}超出范围。`);
  return value;
}

async function streamMarket(response, symbol, intervals) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
  });
  response.write(': connected\n\n');
  let cleanup;
  let pendingQuote;
  const send = (event, data) => {
    if (response.destroyed || response.writableEnded || response.writableNeedDrain) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const quoteTimer = setInterval(() => {
    if (!pendingQuote) return;
    send('quote', pendingQuote);
    pendingQuote = undefined;
  }, 125);
  const heartbeat = setInterval(() => {
    if (!response.writableNeedDrain) response.write(': heartbeat\n\n');
  }, 15000);
  response.once('close', () => {
    clearInterval(heartbeat);
    clearInterval(quoteTimer);
    cleanup?.();
  });
  try {
    cleanup = await ctrader.subscribe({
      symbol, intervals,
      onEvent(type, data) {
        if (type === 'quote') {
          pendingQuote = {
            bid: data.bid ?? pendingQuote?.bid ?? null,
            ask: data.ask ?? pendingQuote?.ask ?? null,
            time: data.time,
          };
        } else if (type === 'bar' || type === 'status') send(type, data);
      },
    });
    if (response.destroyed) cleanup();
  } catch (error) {
    send('status', { connected: false, message: error.status ? error.message : '实时行情暂时无法订阅。' });
    if (!response.destroyed) response.end();
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const localHost = `127.0.0.1:${server.address().port}`;
  try {
    if (request.headers.host !== localHost) return json(response, { error: '请使用本机回环地址。' }, 403);
    if (request.method !== 'GET') fail(405, '只接受读取请求。');
    if (request.headers['sec-fetch-site'] === 'cross-site') fail(403, '只接受本应用的请求。');
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) fail(400, '请求路径无效。');
    const url = new URL(request.url, `http://${localHost}`);
    const file = staticFiles.get(url.pathname);
    if (file) {
      const [path, type] = file;
      const body = await readFile(new URL(`./public/${path}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': type });
      response.end(body);
      return;
    }
    if (url.pathname === '/api/status') {
      return json(response, {
        offline: offline.status(),
        ctrader: { configured: ctrader.configured, intervals: ctrader.intervals },
      });
    }
    const provider = providers.get(url.searchParams.get('source') || 'offline');
    if (!provider) fail(400, '数据源无效。');
    if (url.pathname === '/api/source') return json(response, await provider.status());
    if (url.pathname === '/api/symbols') return json(response, await provider.symbols());
    if (url.pathname === '/api/stream') {
      if (provider !== ctrader) fail(400, '当前数据源不提供实时推送。');
      if (!ctrader.configured) fail(503, '请先在本地配置 cTrader Open API。');
      const symbol = url.searchParams.get('symbol');
      const intervals = [...new Set(url.searchParams.getAll('interval'))];
      if (!symbol || symbol.length > 120 || intervals.length > 4 ||
        intervals.some(interval => !ctrader.intervals.includes(interval))) fail(400, '订阅品种或周期无效。');
      await streamMarket(response, symbol, intervals);
      return;
    }
    if (url.pathname === '/api/replay') {
      if (provider !== offline) fail(400, '历史回放仅使用本地行情库。');
      const mode = url.searchParams.get('mode') || 'start';
      if (!['start', 'next', 'previous', 'random'].includes(mode)) fail(400, '回放操作无效。');
      const time = integer(url.searchParams.get('time'), 1, 7258118400, '回放时间');
      if (['next', 'previous'].includes(mode) && time == null) fail(400, '回放需要当前时间。');
      return json(response, offline.replay({ symbol: url.searchParams.get('symbol'), mode, time }));
    }
    if (url.pathname === '/api/bars') {
      const symbol = url.searchParams.get('symbol');
      const interval = url.searchParams.get('interval') || '1h';
      if (!symbol || symbol.length > 120) fail(400, '请选择品种。');
      if (!provider.intervals.includes(interval)) fail(400, '该数据源不支持此周期。');
      const limit = integer(url.searchParams.get('limit'), 1, 1000, 'K 线数量', 500);
      const before = integer(url.searchParams.get('before'), 1, 7258118400, '历史游标');
      return json(response, await provider.bars({ symbol, interval, limit, before }));
    }
    fail(404, '此地址不存在。');
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ?
      error.status : 500;
    json(response, { error: status === 500 ? '本地行情服务暂时无法完成请求。' : error.message }, status);
  }
});

server.on('error', error => {
  console.error(`无法启动看盘服务（${error.code || '启动错误'}）。`);
  process.exitCode = 1;
});
server.listen(requestedPort, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Yidao Trading Chart  ${url}`);
  console.log('关闭此窗口或按 Ctrl+C 停止。');
  if (!process.argv.includes('--open')) return;
  if (process.platform === 'win32') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' });
    browser.on('error', () => console.log('请将上方地址复制到浏览器。'));
  }
});

server.on('close', () => {
  offline.close();
  ctrader.close?.();
});
