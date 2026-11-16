import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCTraderProvider } from '../lib/ctrader.mjs';

const env = {
  CTRADER_CLIENT_ID: 'mock-app',
  CTRADER_CLIENT_SECRET: 'mock-secret',
  CTRADER_ACCESS_TOKEN: 'mock-read-token',
};
const accountId = '9007199254740997';
const symbolId = '42';

function mockCTrader(handlers = {}) {
  const calls = [];
  const sockets = [];

  class MockSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    send(raw) {
      const call = JSON.parse(raw, (key, value, context) => (
        ['ctidTraderAccountId', 'symbolId'].includes(key) && typeof value === 'number'
          ? context.source : value
      ));
      calls.push(call);
      const response = handlers[call.payloadType]?.(call) ?? {
        2100: [2101, {}],
        2149: [2150, { ctidTraderAccount: [
          { ctidTraderAccountId: JSON.rawJSON(accountId), traderLogin: 12345, isLive: false },
          { ctidTraderAccountId: '333', isLive: true },
        ] }],
        2102: [2103, {}],
        2114: [2115, { symbol: [
          { symbolId, symbolName: 'Gold.c', description: 'Spot Gold', enabled: true },
          { symbolId: '43', symbolName: 'Invisible', enabled: false },
        ] }],
        2116: [2117, { symbol: [{ symbolId, digits: 2 }] }],
        2127: [2128, { ctidTraderAccountId: accountId, subscribedSymbolId: [symbolId] }],
        2129: [2130, { ctidTraderAccountId: accountId }],
        2135: [2165, { ctidTraderAccountId: accountId }],
        2136: [2166, { ctidTraderAccountId: accountId }],
        2137: [2138, { trendbar: [] }],
      }[call.payloadType];
      if (response === false) {
        queueMicrotask(() => this.close());
      } else if (response) {
        const [payloadType, payload] = response;
        const data = JSON.stringify({ clientMsgId: call.clientMsgId, payloadType, payload });
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
      }
    }

    spot(payload) {
      const data = JSON.stringify({
        payloadType: 2131,
        payload: { ctidTraderAccountId: JSON.rawJSON(accountId), symbolId, ...payload },
      });
      this.dispatchEvent(new MessageEvent('message', { data }));
    }

    close() {
      if (!this.closed) {
        this.closed = true;
        this.dispatchEvent(new Event('close'));
      }
    }
  }

  return { MockSocket, calls, sockets };
}

test('shares auth, resolves broker symbol IDs and decodes OHLC with exclusive pagination', async (t) => {
  const rawBar = {
    low: '181234567', deltaOpen: '10000', deltaHigh: '23000', deltaClose: '15000', volume: '55',
  };
  const { MockSocket, calls, sockets } = mockCTrader({
    2137: ({ payload }) => {
      assert.equal(payload.ctidTraderAccountId, accountId);
      assert.equal(payload.symbolId, symbolId);
      assert.equal(payload.period, 9);
      assert.equal(payload.count, 3);
      assert.equal(payload.toTimestamp, 1_740_003_599_999);
      return [2138, { trendbar: [29_000_060, 28_999_880, 28_999_940, 29_000_000]
        .map((utcTimestampInMinutes) => ({ ...rawBar, utcTimestampInMinutes })) }];
    },
  });
  const provider = createCTraderProvider(env, MockSocket);
  t.after(() => provider.close());
  const [status, symbols] = await Promise.all([provider.status(), provider.symbols()]);
  assert.equal(status.connected, true);
  assert.equal(sockets[0].url, 'wss://demo.ctraderapi.com:5036');
  assert.equal(sockets.length, 1);
  assert.deepEqual(symbols, [{ id: symbolId, name: 'Gold.c', description: 'Spot Gold', digits: null }]);

  const result = await provider.bars({ symbol: 'gold.C', interval: '1h', limit: 2, before: 1_740_003_600 });
  assert.equal(result.hasMore, true);
  assert.equal(result.digits, 2);
  assert.deepEqual(result.bars.map(({ time }) => time), [1_739_996_400, 1_740_000_000]);
  assert.deepEqual(result.bars[1], {
    time: 1_740_000_000, low: 1812.35, open: 1812.45, high: 1812.58, close: 1812.5, volume: 55,
  });
  assert.equal((await provider.symbols())[0].digits, 2);
  assert.deepEqual(calls.map(({ payloadType }) => payloadType), [2100, 2149, 2102, 2114, 2116, 2137]);
  assert.equal(calls[2].payload.ctidTraderAccountId, accountId);
});

