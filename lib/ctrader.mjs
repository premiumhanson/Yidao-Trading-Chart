import { setTimeout as delay } from 'node:timers/promises';

const periods = Object.freeze({
  '1m': 1, '2m': 2, '3m': 3, '4m': 4, '5m': 5, '10m': 6, '15m': 7,
  '30m': 8, '1h': 9, '4h': 10, '12h': 11, '1d': 12, '1w': 13, '1mo': 14,
});
const intervals = Object.freeze(Object.keys(periods));
const message = Object.freeze({
  heartbeat: 51,
  errors: [50, 2142],
  disconnected: [2148, 2164],
  tokenInvalidated: 2147,
  appAuth: [2100, 2101],
  accounts: [2149, 2150],
  accountAuth: [2102, 2103],
  symbols: [2114, 2115],
  symbolDetails: [2116, 2117],
  subscribeSpots: [2127, 2128],
  unsubscribeSpots: [2129, 2130],
  spot: 2131,
  subscribeTrendbar: [2135, 2165],
  unsubscribeTrendbar: [2136, 2166],
  trendbars: [2137, 2138],
});
const periodByCode = new Map(Object.entries(periods).map(([interval, code]) => [code, interval]));
const periodByName = new Map([
  ['M1', '1m'], ['M2', '2m'], ['M3', '3m'], ['M4', '4m'], ['M5', '5m'], ['M10', '10m'], ['M15', '15m'],
  ['M30', '30m'], ['H1', '1h'], ['H4', '4h'], ['H12', '12h'], ['D1', '1d'], ['W1', '1w'], ['MN1', '1mo'],
]);
const responseTimeoutMs = 10_000;
const lastTimestampMs = 2_147_483_646_000;

class CTraderError extends Error {
  constructor(message, status = 502, providerCode = undefined) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.providerCode = providerCode;
  }
}

class ConnectionError extends CTraderError {}

function idFrom(value) {
  const id = String(value ?? '');
  return /^[1-9]\d{0,18}$/.test(id) ? id : null;
}

function readFrame(data) {
  // Preserve unquoted 64-bit IDs before JavaScript's Number rounding.
  return JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
    (key, value, context) => {
      if (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context.source)) {
        return context.source;
      }
      return value;
    });
}

const providerMessages = new Map([
  ['CH_CLIENT_AUTH_FAILURE', 'cTrader 应用认证失败，请核对 Client ID 和 Client Secret。'],
  ['CH_CLIENT_NOT_AUTHENTICATED', 'cTrader 应用认证失败，请核对 Client ID 和 Client Secret。'],
  ['CH_ACCESS_TOKEN_INVALID', 'cTrader 令牌无效或已过期，请重新生成 Access Token。'],
  ['OA_AUTH_TOKEN_EXPIRED', 'cTrader 令牌已过期，请重新生成 Access Token。'],
  ['INVALID_ACCESS_TOKEN', 'cTrader 令牌无效或已过期，请重新生成 Access Token。'],
  ['CH_CTID_TRADER_ACCOUNT_NOT_FOUND', 'cTrader 未找到获授权的账户，请核对账户与环境。'],
  ['ACCOUNT_NOT_AUTHORIZED', 'cTrader 账户未授权，请重新生成已授权该账户的 Access Token。'],
  ['REQUEST_FREQUENCY_EXCEEDED', 'cTrader 行情请求过于频繁，请稍后重试。'],
  ['MARKET_CLOSED', 'cTrader 报告该品种当前休市。'],
]);

function apiError(code) {
  const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code : undefined;
  return new CTraderError(
    providerMessages.get(safeCode) ?? 'cTrader 拒绝了行情或认证请求，请核对账户配置后重试。',
    502, safeCode,
  );
}

