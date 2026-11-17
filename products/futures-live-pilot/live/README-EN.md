# Adaptive Futures Bot · Personal Mainnet 0.1.0

This is the owner's self-acceptance edition with real Binance Futures trading endpoints. It is separate from the Testnet customer product and the Spot personal app. Customer subscription licensing is not integrated. Do not replace the existing Whop Testnet delivery with this package. Automated acceptance uses fabricated accounts, not real exchange credentials or orders.

## Scope

USD-M USDT/USDC linear perpetuals and COIN-M inverse perpetuals, long and short, cross and isolated margin, account-specific leverage brackets, built-in EMA/RSI/ATR signals or data-only external JSON. One selected contract and one bot-owned position at a time. Both Futures wallets must be readable. Classic accounts and USD-M Single-Asset mode are required; Portfolio Margin and delivery contracts are unsupported. Existing manual positions, other bots and Spot records are never adopted.

## Install

- Windows x64: fully extract the ZIP, run its EXE installer, then open Adaptive Futures Bot.
- Debian/Ubuntu x64: extract the ZIP before installing the DEB. If needed, run `sudo apt install ./AdaptiveFuturesBot-0.1.0-linux-amd64.deb` from its directory. Launch Adaptive Futures Bot from the app menu.
- Mac: choose arm64 for Apple Silicon or x64 for Intel. Extract and move Adaptive Futures Bot.app to Applications. The app is unsigned and not notarized. Verify the source and checksums before using the operating system's per-app opening exception; do not disable system protection globally.

The four packages are desktop applications, not mobile apps. Guides and the external JSON example are in the ZIP's Guides folder.

## Connect, review and start

1. In Connection & risk, choose a local vault password of at least 12 characters and repeat it. There is no cloud password recovery.
2. Enter your own Binance mainnet Futures API Key and either its HMAC Secret or matching RSA PEM. Account-read and Futures-trading permissions are required; withdrawal permission is unnecessary. This app does not reuse your Spot Ed25519 key.
3. For RSA, generate/recover the registration public key in the app, register that public key at Binance, then enter the API Key returned by Binance. That API Key is not a private key. The private key stays encrypted locally. The same password recovers the same generated public key.
4. Select the family and perpetual symbol. Read existing Binance settings first. This reads the account, margin mode and leverage without creating an order or changing the account.
5. Choose initial margin of 1%–2% of total Futures equity, direction, mode and leverage. Save the encrypted local configuration. Automatic connection after unlocking is read-only; it does not automatically start trading.
6. If selected mode/leverage differ from the exchange, first be flat, stopped and reconciled, then type `APPLY FUTURES SETTINGS` and explicitly apply them. Only the selected contract is changed. Account-wide One-Way/Hedge mode is preserved. Disable isolated automatic margin addition at Binance before starting.
7. Run a read-only check. Review equity, fees, actual margin mode and leverage, planned margin/notional, signal and protection. Below-minimum allocations are rejected rather than increased without permission.
8. Personally type `START REAL FUTURES TRADING` and start. The strategy checks about every five seconds. Entries use limit IOC and may fill partially or not at all. Accounting uses actual fills. Re-entry waits at least one minute after closing; at most six new entries per hour.

## Margin and risk accounting

The 1%–2% allocation is INITIAL MARGIN, not contract notional. For 1000 USDT total Futures equity, 2% budgets 20 USDT initial margin. At 10x that is approximately 200 USDT notional, subject to filters and rounding. Cross margin may consume other available collateral. The initial margin figure is not a guaranteed maximum loss.

Both Futures wallets are valued together in USDT, including unrealized PNL and changes in collateral-coin prices. Spot holdings are excluded. Trading commissions are recorded on actual executions; funding is recorded as native-asset cash flow. Slippage is embedded in execution prices and is not debited twice. Unexpected transfers, manual trades, liquidation or unexplained fees stop automatic activity for exchange-side review.

The daily boundary is midnight UTC+8. On the first day the app's opening equity is used; later baselines are reconstructed from the ledger and midnight market prices. A decline of MORE THAN 20% locks new long/short entries for the rest of that day, even after recovery. Existing owned positions can still exit. A new day needs a reliable new baseline. This is an entry-stop trigger, not a guaranteed 20% loss cap.

## Protection, stopping and uncertain orders

Entry and exchange stop submission are separate requests, so there is an unprotected interval. The app verifies stop-query capability before entry, then submits a mark-price STOP_MARKET after fills are confirmed. A rejected, unknown or already-crossed stop halts automation and preserves records. Check Binance immediately and personally close if necessary. Neither stop execution nor execution price is guaranteed.

Stopping preserves confirmed exchange stops and existing positions. The explicit market-close button only closes the reconciled bot-owned position and requires the trading confirmation text. After shutdown, local take-profit, trailing exits and monitoring stop; an accepted exchange stop remains subject to exchange processing. Partial exits with mismatched protection quantities require review. Do not repeatedly restart or delete the ledger to bypass an error.

Unknown submissions are queried using the original order ID, never blindly resubmitted. Manual account changes can prevent automatic reconciliation. This edition is not designed to run concurrently with another bot or manual trading in either Futures wallet.

## External rules and review

`example-futures-strategy.json` defines separate long/short entries/exits and bounded price-based stop-loss, take-profit and trailing percentages. Percentages describe underlying price movement, not leveraged margin return. JSON cannot execute code or silently change leverage, margin allocation or the daily guard. Import/reset only when stopped, flat and reconciled, using the vault password.

CSV exports record reconciled orders. Review exports are local Markdown reports with equity, daily baseline, settings, orders, funding and discussion questions. No messages are sent to customers and no paid AI is called automatically. Signals and reports do not promise profitability.

## Local data

- Windows: `%LOCALAPPDATA%/AdaptiveSpotBot/FuturesPersonal`
- Linux: `$XDG_DATA_HOME/AdaptiveSpotBot/FuturesPersonal`, default `~/.local/share/AdaptiveSpotBot/FuturesPersonal`
- Mac: `~/Library/Application Support/AdaptiveSpotBot/FuturesPersonal`

Credentials are encrypted in futures-vault.json; accounting is in futures-ledger.json. Back up the entire directory only after exiting and reconciling orders. Do not delete records to fix account mismatches or run the same account on multiple devices. Previous encrypted vault versions are backed up when saving changes. Keys are not uploaded to Whop or a Cloudflare licensing service.

Native offline startup and fabricated lifecycle acceptance are supplied in the package. Real-account permissions, venue-specific conditional-order behavior and actual fills have not been exercised by the agent. The owner must perform personal live acceptance before any customer delivery.
