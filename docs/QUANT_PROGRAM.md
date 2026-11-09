# 虚拟量化程序完整源码 / Virtual quant program

## 当前版本要点（中文）

当前 `strategies/virtual-only.json` 为 **v3 adaptive 短周期模式**，新增显式字段
`adaptiveProfile: "short"`。仍只用币安现货测试网虚拟资金，没有实盘入口。

约每5秒检查行情，**有信号才买，不是5秒强制交易**。EMA 3/8、RSI 7、ATR 7、
完整5分钟趋势、短动量和评分路线继续保留；每轮最多100虚拟USDT，按40/30/30分批。
普通趋势退出最少持有10秒；满1分钟且覆盖估算成本允许软退出；默认最长持仓3分钟。
止损、止盈和最长持仓优先。基础止损 / 止盈0.15%，首次入场按ATR调整后冻结，
止损限制0.10–0.40%，止盈限制0.10–0.60%，不会因加仓而放宽。

短周期成本过滤使用5分钟内核验的测试网账户完整买/卖费率，未知或过期按每边
0.10%回退；另保留每边0.02%滑点假设、实际价差与0.01%缓冲。核验双边零费率时，
波动门槛为0.05%＋价差（回退费率时为0.25%＋价差）。仍须4×ATR覆盖这个门槛。
它是研究过滤指标，**不是预计能赚这么多**。完整规则见
[交易逻辑说明](VIRTUAL_TRADING_LOGIC.md)。

等待买入的时间没有固定上限；几次历史成交不能可靠预测平均周期。
“1分钟软退出、3分钟最长持仓”不是承诺每1–3分钟买卖一轮。
网络、订单核对和访问异常可使实际退出延迟。更短周期也可能增加亏损。

看板对短周期模式显示中文说明、当前成本门槛和核验时间，并展示从新统计功能
开始后的检查次数与主要等待原因。它不补造旧20分钟的检查历史，也不会把检查
次数当作成交次数。费率入场依据随首次持仓冻结并保留在记录中。

完整源码不含你的密钥、账户记录或日志。解压不会自动运行；按下文在本机配置
测试网密钥，先运行离线检查与预览，再明确开启虚拟委托。旧v2标准模式仍兼容，
不要把v3字段混进v2。下文v2表格专门保留作旧配置参考。

This program trades **Binance Spot Testnet virtual funds only**. It does not
connect to a real Binance wallet, futures, withdrawals, or transfers. The exchange
origin is fixed to `https://testnet.binance.vision`; production hosts and
production credentials are not supported. Nothing starts when you extract the
ZIP, import a module, or inspect the policy.

The package contains the complete local runner, strategy engine, policy
validator, Testnet account monitor, blank credential templates, and automated
tests. Its generated `package.json` is intentionally standalone: no Next.js app,
live-wallet feature, live-market dashboard, or third-party dependency is required.

## 1. Inspect the download and run offline checks

Install **Node.js 24** locally and extract the ZIP into a new, empty folder. Open
a terminal in that folder. No `npm install` is necessary.

