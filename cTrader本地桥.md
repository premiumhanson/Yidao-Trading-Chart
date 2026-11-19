# 用 cTrader 本地行情连接 Yidao

1. 关闭旧的 Yidao 命令窗口，双击 [启动看盘.cmd](启动看盘.cmd)，保持这个窗口打开。
2. 在 cTrader 桌面版进入 **Algo → cBots → New**，命名为 `YidaoFeed`，选 **C# (.NET) → From scratch → Create**。复制 [YidaoFeed.cs](ctrader/YidaoFeed.cs) 全文替换编辑器里的模板，然后点 **Build**。 [cBot 创建说明](https://help.ctrader.com/ctrader-algo/documentation/cbots/create-a-cbot/)
3. 在 `YidaoFeed` 下选择带电脑图标的本地实例，使用 **TheTradingPit Demo** 账号，点绿色 ▶。该 cBot 会持续运行。看到 `Yidao local feed connected on port 17651` 表示连接上了。若显示 `Waiting for Yidao Trading Chart`，检查 Yidao 服务窗口是否还开着，以及窗口给出的端口是否与 cBot 参数 **Yidao port** 一致。 [本地启动说明](https://help.ctrader.com/ctrader-algo/documentation/cbots/start-a-cbot/)
4. 在 Yidao 右上角选 **cTrader 本地**。四张图会读取同一终端提供的行情。切换品种可在 Yidao 内完成。cTrader 和 Yidao 都应保持运行。

新报价按券商的 tick 到达。桥每约 250 毫秒最多转发一次最近报价和在形成中的 K 线。如果这个间隔没有新报价，界面就保留最后一次报价及时间。历史指标和结构信号仍按收盘 K 线计算。 [cTrader Tick 事件](https://help.ctrader.com/ctrader-algo/references/MarketData/Symbols/Symbol/Tick/)

本地连接固定使用回环地址 `127.0.0.1`。cBot 包含品种、历史 K 线和实时订阅操作。登录沿用 cTrader 桌面端。

## 续接本地 H1

选择 cTrader 本地并打开原库同名品种，Yidao 会检查 cTrader 历史能否覆盖原库末尾。打开页面期间会跟进已收盘 H1，断线恢复后会按最近一次缓存的 K 线继续查找。右边「补历史」可以立即重试。缓存保存在 `data/ctrader-h1.sqlite`，原来的 `market_1h.sqlite` 保持只读。市场休市的空白保留。不同代码的合约仍可在 cTrader 本地查看。
