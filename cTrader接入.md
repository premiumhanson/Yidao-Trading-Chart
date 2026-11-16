# Yidao Trading Chart 的 cTrader 行情接入

本地服务通过 cTrader 云端 Open API 读取授权账户的品种、历史 K 线、实时买卖价和最新已收盘 K 线。4 图布局右上的 15 分钟历史直接来自所选账户的 M15 行情。买卖价随报价推送，K 线以券商下发的已收盘记录为准。历史刷新可在断线恢复后补齐缺口。 [行情文档](https://help.ctrader.com/open-api/zh/symbol-data/) · [连接地址](https://help.ctrader.com/open-api/zh/proxies-endpoints/)

## The Trading Pit 挑战账户

The Trading Pit 的官方说明将 cTrader 挑战账户列为 **Demo**，因此从 `CTRADER_ENV=demo` 开始。用挑战账户关联的同一个 cTrader ID 登录 Open API 门户，在 Playground 检查 **accounts** 授权页面是否列出你的挑战账户。公开说明无法确认单个账户的应用授权状态。账户能被选中并在开市时持续收到报价，才验证了这条行情链路。如果列表里没有它，先核对是否使用了挑战开户邮件关联的 cTrader ID，再请 The Trading Pit 确认该账户是否允许只读 Open API 授权。 [The Trading Pit 官方账户说明](https://support.thetradingpit.com/how-to-connect-to-c-trader) · [cTrader Demo 与 Live 环境](https://help.ctrader.com/open-api/zh/proxies-endpoints/)

## 在本机配置

1. 用 cTrader ID 登录 Open API 门户，注册应用。应用获批后，在 **Applications** 的 **Credentials** 中找到 Client ID 和 Client Secret。 [Open API 门户](https://openapi.ctrader.com/) · [注册说明](https://help.ctrader.com/open-api/zh/api-application/)
2. 在同一页打开 **Playground**，把权限范围选为 **accounts**，点击 **Get token**，授权要使用的账户并复制 Access Token。初次连接可用 Demo 账户。同一环境只有一个授权账户时，会自动选择它。 [授权与 Playground](https://help.ctrader.com/open-api/zh/account-authentication/)
3. 在启动脚本所在目录创建或打开 **.env.local**，保留已有的 `KUNHOU_DB`，填入下面的配置。选择真实账户时，把环境改成 **live**。同一环境有多个账户时，填写 cTrader 显示的账户号，或 API 返回的 **ctidTraderAccountId**。 [环境与账户字段](https://help.ctrader.com/open-api/zh/model-messages/#protooactidtraderaccount)

~~~dotenv
CTRADER_ENV=demo
CTRADER_CLIENT_ID=填入你的应用ID
CTRADER_CLIENT_SECRET=填入你的应用密钥
CTRADER_ACCESS_TOKEN=填入你的只读访问令牌
CTRADER_ACCOUNT_ID=
~~~

4. 保存后重启 Yidao Trading Chart，再切换到 **cTrader** 数据源。选择一个开市品种，观察买卖价和报价时间是否变化。休市时第一次推送也可能包含最后一笔报价。令牌到期后，在 Playground 重新生成 Access Token，替换文件中的值并重启。把凭证保留在本机的配置文件中。 [令牌有效期和续期](https://help.ctrader.com/open-api/zh/account-authentication/) · [Spotware 消息定义](https://github.com/spotware/openapi-proto-messages/blob/main/OpenApiMessages.proto)

若提示连接失败，检查 demo.ctraderapi.com:5036 或 live.ctraderapi.com:5036 是否可达。若提示找不到账户，核对 Demo／Live 环境及 Playground 内授权的账户。

本机已验证 Demo WebSocket 握手。模拟协议测试覆盖认证和只读权限、账户和品种选择、M15/H1 行情推送、历史分页、多页面共用订阅和断线重订阅。实际券商行情仍需通过已授权的账户验证。