The adjacent `.sha256` file checks the ZIP bytes. On Windows, for example:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\virtual-quant-source-<timestamp>.zip'
```

Compare the result with the adjacent checksum file. `SOURCE_MANIFEST.json` lists
the SHA-256, byte size, and origin of each packaged source file. Checksums detect
accidental changes; they are not a publisher signature or a profitability claim.

```text
node --version
node scripts/virtual-trading.mjs --describe
npm test
npm run check
```

`--describe` is completely offline: it validates and prints the non-secret policy
without loading credentials, reading an account, sending a request, or trading.
The tests use local fixtures and mocks, not real orders. `check` validates the
source-export allowlist without creating an archive. An unknown command or
invalid policy fails closed rather than starting a bot.

## 2. Configure a local Testnet key yourself

Use only the [Binance Spot Testnet](https://testnet.binance.vision/). Sign in there
yourself. Never put a password, verification code, API secret, or private key in
chat, a strategy JSON file, a browser dashboard, Git, or a shared ZIP.

For a **new** local Ed25519 key pair:

```text
node scripts/testnet-keygen.mjs
```

This creates `.secrets/testnet-ed25519-private.pem` and the matching public PEM.
It refuses to overwrite an existing private key. Register **only the public
key** on Spot Testnet; keep the private key on your computer. Give the Testnet key
only the permissions needed for account reads and virtual spot orders. No live
Binance key is needed or accepted by this workflow.

Create `.env.testnet` from `.env.testnet.adaptive.example` **only in a fresh
installation**. On Windows:

```powershell
Copy-Item -LiteralPath '.env.testnet.adaptive.example' -Destination '.env.testnet'
```

All three credential fields in the exported examples are blank. Edit your local
`.env.testnet` yourself: set `BINANCE_TESTNET_API_KEY` to the Testnet-issued API key
and `BINANCE_TESTNET_PRIVATE_KEY_PATH` to your local private-key path. Leave
`BINANCE_TESTNET_API_SECRET` blank when using Ed25519. For a supported Testnet HMAC
key, configure its local secret instead of a private-key path. Do not configure
both authentication methods.

Do not copy a blank template over an existing credential file. The local env
file, `.secrets/`, `.paper-data/`, logs, screenshots, Git data, and `node_modules/`
are deliberately absent from the source package. Keep local credential-file
access restricted to your own account.

## 3. Understand the executable strategy

`strategies/virtual-only.json` is the authoritative, non-secret policy.
`scripts/virtual-trading.mjs` validates it, loads local Testnet credentials only
when needed, and reuses the established runner in the same foreground process.
`lib/adaptive-strategy.mjs` implements the adaptive decisions; the runner and
`lib/testnet-bot.mjs` own order validation, recorded ownership, reconciliation,
and persistence. [The strategy logic guide](VIRTUAL_TRADING_LOGIC.md) describes
the supported profiles and their exact parameters.

The adaptive profile is a deterministic experiment, not an AI agent choosing
orders at runtime. It checks market conditions and can wait rather than trading
on every timer tick. A faster check does not promise a faster fill, more trades,
or a profit. Review the checked policy and strategy guide before enabling orders.
The legacy tactical profile remains a separate supported policy version; do not
guess or mix fields between policy versions.

The legacy **v2 adaptive standard** defaults are retained below for reference.
They are not the distributed v3 short profile, described in Chinese above:

| Area | Default behavior |
|---|---|
| Decision checks | Target every 5 seconds, not automatic fills; 3 observations spanning 10–30 seconds; gaps above 15 seconds reset warm-up |
| Indicators | Closed 1-minute EMA 3/8, RSI 7, ATR 7, with complete UTC-aligned 5-minute context |
| Entry routes | Confirmed trend continuation or pullback rebound; otherwise WAIT |
| Deployment | At most 100 virtual USDT per round, staged 40 / 30 / 30; add only to a profitable holding after a confirmed advance; no averaging down |
| Cost gate | Assume 0.10% fee and 0.02% slippage per side, add actual spread and a 0.05% buffer; 4 × ATR-percent is a volatility research proxy, not an expected return |
| Market filters | Spread at most 0.03%; price extension from fast EMA at most 0.35% |
| Position risk | ATR-adjusted stop loss 0.15–0.75% and take profit 0.25–1.2%, using configured 0.25% / 0.4% inputs; freeze thresholds on the first fill rather than widening them on every check |
| Holding exits | Hard maximum 10 minutes; soft 3-minute timeout only when estimated costs are covered; trailing and confirmed-weakness rules also apply |
| Entry limits | Ordinary order spacing 5 seconds, flat re-entry cooldown 10 seconds, recent-loss cooldown 60 seconds, at most 60 filled BUYs per rolling hour including tranches |
| Conservative guard | Block new BUYs after −5 virtual USDT guard P&L per UTC day, or for 15 minutes after 3 consecutive conservative losses; exits remain allowed |

The guard uses conservative known P&L and recorded/frozen round-trip cost assumptions,
not a performance estimate. Recorded order commissions and realized P&L remain
separate; an unknown fee asset can make fee valuation incomplete. Missing
accounting values are unknown, not zero. The volatility gate may deliberately
produce long periods with no orders. A short profile may use freshly verified
Testnet fees instead of the standard assumption; do not erase costs or bypass
signal/ownership guards merely to inflate activity.

The total quote budget controls deployed purchase notional, not maximum market
value or a guaranteed maximum loss. Fees, spread, slippage, latency, and dust can
affect actual results. The program must use actual exchange fills and only the
position quantities it owns; gifted or unrelated assets are not strategy capital.
Local exits are not exchange-hosted protection orders and cannot execute while
the computer is asleep, offline, blocked, or stopped.

## 4. Preview before explicitly enabling virtual orders

```text
npm run virtual:preview
npm run virtual:status
```

Preview reads Testnet market data and evaluates one decision without submitting
orders or saving a trade. A profile requiring consecutive samples may still be
warming up in a one-shot preview. Preview is not a promise that the next run will
BUY. Status reads the Testnet account and requires valid local credentials.

When you have checked the policy, local keys, existing position, and pending
orders, explicitly run the strategy in the foreground:

```text
npm run virtual:run -- --enable-testnet-orders
```

Without the extra flag, `virtual:run` refuses to start. Even with the flag, orders
are **virtual Spot Testnet orders only**. Start one runner, not several terminals
or background helpers for the same state. The exclusive lock prevents duplicate
runners; do not delete it just to force a second start.

The lower-level `--buy-test` option is a separately enabled **one-off virtual
BUY trial**, not a signal-based preview or the adaptive strategy. It bypasses
normal signal selection for that explicit trial where supported, may be
forbidden by a profile, and must not be used to manufacture regular trades. It
is deliberately not part of the recommended launcher commands above.

## 5. Observe the Testnet monitor

In a separate terminal:

```text
npm run testnet:dashboard
```

Open `http://127.0.0.1:3001/`. This is a local read-only monitor, not a trading
button or public cloud service. It shows account data, actual confirmed fills,
owned positions, and the last observed runner activity. A configured profile is
not evidence that a process is running or an order filled. Old data after a
failure is not current account state; consult the displayed timestamps.

