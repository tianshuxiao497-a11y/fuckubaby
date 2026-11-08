# 虚拟量化交易逻辑 / Virtual-only adaptive trading logic

The strictly validated data file is **strategies/virtual-only.json**, currently
**version 3 / adaptive / adaptiveProfile: short**. The launcher, scripts/virtual-trading.mjs, reuses the
existing Spot Testnet engine. Pure research rules are in
lib/adaptive-strategy.mjs; no language model selects runtime orders.

## 当前短周期模式（v3，中文说明）

这一版缩短的是**开仓后的管理周期和成本过滤条件**，不是强迫定时买卖。
策略仍每约5秒检查一次，使用下文相同的 EMA 3/8、RSI、ATR、5分钟趋势、
短动量和两条评分入场路线；每轮最多100虚拟USDT，仍按40/30/30分批。

- 普通趋势卖出至少持仓 **10秒**；止损、止盈不必等到10秒。
- 持仓满 **1分钟**、且当前涨幅覆盖估算成本和缓冲时，允许软超时退出。
- 默认持仓达到 **3分钟**触发最长持仓退出。它是下次成功检查时的退出规则，
  不是交易所保证的成交期限；断网、休眠、订单结果不明等仍会使退出延迟。
- 基础止损 / 止盈均为 **0.15%**。首次入场按 ATR 调整后，止损限制在
  **0.10–0.40%**，止盈限制在 **0.10–0.60%**；首笔成交后冻结，不因加仓放宽。
- 通过只读测试网 `/api/v3/account/commission` 核验账户费率，计算每边实际的
  taker + buyer/seller 标准、税费和特殊费率，不预先应用折扣。核验有效期为
  **5分钟**；未知、失败或过期时按每边 **0.10%** 保守假设，绝不当作零。
- 固定保留每边 **0.02%** 滑点假设、实际买卖价差和 **0.01%** 缓冲。
  因此，经核验买卖费率均为零时，入场波动门槛是 **0.05%＋价差**；
  使用保守回退费率时是 **0.25%＋价差**。仍要求 **4 × ATR百分比** 覆盖门槛。
  这只是波动研究过滤指标，不是预期利润、成功率或已经验证的优势。
- 首次入场的费率来源与假设会随 `riskSnapshot.costSnapshot` 一起冻结并记录，
  不能因为后续费率刷新而改写历史入场依据。看板分别显示当前费率核验时间、
  有效期、入场冻结风险和真实成交。

**等待入场没有固定上限。** 只有一轮或少量历史成交，无法可靠估计平均多久
一笔；不能把“1分钟软退出 / 3分钟最长持仓”说成“每1–3分钟必定完成一轮”。
旧模式长时间等待可能主要来自成本过滤，而不是10分钟持仓上限。
缩短持仓或降低经过核验的成本门槛也不保证增加成交，更不保证改善收益。

新增检查统计只从 `adaptiveStats.startedAt` 开始记录，不补造旧的20分钟记录。
`checks` 是完成策略检查的次数，`waitReasons` 是各等待理由的累计次数，
`lastOrderAt` 是最近本机委托时间，可能早于检查统计起点；它们均不是预测下一笔的倒计时。
重启保留统计，但账户刷新失败时看板不把本地旧决断当成当前账户状态。

v3是在v2上**显式增加** `adaptiveProfile: "short"` 字段；v2没有这个字段，仍保留
下文的标准模式成本假设和较长退出周期。不是静默修改旧策略。配置仍不接入实盘。

This controls **Binance Spot Testnet virtual funds only**, at the fixed origin
https://testnet.binance.vision. It is not a real wallet, futures adapter, or the
separate browser-only paper account. There is no production toggle, configurable
host, withdrawal or transfer route. Never put keys, private keys, passwords,
URLs or executable code in the JSON. Unsupported fields and modes are rejected.

## Inspect, migrate, preview, run, monitor and stop

Use Node.js 24 from this project folder:

    npm run virtual:describe
    npm run virtual:adopt
    npm run virtual:preview
    npm run virtual:run -- --enable-testnet-orders
    npm run testnet:dashboard
    npm run virtual:status
    npm run virtual:stop

- **describe** is the default, completely offline action. It prints validated,
  non-secret settings without loading .env.testnet, contacting Binance, reading
  an account, changing trade records or starting a bot. Help is also offline.
- **adopt** is an explicit offline local migration, not a trade. First safely
  stop and reconcile any pending order. Adoption uses the original local
  Testnet identity and the exclusive lock, preserves actual owned inventory,
  dust and order history, and clears old samples. Existing inventory becomes
  **exit-only**, with no adds. Preserve an existing risk snapshot, or snapshot
  policy stop/target values for old inventory. Adoption does not sell, start a
  bot, or make an exchange request.
- **preview** reads Testnet market data for one non-persistent decision. It does
  not submit orders, save a trade or update peaks. A one-shot preview may remain
  in sample warm-up rather than showing an entry.
- **run** requires the additional --enable-testnet-orders flag. It executes the
  existing runner in the same foreground process, using virtual funds only.
  Its signal handling and lock cleanup apply; there is no orphanable child bot.
