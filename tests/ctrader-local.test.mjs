import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from '../lib/vendor/ws/index.js';

test('local cBot serves history, live quotes and open candles through Yidao', { timeout: 15000 }, async t => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.mjs'], {
    cwd, env: { ...process.env, KUNHOU_PORT: '0', YIDAO_ALERT_DB: ':memory:' },
  });
  t.after(() => server.kill());
  server.stderr.resume();
  const address = await new Promise((resolve, reject) => {
    server.on('exit', code => reject(new Error('Yidao exited: ' + code)));
    server.on('error', reject);
    server.stdout.on('data', chunk => {
      const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (url) resolve(url);
    });
  });
  const endpoint = path => new URL(path, address);
  const get = async path => (await fetch(endpoint(path))).json();
  const providerPath = 'api/source?source=ctrader-local';
  assert.equal((await get(providerPath)).connected, false);

  const url = endpoint('api/bridge/ctrader-local');
  url.protocol = 'ws:';
  const socket = new WebSocket(url);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const candle = { time: 1794915000, open: 1.1001, high: 1.102, low: 1.1, close: 1.1008, volume: 33 };
  const send = data => socket.send(JSON.stringify(data));
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'bars') {
      assert.equal(message.symbol, 'EURUSD');
      assert.equal(message.interval, '15m');
      assert.equal(message.before, candle.time + 900);
      send({ type: 'result', id: message.id, bars: [candle], digits: 5, hasMore: false });
    }
    if (message.type === 'watch' && message.subscriptions.length) {
      assert.deepEqual(message.subscriptions, [{ symbol: 'EURUSD', intervals: ['15m'] }]);
      send({
        type: 'batch',
        events: [
          { type: 'quote', symbol: 'EURUSD', bid: 1.101, ask: 1.1011, time: candle.time + 901 },
          { type: 'preview', symbol: 'EURUSD', interval: '15m', digits: 5, bar: { ...candle, time: candle.time + 900 } },
        ],
      });
    }
  });
  send({ type: 'hello', version: 1, currentSymbol: 'EURUSD', symbols: ['EURUSD', 'XAUUSD'] });
  const instruments = await get('api/symbols?source=ctrader-local');
  assert.deepEqual(instruments.map(item => item.name), ['EURUSD', 'XAUUSD']);
  const history = await get(`api/bars?source=ctrader-local&symbol=EURUSD&interval=15m&limit=1&before=${candle.time + 900}`);
  assert.deepEqual(history, { bars: [candle], digits: 5, hasMore: false });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const sse = await fetch(endpoint('api/stream?source=ctrader-local&symbol=EURUSD&interval=15m'), {
    signal: abort.signal,
  });
  const reader = sse.body.pipeThrough(new TextDecoderStream()).getReader();
  let feed = '';
  while (!feed.includes('event: quote') || !feed.includes('event: preview')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    feed += value;
  }
  assert.match(feed, /"bid":1\.101/);
  assert.match(feed, /"interval":"15m"/);
  socket.close();
  while (!feed.includes('"connected":false')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    feed += value;
  }
  await reader.cancel();
});