function openChannel(url, WebSocketType, { onSpot, onClose }) {
  const socket = new WebSocketType(url);
  socket.binaryType = 'arraybuffer';
  const pending = new Map();
  let nextId = 0;
  let heartbeat;
  let terminalError;
  let openResolve;
  let openReject;
  const ready = new Promise((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });
  const connectTimeout = setTimeout(() => {
    stop(new ConnectionError('连接 cTrader 超时，请检查到 Open API 的网络连接。'));
  }, responseTimeoutMs);

  function stop(error) {
    if (terminalError) return;
    terminalError = error;
    clearTimeout(connectTimeout);
    clearInterval(heartbeat);
    openReject(error);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    socket.close();
    onClose(error);
  }

  function send(frame) {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      stop(new ConnectionError('cTrader 行情连接已断开。'));
    }
  }

  socket.addEventListener('open', () => {
    if (terminalError) return;
    clearTimeout(connectTimeout);
    heartbeat = setInterval(() => {
      send({ clientMsgId: String(++nextId), payloadType: message.heartbeat, payload: {} });
    }, 9_000);
    heartbeat.unref();
    openResolve();
  });
  socket.addEventListener('error', () => {
    stop(new ConnectionError('无法连接 cTrader Open API，请检查网络和 5036 端口。'));
  });
  socket.addEventListener('close', () => {
    stop(new ConnectionError('cTrader 行情连接已断开。'));
  });
  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = readFrame(event.data);
    } catch {
      stop(new CTraderError('cTrader 返回了无效的协议消息。'));
      return;
    }

    const { clientMsgId, payloadType, payload } = frame ?? {};
    if (payloadType === message.tokenInvalidated) {
      stop(new CTraderError('cTrader 令牌已失效，请重新生成 Access Token。', 401));
      return;
    }
    if (message.disconnected.includes(payloadType)) {
      stop(new ConnectionError('cTrader 已结束行情会话。'));
      return;
    }
    if (payloadType === message.spot) {
      onSpot(payload);
      return;
    }
    const request = pending.get(clientMsgId);
    if (!request) return;
    if (payloadType === request.expected || message.errors.includes(payloadType)) {
      pending.delete(clientMsgId);
      clearTimeout(request.timeout);
      if (payloadType === request.expected) request.resolve(payload ?? {});
      else request.reject(apiError(payload?.errorCode));
    }
  });

  return {
    ready,
    get closed() { return Boolean(terminalError); },
    close: () => stop(new ConnectionError('cTrader 行情连接已关闭。')),
    request([payloadType, expected], payload) {
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const clientMsgId = String(++nextId);
        const timeout = setTimeout(() => {
          stop(new ConnectionError('等待 cTrader 响应超时。'));
        }, responseTimeoutMs);
        pending.set(clientMsgId, { expected, resolve, reject, timeout });
        send({ clientMsgId, payloadType, payload });
      });
    },
  };
}

function decodeBar(bar, digits) {
  const time = Number(bar.utcTimestampInMinutes) * 60;
  const relativeLow = Number(bar.low ?? 0);
  const deltaOpen = Number(bar.deltaOpen ?? 0);
  const deltaHigh = Number(bar.deltaHigh ?? 0);
  const deltaClose = Number(bar.deltaClose ?? 0);
  const volume = Number(bar.volume);
  if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(volume) || volume < 0
    || ![relativeLow, deltaOpen, deltaHigh, deltaClose].every(Number.isSafeInteger)
    || deltaOpen < 0 || deltaClose < 0 || deltaHigh < Math.max(deltaOpen, deltaClose)) {
    throw new CTraderError('cTrader 返回了格式异常的 K 线。');
  }
  const price = (delta) => Number(((relativeLow + delta) / 100_000).toFixed(digits));
  return { time, open: price(deltaOpen), high: price(deltaHigh), low: price(0), close: price(deltaClose), volume };
}

function roundedQuote(value, digits) {
  if (value == null || value === '') return null;
  const raw = Number(value);
  return Number.isSafeInteger(raw) && raw >= 0 ? Number((raw / 100_000).toFixed(digits)) : null;
}

function quoteTime(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return timestamp > 100_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
}

function publish(watcher, name, data) {
  try { watcher.onEvent(name, data); }
  catch { /* A disconnected local client cannot interrupt the market feed. */ }
}

function publishStatus(record, connected, message) {
  const status = { connected, message };
  for (const watcher of record.watchers) {
    if (watcher.status?.connected === connected && watcher.status.message === message) continue;
    watcher.status = status;
    publish(watcher, 'status', status);
  }
}

