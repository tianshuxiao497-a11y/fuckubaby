# Adaptive Trading Bot Live · Personal Workbench 0.3.0

A single native app with Spot and Futures tabs. It contains real Binance trading endpoints and is intended for the owner's personal acceptance first. Customer Whop licensing is not integrated and existing Testnet downloads are not replaced. Offline and native-launch acceptance do not prove real-account execution.

## Install and existing data

Extract the entire ZIP first. Windows x64 includes an EXE installer. Debian/Ubuntu x64 includes a DEB; if necessary run `sudo apt install ./AdaptiveTradingBot-Live-0.3.0-linux-amd64.deb` in the extracted directory. On Mac choose arm64 for Apple Silicon or x64 for Intel, then move Adaptive Trading Bot Live.app into Applications. Windows and Mac builds are unsigned; Mac is not notarized. Verify the source/checksums and use the operating system's per-app exception rather than disabling system protection globally.

Core Chinese interface glyphs and an OFL license are bundled for Linux and offline HTML guides. Spot retains its LivePersonal configuration and ledger; Futures retains FuturesPersonal; Testnet remains separate. Legacy single-leg Futures ledgers are backed up and migrated while preserving orders, fills and fees. Do not run an old independent app against the same profile concurrently.

Switching tabs does not automatically start or stop trading. Both activity indicators remain visible. The global stop stops Spot trading, Futures trading and local JSON automatic margin additions. System sleep also stops automation; resuming does not silently restart it.

## Spot

Open Spot, create/unlock a local vault password of at least 12 characters, and use your own mainnet Spot API Key with its HMAC Secret or matching Spot Ed25519 PEM. The app can generate/recover a registration public key; register that public key at Binance and enter the corresponding API Key returned by Binance. An API Key is not a private key.

Save and perform a read-only check before personally typing `START REAL SPOT TRADING`. Built-in trading signals and external Spot JSON rules remain available. Manual inventory is not automatically adopted. Read-only reconnect does not restart trading.

## Futures setup and position mode

In Futures → Connection & risk, use your own mainnet Futures API Key with either HMAC Secret or matching RSA PEM. The Spot Ed25519 PEM is not a Futures RSA PEM. Both Futures wallets must be readable. In Connection & risk, select the USD-M asset mode shown by Binance, save and run the read-only check. Single-Asset works for USDT-funded USDT contracts. To share eligible collateral across assets, select Multi-Assets and Cross. Binance determines collateral eligibility and valuation. The available margin shown in USDT equivalent already accounts for positions and open orders. Order sizing also considers the configured percentage, fees and minimum order size. The selector saves a local preference. Change the account-wide asset mode in Binance USD-M Futures settings if needed. Portfolio Margin is unsupported. Withdrawal permission is not needed.

Select USD-M USDT/USDC linear perpetuals or COIN-M inverse perpetuals, read current exchange settings, choose margin/leverage/allocation and save the local configuration. In Workspace, compare the settings saved locally with the last settings read from Binance. If the saved leverage is 102× and Binance still reports 150×, stop the strategy and check that the selected contract is flat with no outstanding orders. Type `APPLY FUTURES SETTINGS` and click the button to apply the selected mode and leverage to Binance. Run the read-only check again. The modes and leverage must match to start. Multi-Assets requires Cross. Manual positions on other contracts can remain open when coexistence is enabled.

Single-position management holds one direction at a time. Dual-leg management permits one long and one short on the selected perpetual, with independent entry/exit decisions and exchange protection. Changing contract, family or trading strategy requires stopped, flat and reconciled state.

The account position-mode section shows actual Binance One-Way/Hedge mode. A local selection does not silently change Binance. To enable Hedge Mode, both Futures wallets must be flat with no ordinary or conditional orders. Type `ENABLE FUTURES HEDGE MODE` and explicitly apply. Binance's shared mode affects both families. The app never silently disables Hedge Mode.

## Keep a manual position while running the strategy

The default setting pauses on external positions. Existing configurations keep this setting after an upgrade.

1. Unlock the local configuration. In **Connection & risk**, give the bot a separate contract. For example, keep a manual USD-M BTCUSDT position and select USD-M ETHUSDT for the bot. Reserve the selected contract for positions and orders the bot can reconcile, including conditional orders. Both sides of a contract share this restriction in Hedge Mode.
2. Under **外部持仓** (external positions), choose **允许其他合约持仓共存** (allow positions on other contracts). Save the updated local configuration, or use the initial encrypted save on first setup. Go to **Workspace** and run the read-only check. The bot manages its own verified positions. You manage the other contracts on Binance.
3. Check the available margin returned by Binance. Any unrealized profit Binance allows as collateral is already reflected in that figure. Available margin can fall if the profit shrinks or new orders reserve funds. The allocation percentage, fees and minimum order size still apply. The daily loss check uses account equity, so gains and losses on manual positions can affect the entry lock. New entries pause when the app cannot verify the start-of-day equity.

## Trading and manual equal hedge

After stopping, enter `START REAL FUTURES TRADING` again to restart monitoring. The strategy can wait for a signal. If a particular order is below the minimum, it skips that entry.

Type `START REAL FUTURES TRADING` to start. Long and short quantities, entry prices, protection and liquidation prices are shown separately. Each leg has its own stop and close action. Market-close actions require the trading confirmation and affect only the selected reconciled bot-owned direction.

