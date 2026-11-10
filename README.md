# Adaptive Spot Bot — Binance Spot Testnet source candidate

**English: start with [installation and operation](docs/INSTALL_EN.md).**
This is the original automated Testnet bot, not the separate offline EMA replay app.
It can submit virtual Testnet orders after explicit local enablement. It has no
production adapter or live-money switch; some dashboard labels remain Chinese.
Pre-commercial candidate only: seller terms, product approval and payment setup
are not finalized. No person, exchange or payment platform endorses this package.

## 虚拟量化交易程序完整包（仅币安现货测试网）

**先阅读 [中文安装与使用手册](docs/INSTALL_ZH.md)。** 包含源码、策略配置、空白密钥模板、只读交易看板和离线测试；不含任何人的密钥、账户记录、日志或实盘交易模块。

## 从哪里开始

1. 安装 [Node.js 24](https://nodejs.org/en/download)，解压到新空文件夹。
2. 在该文件夹打开 PowerShell，先运行下方离线检查。无需 npm install，不需要 Python、Docker 或 Next.js。
3. 按中文手册自行配置本机测试网密钥，先只读预览，再明确开启虚拟委托。

```text
node --version
node scripts/virtual-trading.mjs --describe
npm.cmd test
npm.cmd run check
```

macOS / Linux 将 npm.cmd 换为 npm。解压、导入或默认 describe 都不会自动交易；不要为查看源码而再启动一个实例。已经在原电脑运行的用户，请先看中文手册的“原电脑续用与迁移”部分。

## 常用入口（完成配置后）

| 用途 | 命令 |
| --- | --- |
| 只读信号预览，不下单 | `npm.cmd run virtual:preview` |
| 读取测试网账户 | `npm.cmd run virtual:status` |
| 明确启用测试网自动交易 | `npm.cmd run virtual:run -- --enable-testnet-orders` |
| 另开终端启动只读看板 | `npm.cmd run testnet:dashboard` |
| 请求安全停止，不自动平仓或撤单 | `npm.cmd run virtual:stop` |

看板地址：[http://127.0.0.1:3001/](http://127.0.0.1:3001/)。只在本机可见，网页不是交易开关。运行时不要关闭交易终端；断网、休眠和停止都会使本机保护性退出无法执行。

## 当前默认策略

v3 adaptive short，BTCUSDT，约每 5 秒检查；有确认信号才下单，不是定时强买强卖。每轮最多 100 虚拟 USDT，按 40 / 30 / 30 分批；1 分钟为有条件软退出，默认 3 分钟为本机最长持仓退出规则，网络故障可导致延迟。它不是高频交易平台，也不保证盈利或成交频率。

- [中文安装、全部可调配置与排错](docs/INSTALL_ZH.md)
- [English installation, security and recovery](docs/INSTALL_EN.md)
- [详细策略规则与兼容版本参考](docs/VIRTUAL_TRADING_LOGIC.md)
- [开发者使用与安全设计参考](docs/QUANT_PROGRAM.md)
- [当前可执行策略配置](strategies/virtual-only.json)
- [.env 空白配置模板](.env.testnet.adaptive.example)

SOURCE_MANIFEST.json 记录包内文件的 SHA-256；压缩包旁的 .sha256 校验 ZIP。校验值只检查文件一致性，不是发布者数字签名，也不是收益证明。发布 GitHub 时只分享干净源码，绝不上传实际 .env.testnet、.secrets/ 或 .paper-data/。