export function createCTraderProvider(env = process.env, WebSocketType = globalThis.WebSocket) {
  const clientId = env.CTRADER_CLIENT_ID?.trim();
  const clientSecret = env.CTRADER_CLIENT_SECRET?.trim();
  const accessToken = env.CTRADER_ACCESS_TOKEN?.trim();
  const environment = env.CTRADER_ENV?.trim().toLowerCase() || 'demo';
  const accountSetting = env.CTRADER_ACCOUNT_ID?.trim();
  const configured = Boolean(clientId && clientSecret && accessToken);
  const label = 'cTrader Open API';
  let activeChannel;
  let sessionPromise;
  let historyQueue = Promise.resolve();
  let nextHistoryAt = 0;
  const streams = new Map();
  let streamQueue = Promise.resolve();
  let reconnectTimer;
  let retryDelay = 1_000;
  let stopped = false;

  function enqueueStream(task) {
    const pending = streamQueue.then(task);
    streamQueue = pending.catch(() => {});
    return pending;
  }

  function handleSpot(channel, payload) {
    const record = streams.get(idFrom(payload?.symbolId));
    if (!record?.watchers.size || record.channel !== channel
      || idFrom(payload.ctidTraderAccountId) !== record.accountId) return;

    const bid = roundedQuote(payload.bid, record.digits);
    const ask = roundedQuote(payload.ask, record.digits);
    const time = quoteTime(payload.timestamp);
    if ((bid !== null || ask !== null) && !(time != null && time < record.latestQuoteAt)) {
      const quote = { bid: bid ?? record.quote?.bid ?? null, ask: ask ?? record.quote?.ask ?? null, time };
      record.quote = quote;
      if (time != null) record.latestQuoteAt = time;
      for (const watcher of record.watchers) publish(watcher, 'quote', quote);
    }
    if (!Array.isArray(payload.trendbar)) return;
    for (const raw of payload.trendbar) {
      const interval = periodByName.get(raw?.period) ?? periodByCode.get(Number(raw?.period ?? 1));
      if (!interval || !record.periods.has(interval)) continue;
      let bar;
      try { bar = decodeBar(raw, record.digits); }
      catch { continue; }
      const previous = record.bars.get(interval);
      if (previous && (bar.time < previous.time || Object.keys(bar).every((key) => bar[key] === previous[key]))) continue;
      record.bars.set(interval, bar);
      for (const watcher of record.watchers) {
        if (watcher.intervals.has(interval)) publish(watcher, 'bar', { interval, bar, digits: record.digits });
      }
    }
  }

  function retryStreams() {
    if (stopped || reconnectTimer || ![...streams.values()].some((record) => record.watchers.size)) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      enqueueStream(async () => {
        if (stopped) return;
        const subscribed = [...streams.values()].filter((record) => record.watchers.size);
        if (!subscribed.length) return;
        const session = await getSession();
        for (const record of subscribed) {
          try { await reconcile(record, session); }
          catch (error) {
            if (error instanceof ConnectionError) throw error;
            publishStatus(record, false, error instanceof CTraderError ? error.message : 'cTrader 行情订阅失败。');
          }
        }
        retryDelay = 1_000;
      }).catch((error) => {
        for (const record of streams.values()) {
          publishStatus(record, false, error instanceof CTraderError ? error.message : 'cTrader 行情连接失败。');
        }
        if (error instanceof ConnectionError) retryStreams();
      });
    }, retryDelay);
    reconnectTimer.unref();
    retryDelay = Math.min(20_000, retryDelay * 2);
  }

  function streamDisconnected(channel, error) {
    if (stopped || activeChannel !== channel) return;
    for (const record of streams.values()) {
      if (record.channel === channel) publishStatus(record, false, error.message);
    }
    if (error instanceof ConnectionError) retryStreams();
  }

  function enqueueHistory(task) {
    const queued = historyQueue.then(async () => {
      await delay(Math.max(0, nextHistoryAt - performance.now()));
      nextHistoryAt = performance.now() + 210;
      return task();
    });
    historyQueue = queued.catch(() => {});
    return queued;
  }

  async function connect() {
    if (stopped) throw new CTraderError('cTrader 行情连接已关闭。', 503);
    if (!configured) throw new CTraderError('请在 .env.local 填写 cTrader Open API 凭证。', 503);
    if (!['demo', 'live'].includes(environment)) {
      throw new CTraderError('CTRADER_ENV 应填写 demo 或 live。', 503);
    }

    const channel = openChannel('wss://' + environment + '.ctraderapi.com:5036', WebSocketType, {
      onSpot: (payload) => handleSpot(channel, payload),
      onClose: (error) => streamDisconnected(channel, error),
    });
    activeChannel = channel;
    try {
      await channel.ready;
      await channel.request(message.appAuth, { clientId, clientSecret });
      const response = await channel.request(message.accounts, { accessToken });
      if ([1, '1', 'SCOPE_TRADE'].includes(response.permissionScope)) {
        throw new CTraderError('请在 cTrader Playground 选择 accounts 权限并重新生成只读 Access Token。', 403);
      }
      const available = (response.ctidTraderAccount ?? [])
        .filter((account) => (account.isLive === true) === (environment === 'live'));
      const exact = available.find((item) => idFrom(item.ctidTraderAccountId) === accountSetting);
      const matching = accountSetting
        ? available.filter((item) => idFrom(item.traderLogin) === accountSetting)
        : available;
      if (!exact && matching.length > 1) {
        throw new CTraderError('当前有多个匹配账户，请将 CTRADER_ACCOUNT_ID 设为所选账户的 ctidTraderAccountId。', 503);
      }
      const accountId = idFrom((exact ?? matching[0])?.ctidTraderAccountId);
      if (!accountId) throw new CTraderError('这个 demo/live 环境没有匹配的获授权 cTrader 账户。', 503);
      const ctidTraderAccountId = JSON.rawJSON(accountId);
      await channel.request(message.accountAuth, { ctidTraderAccountId, accessToken });
      return { channel, accountId, ctidTraderAccountId, catalog: undefined, details: new Map() };
    } catch (error) {
      channel.close();
      throw error;
    }
  }

  async function getSession() {
    if (!sessionPromise) {
      sessionPromise = connect().catch((error) => {
        sessionPromise = undefined;
        throw error;
      });
    }
    const connecting = sessionPromise;
    const session = await connecting;
    if (session.channel.closed) {
      if (sessionPromise === connecting) sessionPromise = undefined;
      return getSession();
    }
    return session;
  }

  async function run(action) {
    const session = await getSession();
    try {
      return await action(session);
    } catch (error) {
      if (!(error instanceof ConnectionError)) throw error;
      return action(await getSession());
    }
  }

  async function getSymbols(session) {
    if (!session.catalog) {
      session.catalog = session.channel.request(message.symbols, {
        ctidTraderAccountId: session.ctidTraderAccountId, includeArchivedSymbols: false,
      }).then((payload) => (payload.symbol ?? [])
        .filter((entry) => entry.enabled !== false && typeof entry.symbolName === 'string' && idFrom(entry.symbolId))
        .map((entry) => ({ id: idFrom(entry.symbolId), name: entry.symbolName, description: String(entry.description ?? '') }))
        .sort((a, b) => a.name.localeCompare(b.name)))
        .catch((error) => {
          session.catalog = undefined;
          throw error;
        });
    }
    return session.catalog;
  }

  async function getDigits(session, id) {
    if (!session.details.has(id)) {
      const detail = { digits: null };
      detail.ready = session.channel.request(message.symbolDetails, {
        ctidTraderAccountId: session.ctidTraderAccountId, symbolId: [JSON.rawJSON(id)],
      }).then((payload) => {
        const rawDigits = payload.symbol?.find((entry) => idFrom(entry.symbolId) === id)?.digits;
        const digits = Number(rawDigits ?? NaN);
        if (!Number.isInteger(digits) || digits < 0 || digits > 20) {
          throw new CTraderError('cTrader 未返回该品种的价格精度。');
        }
        detail.digits = digits;
        return digits;
      }).catch((error) => {
        session.details.delete(id);
        throw error;
      });
      session.details.set(id, detail);
    }
    return session.details.get(id).ready;
  }

  async function resolveSymbol(session, symbol) {
    const catalog = await getSymbols(session);
    const requested = String(symbol).trim();
    const entry = catalog.find((item) => item.id === requested)
      ?? catalog.find((item) => item.name.toUpperCase() === requested.toUpperCase());
    if (!entry) throw new CTraderError('当前 cTrader 帐户未提供该品种。', 404);
    return entry;
  }

  async function reconcile(record, session) {
    const { channel, accountId, ctidTraderAccountId } = session;
    if (record.channel !== channel) {
      record.channel = channel;
      record.accountId = accountId;
      record.spots = false;
      record.periods.clear();
      record.rejected.clear();
      record.quote = null;
      record.latestQuoteAt = undefined;
      record.bars.clear();
    }
    const desired = new Set([...record.watchers].flatMap((watcher) => [...watcher.intervals]));
    const spots = { ctidTraderAccountId, symbolId: [JSON.rawJSON(record.id)] };
    const trendbar = { ctidTraderAccountId, symbolId: JSON.rawJSON(record.id) };
    for (const interval of record.periods) {
      if (desired.has(interval)) continue;
      await channel.request(message.unsubscribeTrendbar, { ...trendbar, period: periods[interval] });
      record.periods.delete(interval);
      record.bars.delete(interval);
    }
    if (!record.watchers.size) {
      if (record.spots) await channel.request(message.unsubscribeSpots, spots);
      record.spots = false;
      if (!record.watchers.size && streams.get(record.id) === record) streams.delete(record.id);
      return;
    }
    if (!record.spots) {
      record.digits = await getDigits(session, record.id);
      const result = await channel.request(message.subscribeSpots, { ...spots, subscribeToSpotTimestamp: true });
      if (Array.isArray(result.subscribedSymbolId)
        && !result.subscribedSymbolId.some((value) => idFrom(value) === record.id)) {
        throw new CTraderError('当前账户未获该品种的实时买卖价。');
      }
      record.spots = true;
    }
    for (const interval of desired) {
      if (record.periods.has(interval) || record.rejected.has(interval)) continue;
      // The first event can arrive along with the acknowledgement.
      record.periods.add(interval);
      try { await channel.request(message.subscribeTrendbar, { ...trendbar, period: periods[interval] }); }
      catch (error) {
        record.periods.delete(interval);
        if (error instanceof ConnectionError) throw error;
        record.rejected.add(interval);
      }
    }
    publishStatus(record, true, [...record.rejected].some((interval) => desired.has(interval))
      ? '实时买卖价已订阅，部分周期使用历史刷新。' : '实时买卖价和已收盘 K 线已订阅。');
  }

  return {
    configured,
    intervals,
    label,
    close() {
      stopped = true;
      clearTimeout(reconnectTimer);
      streams.clear();
      activeChannel?.close();
    },
    async status() {
      try {
        await getSession();
        return { configured, connected: true, environment, intervals, message: 'cTrader 已连接。' };
      } catch (error) {
        const message = error instanceof CTraderError ? error.message : 'cTrader 连接失败。';
        return { configured, connected: false, environment, intervals, message };
      }
    },
    async symbols() {
      return run(async (session) => {
        const catalog = await getSymbols(session);
        return catalog.map((entry) => ({ ...entry, digits: session.details.get(entry.id)?.digits ?? null }));
      });
    },
    async subscribe({ symbol, intervals: requestedIntervals, onEvent }) {
      if (!Array.isArray(requestedIntervals) || requestedIntervals.some((interval) => !Object.hasOwn(periods, interval))
        || typeof onEvent !== 'function') throw new CTraderError('cTrader 行情订阅参数无效。', 400);
      const entry = await run((session) => resolveSymbol(session, symbol));
      if (stopped) throw new CTraderError('cTrader 行情连接已关闭。', 503);
      let record = streams.get(entry.id);
      if (!record) {
        record = { id: entry.id, watchers: new Set(), periods: new Set(), rejected: new Set(), bars: new Map() };
        streams.set(entry.id, record);
      }
      const watcher = { intervals: new Set(requestedIntervals), onEvent };
      record.watchers.add(watcher);
      const cleanup = () => {
        if (!record.watchers.delete(watcher) || stopped) return;
        void enqueueStream(async () => {
          if (streams.get(record.id) !== record) return;
          if (!record.watchers.size && record.channel?.closed !== false) {
            streams.delete(record.id);
          } else {
            await reconcile(record, await getSession());
          }
        }).catch(() => {
          if (!record.watchers.size && streams.get(record.id) === record) streams.delete(record.id);
        });
      };
      try {
        const previousQuote = record.quote;
        await enqueueStream(async () => reconcile(record, await getSession()));
        if (previousQuote && previousQuote === record.quote) publish(watcher, 'quote', previousQuote);
        return cleanup;
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    async bars({ symbol, interval, limit = 400, before }) {
      if (!Object.hasOwn(periods, interval)) throw new CTraderError('cTrader 不支持该 K 线周期。', 400);
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
        throw new CTraderError('cTrader 每页 K 线数应为 1 至 5000 的整数。', 400);
      }
      const beforeTime = before == null ? null : Number(before);
      if (beforeTime != null && (!Number.isSafeInteger(beforeTime) || beforeTime < 0)) {
        throw new CTraderError('K 线分页时间应为 UTC Unix 秒数。', 400);
      }

      return run(async (session) => {
        const entry = await resolveSymbol(session, symbol);
        const digits = await getDigits(session, entry.id);
        const upperLimit = beforeTime == null ? Date.now() : beforeTime * 1000 - 1;
        if (upperLimit < 0) return { bars: [], hasMore: false, digits };

        const payload = await enqueueHistory(() => session.channel.request(message.trendbars, {
          ctidTraderAccountId: session.ctidTraderAccountId,
          symbolId: JSON.rawJSON(entry.id),
          period: periods[interval],
          toTimestamp: Math.min(upperLimit, lastTimestampMs),
          count: limit + 1,
        }));
        const byTime = new Map();
        for (const raw of payload.trendbar ?? []) {
          const bar = decodeBar(raw, digits);
          if (beforeTime == null || bar.time < beforeTime) byTime.set(bar.time, bar);
        }
        const rows = [...byTime.values()].sort((a, b) => a.time - b.time);
        return {
          bars: rows.slice(-limit),
          hasMore: rows.length > limit || (rows.length > 0 && payload.hasMore === true),
          digits,
        };
      });
    },
  };
}