- **testnet:dashboard** is the local read-only monitor at
  http://127.0.0.1:3001/. The launcher and monitor now use **the same policy
  JSON**, not conflicting strategy values from .env.testnet. A visible dashboard
  or a proposed decision is not evidence of a running bot or a completed fill.
- **status** reads the Testnet account. **stop** requests a graceful stop even
  if an edited policy or credential file is broken. Stop loads neither file,
  liquidates nothing, and cancels no exchange orders. testnet:stop also works.

The launcher loads existing local Testnet credentials only for preview, run,
status and adoption. Adoption uses them locally for identity, without exchange
access. Policy settings are applied after that load, so old non-secret strategy
values cannot override the JSON. Credentials are never placed in the policy,
browser, arguments or offline description. These features do not create, edit
or upload credentials.

State, the account tag, the exclusive lock and pending intents remain in
.paper-data/. Never erase them to force a restart. There is no automatic
migration, restart or liquidation. Editing the JSON affects the next invocation,
not already running bot/monitor processes. Safely stop and review before edits.
Frozen stop/target thresholds do not change mid-position. A changed configured
hard timeout can still make an existing holding immediately eligible for exit
on the next explicitly enabled run.

## Data and cadence (shared; v2 standard defaults below)

The default target is one market observation about **every five seconds**;
versions 2 and 3 allow **5–10 seconds**. Network/validation delays can make it slower.
This is **not** a fixed-frequency BUY/SELL cycle. Missed slots are not replayed.

Use validated, closed one-minute OHLCV candles: default **EMA 3/8**, **Wilder
RSI 7**, and **ATR 7**. Five-minute context uses only complete UTC-aligned groups
of five closed one-minute candles, with context EMA 3/5. No incomplete group
contributes future information. Invalid, missing, stale or discontinuous data
fails closed.

Entry needs at least three contiguous midpoint observations spanning
**10–30 seconds**. Keep only the recent 30-second window; a gap **over 15 seconds**
clears it. Restarts and read-only connection failures also clear sampling.

## Essential entry gates and two scored routes

Both entry routes require fresh samples, spread at most **0.03%**, absolute
midpoint deviation from fast EMA at most **0.35%**, sufficient remaining budget,
and permission from the order-spacing and entry-loss guards below.

In **v2 standard**, the volatility research proxy **4 × ATR percent** must cover estimated
round-trip costs plus **0.05%**. Fixed cost assumptions are **0.1% fee per side**
and **0.02% slippage per side**: **0.24% plus current spread** round trip.
These are assumptions, not a statement of the account's actual fee tier.

**ATR × 4 is an opportunity research proxy, not expected return, measured edge,
success probability or evidence of profitability. Passing it can still lose.**

### Trend continuation

Essential: fast EMA above slow EMA, midpoint at or above fast EMA, and recent
midpoint momentum at least **+0.008%**. Require four of six score points:

1. Fast EMA above slow EMA.
2. Fast EMA rising from its previous value.
3. Five-minute context fast EMA at or above context slow EMA.
4. Recent midpoint momentum at least +0.008%.
5. RSI between 45 and 78.
6. Latest volume at least 0.8 times the preceding ten-candle average.

RSI/volume are scored evidence, not a requirement that every indicator agree.

### Confirmed pullback rebound

Essential: the penultimate close fell below its predecessor and the latest close
rose above it; midpoint is at least the latest close; recent midpoint momentum
is at least **+0.012%**; and five-minute EMA bias is not below **−0.15%**.
Require three of five score points:

1. That closed-candle rebound pattern.
2. RSI rising from its previous value.
3. Five-minute context fast EMA at or above context slow EMA.
4. Latest volume at least 0.7 times the preceding ten-candle average.
5. Midpoint at or above fast EMA.

This route can qualify before the fast one-minute EMA recrosses the slow EMA.
If both qualify, record trend continuation. A timer alone never creates entry.

## Sizing, frozen risk and exits

A new round stages **40% / 30% / 30%**: default **40 / 30 / 30 virtual USDT**,
at most **100 virtual USDT cumulative purchase notional per round**. This is not
a whole-account balance cap. Fees are additional, market value can appreciate,
and owned unsold dust remains separately recorded. Actual fills and commissions
determine quantity; exchange lot-size/minimum-notional rules still apply.

Add only while an entry route remains confirmed, the bid is **strictly above**
recorded average cost, and midpoint is at least **0.03% above** the previous
tranche's actual fill price. No averaging down. At most three tranches.
Adopted/legacy holdings without staging metadata are exit-only.

For each new **v2 standard** position, freeze (v3 short values are above):

- Stop: greater of the policy base and **1.4 × ATR percent**, clamped to
  **0.15–0.75%**.
- Target: greatest of the policy base, **2.2 × ATR percent**, and costs plus
  the 0.05% buffer, clamped to **0.25–1.2%**.

