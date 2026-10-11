# Binance Testnet Quant Lab

`fuckubaby` · crypto。只使用虚拟资金的策略实验台。不会读取或交易真实 Binance 资产，不提供实盘适配器，不构成投资建议，不保证收益。

## 两个独立模式

- **网页本机模拟**：浏览器里的 10,000 USDT、持仓和成交保存在本机，不是交易所测试账户。网页按钮不控制下面的机器人。
- **币安现货测试网机器人**：本机 Node 程序连接你在 [Spot Testnet](https://testnet.binance.vision/) 创建的账户，在 Testnet 中生成虚拟委托。

## 安全边界

- 机器人只能请求固定域名 `https://testnet.binance.vision` 的白名单 `/api/v3` 接口，禁止自定义域名及生产环境配置，不支持充值、提现。
- 网页模拟不需要密钥；机器人只接受测试网密钥。
- `.env*`、`.secrets/`、`.paper-data/`、`*.pem`、`*.key` 都被 Git 忽略。只有无密钥的配置模板上传。私钥以未加密文件保存在本机，须保护电脑及文件访问权限，API Key 也不要公开。
- 提交虚拟委托之前保存待核对记录，异常立即停止。重启时查询上一次委托，绝不盲目重发。独占锁防止同一目录运行多个实例。只卖机器人记录的仓位，不卖测试账户自带的 BTC。
- Testnet：Binance 的 Testnet 虚拟数据会定期重置，且不等于真实行情或真实交易结果。

## 本机网页模拟

1. 快线 SMA 向上穿越慢线 SMA 时，按“单笔虚拟资金”模拟买入。
2. 快线向下穿越慢线 SMA 时，模拟卖出。
3. 持仓达到配置的止损或止盈阈值时，模拟退出。
4. 每笔模拟交易按 0.1% 计入费用，用于让测试更接近真实交易摩擦。

这只是示例策略，不构成投资建议，也不代表可盈利策略。

```powershell
npm ci
npm run dev
```

打开 `http://localhost:3000`。首次可点击“恢复演示”，在无网络时用内置 K 线测试；网络可用时点击“刷新行情”或“运行一次”读取 Testnet 公开行情。

## 测试网机器人配置

需要 Node.js 24 LTS。复制 `.env.testnet.example` 为 `.env.testnet`，不要上传后者。

推荐 Ed25519：运行 `node scripts/testnet-keygen.mjs` 生成本机密钥对（拒绝覆盖已有私钥）；在测试网页面选择 Register Public Key，填写 `.secrets/testnet-ed25519-public.pem` 的内容，只勾选 TRADE 和 USER_DATA。私钥不离开电脑。

将测试网生成的 API Key 填入 `.env.testnet`：

```dotenv
BINANCE_TESTNET_API_KEY=你的测试网APIKey
BINANCE_TESTNET_API_SECRET=
BINANCE_TESTNET_PRIVATE_KEY_PATH=.secrets/testnet-ed25519-private.pem
```

也支持 HMAC：只填写测试网 API Key 和 API Secret，清空 PRIVATE_KEY_PATH。两种方式不能混用，不要填写生产密钥。

## 验证、运行与停止

```powershell
npm run testnet:market    # 公开行情，无需密钥
npm run testnet:status    # 读取测试账户的虚拟余额
npm run testnet:validate  # 校验签名和参数，不进入撮合引擎
npm run testnet:preview   # 只看信号，不创建订单或修改记录
npm run testnet:run       # 显式启用虚拟交易，前台运行，Ctrl+C 停止
```

Windows 后台运行：`powershell -NoProfile -File scripts/testnet-start.ps1`。查看 `.paper-data/testnet-out.log` 和 `testnet-error.log`。执行 `npm run testnet:stop` 请求安全停止；停止不会平仓或撤单。电脑需保持开机、联网且不休眠。程序遇到错误会退出，不设置开机自启，也不自动绕过网络或地区限制。

## 机器人策略与限制

默认 BTCUSDT，5 分钟已收盘 K 线，SMA 9/21 交叉，每笔最多 100 虚拟 USDT，每 60 秒检查。上穿买入，下穿卖出；相对成交价跌 1.5% 或涨 3% 时触发退出。所有判断（包括止盈止损）每根新收盘 K 线最多处理一次，**不是实时保护单**，也没有在交易所挂止损单；进程退出、网络断开或行情缺失时不会执行退出。

数量按交易对限制向下取整，成交使用交易所报告的实际数量和手续费，可能残留无法卖出的零头；低于最小委托金额时程序停止，需要人工核对。市价会变化，参数校验通过不保证后续成交。

Testnet 的价格、流动性及余额都不等于实盘。虚拟账户会定期重置，本机状态不会自动重置。遇到余额、订单或记录不一致时，不要直接删记录继续跑：先停止进程、备份 `.paper-data/`，核对测试账户，必要时人工重置测试记录。遗留锁只能在确认对应进程已结束后移除。不要同时从其他程序交易机器人持仓。

## GitHub 与测试

GitHub 保存源代码，不等于让机器人在云端 24 小时运行。本机私钥和账户状态不会随仓库同步。新电脑须自行配置测试密钥。CI 只运行离线测试、类型检查和构建，不携带密钥，不连接交易账户。

```powershell
npm test
npm run check
npm run build
```

官方说明：[测试网](https://testnet.binance.vision/)、[Spot API](https://developers.binance.com/en/docs/products/spot/rest-api)、[交易数量限制](https://developers.binance.com/en/docs/products/spot/filters)。