The policy-aware monitor applies the same validated
`strategies/virtual-only.json` after local env settings, matching the policy
launcher rather than silently displaying an older env profile. It does not
adopt positions or change runner state. The adaptive audit labels EMA/RSI/ATR
decisions, frozen risk, conservative guard basis, and fee/P&L completeness;
any displayed SMA chart is reference-only, not the strategy EMA calculation.
Closing the monitor does not stop the runner.

## 6. Stop and recover safely

```text
npm run virtual:stop
```

This requests a graceful stop. It does **not** automatically sell holdings or
cancel exchange orders. Inspect the final activity, state, and pending orders.
Never delete `.paper-data/`, discard an unresolved client order ID, remove a
live lock, or repeatedly submit an order to force recovery. An uncertain order
must be queried and reconciled before any new order.

Network delays can slow checks and fills. Read-only transient failures may back
off; access refusal, permission problems, rate limits, invalid data, or unresolved
order outcomes must not be bypassed by changing hosts or blindly retrying order
POSTs. A region/access refusal also applies to Testnet: stop and verify access
with Binance rather than circumventing it. Testnet resets can invalidate saved
records; inspect and reconcile instead of erasing state and carrying on.

Changing a same-profile setting can change management of an existing position
on the next explicit run, potentially causing an immediate exit. Stop and review
first. Different or incompatible saved strategies require a deliberate,
reviewed migration; the launcher does not silently adopt positions or restart
an old process.

For a deliberate supported migration after stopping and reviewing the existing
record, `npm run virtual:adopt` runs the explicit local adoption action. It does
not submit an order or automatically resume trading. Adopted existing inventory
is exit-only, with no additions; new thresholds can cause an immediate exit on
the next explicitly enabled run. Never use adoption to hide an unresolved order,
account mismatch, or incorrect ownership.

## 7. Export clean source again

```text
node scripts/package-virtual.mjs --check
node scripts/package-virtual.mjs
```

The exporter reads only an explicit allowlist of required source files. It never
walks your workspace, reads your real `.env.testnet`, loads a private PEM,
contacts Binance, starts a runner, or pushes to GitHub. It rejects missing source
files, linked paths, overlarge input, private-key material, and nonblank example
API credentials. All exported credential fields, including private-key paths,
are blanked. It generates dependency-free package metadata rather than copying
the original web application's dependency tree.

Outputs are confined to `exports/`: a timestamped ZIP, its `.sha256`, and a
`.manifest.json`. Existing exports are not overwritten. ZIP entries use a fixed
timestamp and a stable sort: identical input bytes create identical ZIP bytes.
The source package is not a backup of credentials or an account. Preserve those
locally and securely if you need them; never add them to the distribution.

This is unvalidated experimental trading software, **not a guaranteed-profit
system or high-frequency trading platform**. Test offline and on virtual funds;
do not adapt it to operate a real wallet without a separate, independently
reviewed implementation.
# 记录保存修复（2026-10-18）

状态和心跳采用同目录唯一临时文件，完整写入并同步、关闭后再替换正式文件。
Windows 的短暂 EPERM / EACCES / EBUSY 只对文件替换进行有限重试，绝不因此重发订单。
重试耗尽仍停止交易，并保留原记录与失败临时文件；不会先删除正式记录来强行保存。
心跳写入失败也会尝试关闭并清理本进程自己的锁，不会删除其他进程的锁。
旧的 `.tmp` 可能包含未核对订单，不应自行删除、覆盖或直接恢复。