For manual equal hedging, click the read-only preview. Review direction, quantity difference, initial margin and notional. Type `LOCK FUTURES POSITION` and submit. Trading pauses before account review; the smaller leg is increased by the quantity difference, subject to existing funds, chosen initial-margin budget, venue filters, leverage brackets and daily entry lock. It does not silently enlarge the budget to achieve equality.

IOC orders may fill partially. Partial coverage is shown accurately and is not blindly resubmitted. Another explicit preview/confirmation is needed to supplement the difference. Manual hedge state keeps automatic trading paused. Both exchange stops remain active; a stop, a manual close or funding can change coverage. Hedging is not guaranteed profit freezing. Releasing the manual pause requires the trading confirmation, does not close positions, and does not automatically restart trading.

## Allocation, costs and daily guard

Each new leg uses a configurable initial-margin percentage from 0.01% to 100%, with a 1% default. For example, enter 10 for an initial-margin budget of 10% of equity. Available margin, fees and contract minimums still apply. Leverage enlarges notional; two legs occupy funds separately and are not netted to zero for sizing. Below-minimum allocations are rejected. Cross margin may use other available matching collateral and initial margin is not a guaranteed loss cap.

Equity includes both legs' unrealized PNL, actual commissions, funding and collateral-coin price changes. Slippage is embedded in actual fill prices, not debited twice. The daily boundary is midnight UTC+8; on the first day, equity at app-ledger creation is used. A decline of more than 20% blocks new long/short entries, new hedge legs and automatic margin additions for that day. Owned positions may still reduce/close, and additional manual margin requires personal confirmation. The threshold does not guarantee a maximum 20% loss.

## Isolated margin controls

Futures → Connection & risk, section 05, shows actual exchange auto-add status as on, off or unavailable. Ordinary isolated positions whose optional auto-add is already off require no extra disabling step. Missing data is never displayed as off. This app does not present a fake exchange-side toggle. Exchange auto-add that is enabled or cannot be verified prevents simultaneous local JSON auto-add.

For manual addition, select LONG/SHORT, enter the amount in the displayed native collateral asset, type `ADD ISOLATED MARGIN`, and submit. USD-M uses USDT/USDC and COIN-M uses its collateral coin: 5 USDT must not be entered as 5 BTC. Automation stops first. Only owned isolated positions can be topped up; the app does not automatically remove margin.

An addition reallocates money inside the Futures wallet, does not increase contract quantity and is not counted as a deposit or profit. Unknown responses retain the original intent and query margin-change history; they are not retried blindly. Avoid simultaneous matching manual changes at Binance, which can make attribution uncertain and require manual review.

## External JSON automatic margin only

Section 06 has no built-in margin-addition strategy. Built-in trading signals remain separate. The sample JSON is disabled with zero spending values and cannot spend by itself. The user must supply these explicit fields:

- `id`: persistent budget identity; reimport/restart does not reset usage.
- `enabled`, `market`, `symbol`, `asset`, `positionSides`: explicit enablement and matching target/collateral/directions.
- `trigger.liquidationDistancePercentAtMost`: user-selected percent distance between mark price and the exchange's liquidation price.
- `perAdditionAmount`: native collateral amount for each addition, as a decimal string.
- `maxTotalAmount`, `maxAdditions`: combined automatic amount/count limits across both directions for that identity and contract.
- `cooldownSeconds`: at least 30 seconds when enabled.

Stop automation, import your own JSON with the vault password, review its target and persistent usage, type `ENABLE JSON AUTO MARGIN`, and explicitly enable it. Starting trading requires a separate confirmation. Both activity states stay visible when switching tabs.

After restart, sleep or a connection error, explicit rearming is required. The rule only runs while the app is running and armed, not at the exchange after shutdown. It will not execute with unknown orders, unconfirmed protection/native auto-add status/liquidation prices, insufficient funds, daily lock, cooldown or exhausted budget. It cannot guarantee completion before liquidation.

Confirmed history debits the durable automatic budget; unknown results do not cause duplicate additions. Parameter edits or reimport of the same ID preserve its usage, and that ID cannot be rebound to another asset or contract. A different ID explicitly creates another budget and should be reviewed as additional exposure.

## Stopping, records and acceptance

Stopping automation does not automatically close Spot inventory or Futures positions. Accepted exchange stops remain subject to exchange processing. Local take-profit, trailing exits and automatic margin actions stop at shutdown. Entry and protection are separate requests with an unprotected interval; neither stop execution nor price is guaranteed. Preserve uncertain requests and inspect Binance promptly, handling the account personally if needed.

Keep the ledger if a reconciliation fails. Check positions and orders for the selected contract on Binance. Export CSV/review reports before discussing new rules. No customer messages or paid AI calls are automatic.

Profiles remain in `AdaptiveSpotBot/LivePersonal` and `AdaptiveSpotBot/FuturesPersonal` under Windows LOCALAPPDATA, Linux XDG_DATA_HOME (default `~/.local/share`) or macOS `~/Library/Application Support`. Back up the entire directory only after exit and reconciliation. API keys remain encrypted locally and are not uploaded to Whop or Cloudflare.