The present policy bases are **0.25% stop / 0.4% target**. Later volatility or
adds do not widen that frozen snapshot. Existing snapshots and adopted holdings
can preserve original/base thresholds rather than using new-entry ATR values.

Use the sellable **bid**, not midpoint, to evaluate exits:

The following timing defaults describe **v2 standard**, not v3 short:

1. Frozen stop, frozen target, then configured hard holding limit
   (**10 minutes default**) take priority over warm-up, entry-loss guards and
   ordinary spacing. An ambiguous pending order still blocks new orders.
2. Other exits require at least **20 seconds since original opening** and
   **five-second** ordinary spacing. Trailing arms when the observed peak covers
   estimated round-trip costs, the 0.05% buffer, plus another 0.1%.
   Retracement distance is **0.8 × ATR percent**, clamped to **0.08–0.25%**.
   Once armed, falling back below costs does not disarm it; a fast-gap exit
   is not guaranteed to remain profitable.
3. **Three-minute soft timeout** exits only if the current gain covers costs
   plus the 0.05% buffer. Otherwise the hard holding limit still applies.
4. Normal weakness exit: both one-minute and five-minute fast EMAs are below
   their slow EMAs, or warmed midpoint momentum is at most **−0.025%** while
   fast EMA is below slow EMA or RSI is below 45.

These are **local software exits, not exchange-hosted protection orders**.

## Loss, ownership and order safeguards

- Default re-entry cooldown after becoming flat is **10 seconds**. At most
  **60 recorded BUY orders per rolling hour**, including adds; these entry
  limits do not block protective exits.
- Block new buys at **5 virtual USDT** guarded realized loss in the current
  **UTC day**. A loss imposes **60 seconds** cooldown; three consecutive guarded
  losses impose **15 minutes**. Recent-loss cooldowns can cross UTC midnight.
  An expired previous day's loss total does not consume the new day's budget.
- **dailyRisk.realizedUsdt is a conservative control accumulator, not a
  performance report.** It considers assumed costs and known fills. Actual
  order proceeds, per-asset commissions, realized estimates and valuation
  completeness are recorded separately. Unpriced third-asset fees must not be
  reported as fully measured profit. This guard cannot guarantee that total
  account losses remain below five USDT.
- Sell only recorded bot-owned quantity, not gifted/unrelated BTC. Below-minimum
  residual inventory remains owned dust: do not discard it, fabricate a sell,
  or borrow gifted coins to top it up.
- Persist a pending client intent **before** POST. Reconcile an unknown result
  instead of blindly resending. The exclusive local lock prevents two bots.
- Known read-only outages use bounded recovery with cleared samples. Access
  refusals, permissions, inconsistent records, rate limits and unknown order
  results stop/pause trading rather than inventing fills.

## Policy parameters and legacy compatibility

Every field is required. Numbers must be finite JSON numbers, never strings,
booleans or null. Unknown keys and executable rules are rejected.

| Field | Version 2 adaptive standard | Version 3 adaptive short |
|---|---|---|
| version, mode | 2, BINANCE_SPOT_TESTNET_ONLY | 3, same Testnet-only mode |
| adaptiveProfile | Not permitted | Required: short |
| strategy, symbol, interval | adaptive, BTCUSDT, 1m | Same |
| pollSeconds | Integer 5–10; default 5 | Same |
| maxPositionUsdt | 25–100 purchase notional per round; default 100 | Same |
| fastPeriod, slowPeriod | Integers 3–10 and 5–30, fast smaller; defaults 3/8 | Same |
| stopLossPercent, takeProfitPercent | Base inputs 0.1–5 / 0.1–10; new-entry caps above still apply | Defaults 0.15 / 0.15; short-profile caps above still apply |
| maxHoldMinutes | Integer 1–60; default 10 | Integer 1–3; default 3 |
| cooldownSeconds | Integer 5–3600; default 10 | Same |
| maxBuysPerHour | Integer 1–60; default 60 | Same |

Fractions, fee source/refresh rules, slippage assumptions, ATR/RSI periods, score rules, sample limits,
loss guards and ordinary spacing are fixed engine values, not JSON keys.
The separate public-market/manual-draft dashboard does not execute this strategy.

**Version 1 remains compatible:** version 1 with strategy "tactical" retains
the older default SMA 3/7, ten-second checks, 25/25/50 staging, and 20–45 second
momentum observations. Its policy poll range is 10–20 seconds and cooldown is
30–3600 seconds. It is not silently interpreted as adaptive: explicitly adopt
stopped compatible records when changing strategy. This is not an implementation
of a discretionary 5/15-minute framework discussed in chat.

## Limits

This is an unvalidated research/functional experiment, not high-frequency
trading or a profitability claim. Fees, spread, slippage, gaps and latency can
overwhelm small targets. Passing tests or backtesting does not establish future
returns. Keep the computer **awake and connected** while running. No local exit
is guaranteed; stopping leaves inventory without this program's protection.
Testnet resets can invalidate local ownership: stop and reconcile, never erase
records and continue as if holdings were known.

Creating/editing these files does not itself start a bot, create credentials,
change an account or authorize a real-money trade.