test('selects the correct account by the broker login or by demo/live environment', async (t) => {
  const demo = mockCTrader();
  const provider = createCTraderProvider({ ...env, CTRADER_ACCOUNT_ID: '12345' }, demo.MockSocket);
  t.after(() => provider.close());
  assert.equal((await provider.status()).connected, true);
  assert.equal(demo.calls.at(-1).payload.ctidTraderAccountId, accountId);

  const live = mockCTrader();
  const liveProvider = createCTraderProvider({ ...env, CTRADER_ENV: 'live' }, live.MockSocket);
  t.after(() => liveProvider.close());
  assert.equal((await liveProvider.status()).connected, true);
  assert.equal(live.sockets[0].url, 'wss://live.ctraderapi.com:5036');
  assert.equal(live.calls.at(-1).payload.ctidTraderAccountId, '333');
});

test('reports an unconfigured or mismatched account without exposing credentials', async () => {
  const { MockSocket, calls } = mockCTrader();
  const unconfigured = createCTraderProvider({}, MockSocket);
  assert.equal((await unconfigured.status()).configured, false);
  assert.equal(calls.length, 0);
  const wrongAccount = createCTraderProvider({ ...env, CTRADER_ACCOUNT_ID: '333' }, MockSocket);
  assert.match((await wrongAccount.status()).message, /没有匹配/);
  assert.equal(calls.at(-1).payloadType, 2149);

  const blocked = mockCTrader({
    2149: () => [2142, { errorCode: 'CH_ACCESS_TOKEN_INVALID', description: 'mock-read-token' }],
  });
  const blockedProvider = createCTraderProvider(env, blocked.MockSocket);
  const status = await blockedProvider.status();
  assert.equal(status.connected, false);
  assert.match(status.message, /令牌无效或已过期/);
  assert.doesNotMatch(JSON.stringify(status), /mock-read-token/);
});

test('reconnects and authenticates once when a read is interrupted', async (t) => {
  const { MockSocket, calls, sockets } = mockCTrader({
    2137: () => {
      if (sockets.length === 1) return false;
      return [2138, { trendbar: [] }];
    },
  });
  const provider = createCTraderProvider(env, MockSocket);
  t.after(() => provider.close());
  const result = await provider.bars({ symbol: symbolId, interval: '1m', limit: 8 });
  assert.deepEqual(result, { bars: [], hasMore: false, digits: 2 });
  assert.equal(sockets.length, 2);
  assert.equal(calls.filter(({ payloadType }) => payloadType === 2100).length, 2);
});

async function waitFor(assertion) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return assertion(); } catch (error) {
      if (attempt === 99) throw error;
      await delay(25);
    }
  }
}

