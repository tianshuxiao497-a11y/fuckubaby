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

**看交易实况**：执行 `npm run testnet:dashboard` 后打开 http://127.0.0.1:3001。此页是测试账户的只读实时看板，显示测试网余额、机器人仓位、币安成交、订单和运行心跳；不是原来 localhost:3000 的本机模拟账户。仅绑定本机地址，不携带密钥到浏览器，也不向云端展示测试账户信息。经典模式账户数据最多缓存 20 秒，快速模式最多缓存 5 秒。关闭页面不会停止机器人。

Windows 后台开启看板：`powershell -NoProfile -File scripts/testnet-dashboard-start.ps1`。可选的手动虚拟买入试单命令为 `node --env-file-if-exists=.env.testnet scripts/testnet.mjs --buy-test --enable-testnet-orders`；执行前须先停止自动进程、核实空仓。它使用 quoteOrderQty 将试单金额限制在 99.90 虚拟 USDT 内，有持仓时拒绝再次试单，异常时仍先核对不重发。

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

### 快速实验模式（仅虚拟资金）

`.env.testnet.fast.example` 是无密钥参数模板。将其中的 `TESTNET_*` 参数更新到本机 `.env.testnet`，保留原有密钥；不要用空白模板覆盖密钥。

- `TESTNET_STRATEGY=fast`：1 分钟已收盘 K 线，SMA 3/7 上穿买入、下穿卖出，只有空仓才能买入。不使用未收盘价格计算均线，也不补执行停机期间的历史交叉。
- 每轮结束后间隔 10 秒再检查，另加网络耗时。止损 0.2%、止盈 0.3%、最长持仓 10 分钟**每轮都判断**，即使该分钟均线已处理也不会跳过这些退出条件。最长持仓保留实际买入时间，接管旧持仓时可能立即退出。
- 单次买入最多 100 虚拟 USDT，任何成交后新买入冷却 60 秒，滚动一小时最多 6 次买入；这些限额不阻挡卖出。一次只管理机器人自己的仓位，不加杠杆、不交易赠送资产。
- 快速连续运行中，只有已知只读 GET 的临时连接/服务器/时间戳错误，且没有待核对委托时，才暂停下单并按 30、60、120、240、最多 300 秒退避查询恢复。限流、权限和数据校验错误仍停机；任何 POST 错误、提交后未完成核对的委托仍停机保留记录。时间戳 -1021 的 GET 可重新同步后查询一次，POST 从不自动重发；不修改系统时钟，也不放宽 5 秒签名窗口。
- 这组参数是为缩短实验等待时间而设的，**没有回测盈利验证**。小止盈可能被手续费和滑点抵消；Testnet 结果不能证明实盘可行。这不是高频交易，也不是交易所保护单，网络和进程异常仍会停止。

更换周期前先安全停止，确认心跳为 stopped、没有锁和待核对委托，并备份 `.paper-data/`。更新参数后，运行 `node --env-file-if-exists=.env.testnet scripts/testnet.mjs --adopt-strategy` 接续同一账户同一交易对的持仓与订单；该命令独占加锁、拒绝未核对委托、保留买入时间、不下单。随后先预览，再显式启用虚拟交易。只读看板也需重启以加载新参数。不要删持仓记录来换周期。

### 30 秒循环试验（仅虚拟资金，非盈利策略）

用户明确选择此模式后，将 `.env.testnet.cycle.example` 的 `TESTNET_*` 参数合并到本机配置，保留密钥。先停止、备份并执行上面的 `--adopt-strategy`，再预览和显式启动；切换配置本身不会创建订单。

- `TESTNET_STRATEGY=cycle`：空仓买入最多 100 虚拟 USDT；实际成交核对完成后至少等待 `TESTNET_CYCLE_SECONDS=30` 秒，卖出本程序记录的 BTC，再等待至少 30 秒后下一次买入。目标约每分钟两笔订单（一次买、一次卖），不是两轮买卖。
- 每轮检查间隔默认 5 秒，另加请求耗时，所以实际成交可能更慢，不保证固定频率。停机后不补发错过的循环；重启最多执行一个当前动作。均线只供看图参考，不参与循环决策，也不使用原均线模式的止盈止损信号。
- 滚动一小时最多 60 次买入，不限制退出。间隔不能小于 30 秒，买入预算不能超过 100 USDT，禁止额外手动试单绕过循环间隔。只卖本程序的持仓，可能受数量、最小金额和手续费零头影响而停止。
- 待核对委托优先查询，不盲目重发 POST。已知只读临时连接错误退避；HTTP 451/来源限制、限流、权限或订单结果不明时停止。看板遇到明确访问拒绝会停止外部刷新，须核实资格及正常访问后重启；不绕过地区/来源限制。
- 此模式用于检验虚拟下单与成交显示的流程，可能持续损失虚拟资金。频繁交易不代表更好的量化策略，更不代表可以盈利或适用于实盘。

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
