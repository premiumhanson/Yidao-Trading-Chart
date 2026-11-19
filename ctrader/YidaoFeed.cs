using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class YidaoFeed : Robot
    {
        private static readonly Dictionary<string, TimeFrame> Periods = new Dictionary<string, TimeFrame>
        {
            ["1m"] = TimeFrame.Minute, ["5m"] = TimeFrame.Minute5, ["15m"] = TimeFrame.Minute15,
            ["30m"] = TimeFrame.Minute30, ["1h"] = TimeFrame.Hour, ["2h"] = TimeFrame.Hour2,
            ["4h"] = TimeFrame.Hour4, ["8h"] = TimeFrame.Hour8, ["12h"] = TimeFrame.Hour12,
            ["1d"] = TimeFrame.Daily, ["1w"] = TimeFrame.Weekly, ["1mo"] = TimeFrame.Monthly
        };

        private sealed class WatchedSymbol
        {
            public Symbol Symbol;
            public bool Dirty = true;
            public long QuoteTime;
            public double Bid;
            public double Ask;
            public Dictionary<string, Bars> Frames = new Dictionary<string, Bars>();
            public Dictionary<string, long> LastPreview = new Dictionary<string, long>();
        }

        private readonly Dictionary<string, WatchedSymbol> _watched = new Dictionary<string, WatchedSymbol>();
        private WebSocketClient _socket;
        private bool _announced;
        private bool _waitingMessage;
        private DateTime _retryAt;

        [Parameter("Yidao port", DefaultValue = 17651, MinValue = 1, MaxValue = 65535)]
        public int Port { get; set; }

        protected override void OnStart()
        {
            if (RunningMode != RunningMode.RealTime)
            {
                Print("Run YidaoFeed as a local instance.");
                Stop();
                return;
            }
            Timer.Start(TimeSpan.FromMilliseconds(250));
            OnTimer();
        }

        protected override void OnTimer()
        {
            try
            {
                if (_socket == null || _socket.State != WebSocketClientState.Open)
                {
                    if (_socket?.State == WebSocketClientState.Connecting || DateTime.UtcNow < _retryAt)
                        return;
                    Reconnect();
                    if (_socket.State != WebSocketClientState.Open)
                        return;
                }
                if (!_announced)
                {
                    var names = Enumerable.Range(0, Math.Min(Symbols.Count, 3000)).Select(i => Symbols[i]).ToList();
                    if (!names.Contains(SymbolName))
                        names.Insert(0, SymbolName);
                    Send(new { type = "hello", version = 1, currentSymbol = SymbolName, symbols = names.Take(3000) });
                    _announced = true;
                    _waitingMessage = false;
                    Print("Yidao local feed connected on port {0}.", Port);
                }
                PublishMarket();
            }
            catch (Exception)
            {
                ResetSocket();
                if (!_waitingMessage)
                {
                    Print("Waiting for Yidao Trading Chart on port {0}.", Port);
                    _waitingMessage = true;
                }
            }
        }

        private void Reconnect()
        {
            _retryAt = DateTime.UtcNow.AddSeconds(2);
            ResetSocket();
            var client = new WebSocketClient(new WebSocketClientOptions { Timeout = TimeSpan.FromSeconds(2) });
            _socket = client;
            client.TextReceived += args =>
            {
                var json = args.Text;
                BeginInvokeOnMainThread(() =>
                {
                    if (_socket == client && _announced)
                        HandleRequest(json);
                });
            };
            client.Connect(new Uri("ws://127.0.0.1:" + Port + "/api/bridge/ctrader-local"));
        }

        private void ResetSocket()
        {
            _announced = false;
            foreach (var entry in _watched.Values)
                entry.Symbol.Tick -= OnMarketTick;
            _watched.Clear();
            var previous = _socket;
            _socket = null;
            previous?.Dispose();
        }

        protected override void OnStop()
        {
            Timer.Stop();
            ResetSocket();
        }

        private void Send(object message)
        {
            _socket.Send(JsonSerializer.Serialize(message));
        }

        private void HandleRequest(string json)
        {
            int id = 0;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var message = doc.RootElement;
                switch (message.GetProperty("type").GetString())
                {
                    case "bars":
                        id = message.GetProperty("id").GetInt32();
                        SendHistory(id, message);
                        break;
                    case "watch":
                        UpdateWatches(message.GetProperty("subscriptions"));
                        break;
                }
            }
            catch (Exception)
            {
                if (id > 0 && _socket?.State == WebSocketClientState.Open)
                {
                    try { Send(new { type = "result", id, error = true }); }
                    catch (Exception) { ResetSocket(); }
                }
            }
        }

        private void SendHistory(int id, JsonElement message)
        {
            var name = message.GetProperty("symbol").GetString();
            var period = message.GetProperty("interval").GetString();
            var limit = message.GetProperty("limit").GetInt32();
            var beforeValue = message.GetProperty("before");
            long before = beforeValue.ValueKind == JsonValueKind.Null ? long.MaxValue : beforeValue.GetInt64();
            if (limit < 1 || limit > 1000 || !Periods.TryGetValue(period, out var timeframe))
                throw new ArgumentException();
            var symbol = Symbols.GetSymbol(name);
            var bars = MarketData.GetBars(timeframe, symbol.Name);
            int end = EndBefore(bars, before);
            int loaded = 0;
            for (int attempt = 0; end <= limit && attempt < 6; attempt++)
            {
                loaded = bars.LoadMoreHistory();
                if (loaded == 0)
                    break;
                end = EndBefore(bars, before);
            }
            var result = new List<object>();
            for (int i = Math.Max(0, end - limit); i < end; i++)
                result.Add(Candle(bars[i]));
            Send(new { type = "result", id, bars = result, digits = symbol.Digits, hasMore = end > limit || (end > 0 && loaded > 0) });
        }

        private static int EndBefore(Bars bars, long before)
        {
            int low = 0;
            int high = Math.Max(0, bars.Count - 1);
            while (low < high)
            {
                int middle = low + (high - low) / 2;
                if (UnixTime(bars.OpenTimes[middle]) < before) low = middle + 1;
                else high = middle;
            }
            return low;
        }

        private void UpdateWatches(JsonElement subscriptions)
        {
            var next = new HashSet<string>();
            foreach (var item in subscriptions.EnumerateArray().Take(16))
            {
                var name = item.GetProperty("symbol").GetString();
                if (name == null || !next.Add(name))
                    continue;
                if (!_watched.TryGetValue(name, out var watch))
                {
                    watch = new WatchedSymbol { Symbol = Symbols.GetSymbol(name) };
                    watch.Symbol.Tick += OnMarketTick;
                    _watched.Add(name, watch);
                }
                var frames = new Dictionary<string, Bars>();
                foreach (var requested in item.GetProperty("intervals").EnumerateArray())
                {
                    var period = requested.GetString();
                    if (period == null || !Periods.TryGetValue(period, out var timeframe))
                        continue;
                    try
                    {
                        frames[period] = watch.Frames.TryGetValue(period, out var existing)
                            ? existing : MarketData.GetBars(timeframe, name);
                    }
                    catch (Exception)
                    {
                        Print("Cannot watch {0} {1}.", name, period);
                    }
                }
                foreach (var period in watch.LastPreview.Keys.ToArray())
                    if (!frames.ContainsKey(period)) watch.LastPreview.Remove(period);
                watch.Frames = frames;
                watch.Dirty = true;
            }
            foreach (var name in _watched.Keys.ToArray())
            {
                if (next.Contains(name))
                    continue;
                _watched[name].Symbol.Tick -= OnMarketTick;
                _watched.Remove(name);
            }
        }

        private void OnMarketTick(SymbolTickEventArgs tick)
        {
            if (!_watched.TryGetValue(tick.SymbolName, out var watch))
                return;
            watch.Bid = tick.Bid;
            watch.Ask = tick.Ask;
            watch.QuoteTime = UnixTime(Server.TimeInUtc);
            watch.Dirty = true;
        }

        private void PublishMarket()
        {
            var events = new List<object>();
            foreach (var watch in _watched.Values)
            {
                if (!watch.Dirty)
                    continue;
                watch.Dirty = false;
                var symbol = watch.Symbol.Name;
                var digits = watch.Symbol.Digits;
                if (watch.QuoteTime > 0)
                    events.Add(new { type = "quote", symbol, bid = watch.Bid, ask = watch.Ask, time = watch.QuoteTime });
                foreach (var entry in watch.Frames)
                {
                    var interval = entry.Key;
                    var bars = entry.Value;
                    if (bars.Count == 0)
                        continue;
                    var current = bars.LastBar;
                    var time = UnixTime(current.OpenTime);
                    if (bars.Count > 1 && watch.LastPreview.TryGetValue(interval, out var previous) && previous < time)
                    {
                        var ended = bars[bars.Count - 2];
                        events.Add(new { type = "bar", symbol, interval, digits, bar = Candle(ended) });
                    }
                    watch.LastPreview[interval] = time;
                    events.Add(new { type = "preview", symbol, interval, digits, bar = Candle(current) });
                }
            }
            if (events.Count > 0)
                Send(new { type = "batch", events });
        }

        private static long UnixTime(DateTime value)
        {
            return new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc)).ToUnixTimeSeconds();
        }

        private static object Candle(Bar bar)
        {
            return new
            {
                time = UnixTime(bar.OpenTime), open = bar.Open, high = bar.High,
                low = bar.Low, close = bar.Close, volume = bar.TickVolume
            };
        }
    }
}