test('streams two-sided spots and closed candles, sharing subscriptions and releasing each interval', async (t) => {
  const { MockSocket, calls, sockets } = mockCTrader();
  const provider = createCTraderProvider(env, MockSocket);
  t.after(() => provider.close());
  const first = [];
  const second = [];
  const [stopFirst, stopSecond] = await Promise.all([
    provider.subscribe({ symbol: 'Gold.c', intervals: ['15m', '1h'], onEvent: (...event) => first.push(event) }),
    provider.subscribe({ symbol: symbolId, intervals: ['1h'], onEvent: (...event) => second.push(event) }),
  ]);
  assert.equal(sockets.length, 1);
  assert.deepEqual(calls.map(({ payloadType }) => payloadType), [2100, 2149, 2102, 2114, 2116, 2127, 2135, 2135]);
  const spotCall = calls.find(({ payloadType }) => payloadType === 2127);
  assert.deepEqual(spotCall.payload, { ctidTraderAccountId: accountId, symbolId: [Number(symbolId)], subscribeToSpotTimestamp: true });
  assert.deepEqual(calls.filter(({ payloadType }) => payloadType === 2135).map(({ payload }) => payload.period), [7, 9]);
  assert.ok(first[0][1].connected);
  assert.ok(second[0][1].connected);
  first.length = 0;
  second.length = 0;

  const rawBar = { utcTimestampInMinutes: 29_000_000, low: 181234567, volume: 55,
    deltaOpen: 10000, deltaHigh: 23000, deltaClose: 15000 };
  sockets[0].spot({ bid: '181234567', timestamp: 1_740_000_000_000,
    trendbar: [{ ...rawBar, period: 'M15' }, { ...rawBar, period: 9 }] });
  sockets[0].spot({ ask: '181236000', timestamp: 1_740_000_001_000, trendbar: [{ ...rawBar, period: 7 }] });
  sockets[0].spot({ bid: 1, timestamp: 1_739_999_000_000, trendbar: [{ ...rawBar, period: 7 }] });
  sockets[0].spot({ ctidTraderAccountId: '111', bid: 1, timestamp: 1_740_000_002_000 });
  sockets[0].spot({ symbolId: '999', ask: 1, timestamp: 1_740_000_002_000 });

  const quoteOne = ['quote', { bid: 1812.35, ask: null, time: 1_740_000_000 }];
  const quoteTwo = ['quote', { bid: 1812.35, ask: 1812.36, time: 1_740_000_001 }];
  const bar = { time: 1_740_000_000, low: 1812.35, open: 1812.45, high: 1812.58, close: 1812.5, volume: 55 };
  const m15 = ['bar', { interval: '15m', bar, digits: 2 }];
  const h1 = ['bar', { interval: '1h', bar, digits: 2 }];
  assert.deepEqual(first, [quoteOne, m15, h1, quoteTwo]);
  assert.deepEqual(second, [quoteOne, h1, quoteTwo]);
  stopFirst();
  await waitFor(() => assert.deepEqual(calls.filter(({ payloadType }) => payloadType === 2136).map(({ payload }) => payload.period), [7]));
  assert.equal(calls.some(({ payloadType }) => payloadType === 2129), false);
  stopSecond();
  await waitFor(() => assert.equal(calls.at(-1).payloadType, 2129));
  assert.deepEqual(calls.filter(({ payloadType }) => payloadType === 2136).map(({ payload }) => payload.period), [7, 9]);
});

test('resubscribes with the broker after WebSocket loss and leaves historical refresh available', async (t) => {
  const { MockSocket, calls, sockets } = mockCTrader({
    2135: ({ payload }) => payload.period === 13 ? [2142, { errorCode: 'UNKNOWN_ERROR' }] : [2165, {}],
  });
  const provider = createCTraderProvider(env, MockSocket);
  t.after(() => provider.close());
  const events = [];
  const cleanup = await provider.subscribe({
    symbol: symbolId, intervals: ['15m', '1w'], onEvent: (...event) => events.push(event),
  });
  t.after(cleanup);
  assert.match(events.at(-1)[1].message, /部分周期/);
  sockets[0].close();
  assert.equal(events.at(-1)[1].connected, false);
  await waitFor(() => assert.equal(events.at(-1)[1].connected, true));
  assert.equal(sockets.length, 2);
  assert.equal(calls.filter(({ payloadType }) => payloadType === 2127).length, 2);
  sockets[1].spot({ ask: 181236000 });
  assert.deepEqual(events.at(-1), ['quote', { bid: null, ask: 1812.36, time: null }]);
  assert.deepEqual(await provider.bars({ symbol: symbolId, interval: '1w' }), { bars: [], hasMore: false, digits: 2 });
});

test('guides users to generate an accounts token if the app was granted trade scope', async (t) => {
  const { MockSocket, calls } = mockCTrader({ 2149: () => [2150, { permissionScope: 'SCOPE_TRADE' }] });
  const provider = createCTraderProvider(env, MockSocket);
  t.after(() => provider.close());
  const status = await provider.status();
  assert.equal(status.connected, false);
  assert.match(status.message, /accounts/);
  assert.deepEqual(calls.map(({ payloadType }) => payloadType), [2100, 2149]);
});
