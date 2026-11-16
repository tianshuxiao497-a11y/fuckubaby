# Adaptive Spot Bot — Live Personal Desktop 0.2.0

This is the seller's self-run Binance Spot mainnet edition. It has actual order execution code and uses real funds only after the owner configures an account and explicitly starts trading. The customer subscription edition remains a separate release.

## Install and open

- Windows x64: extract the complete ZIP, run its EXE installer, then open **Adaptive Spot Bot Live**.
- Mac: choose Apple Silicon (arm64) or Intel (x64), extract the ZIP, and move **Adaptive Spot Bot Live.app** into Applications.
- Ubuntu/Debian x64: extract the ZIP and install its DEB, then open the app from the application menu.

The desktop workspace includes closed-candle price history, program equity, positions, reconciled orders, strategy import, connection settings, activity, and help. Windows and Mac builds are unsigned; the Mac app is not notarized. Closing the app stops the local strategy and its exit management.

## Connect your own account

1. Create an official Binance mainnet Spot API with read and Spot trading access. Enter credentials only on your own computer.
2. Use HMAC Key/Secret, or choose Ed25519. For Ed25519, enter a vault password of at least 12 characters and choose **Generate / recover registration public key**. Register the public key with Binance, then enter the API Key returned by Binance. The API Key is not the private key.
3. The registration private key is encrypted immediately when generated. Recover it with the same password after reopening instead of creating another pair. You may also import your existing PEM.
4. Set the trading pair and percentage of available program USDT per buy. The default is 1%; the owner can change it. There is no fixed dollar order cap or capital cap. The first account check uses the account's available USDT as the program ledger's initial capital, so arrange the funds you intend to use first.
5. Save the encrypted vault. You can enable automatic read-only connection after unlocking. Connection and checking do not submit orders.
6. Review account, signal, fees and exchange minimums. Type **START REAL SPOT TRADING** yourself and start the strategy. It checks about every five seconds, with orders only when the strategy and guards permit.

After unlocking, use **Apply market and sizing** with the existing vault password to update the pair or percentage without re-entering API credentials. Active program inventory and unresolved orders constrain changes. Existing manual holdings are not adopted.

## Strategies and risk

The built-in strategy uses EMA, RSI, ATR, market context and costs. Import a local JSON strategy from the workspace, or restore the built-in strategy. Version 1 from the Testnet app is supported; version 2 additionally sets `sizing.buyPercent`. The sample is in this package. JSON files are bounded data rules, not executable Python or JavaScript plugins.

The program uses limit IOC orders, exact decimal quantities and actual fill fees. It waits when the exchange's minimum size or notional is not met; it does not automatically increase the order amount.

Daily loss is measured against program equity at midnight UTC+8, including owned inventory and estimated exit fees. The first day starts at initial ledger creation. A 20% decline locks new buys for that day, even if equity later recovers. Existing program positions continue their exit rules while the program remains running. The threshold is a trigger, not a guarantee that losses cannot exceed 20%.

## Reconnection, stop and recovery

Network failure disarms execution. Automatic connection uses read-only retries with backoff. Recovery does not automatically resume trading: review and start again yourself. Unknown submission results retain a durable pending intent; reconciliation queries its original order ID instead of submitting again.

Use the reconciliation action for unresolved program orders. Manual and unrelated orders are not automatically cancelled. Keep the app open and the computer online while relying on local position management. Small unsellable remainders remain in the ledger.

Vault updates retain an encrypted backup in the local profile's `backups` directory. These files and the local ledger belong to the owner and must not be included in any customer download. A lost vault password requires reconfiguring credentials.

## Records and review

Export CSV for the program's reconciled order history. Export the Markdown review report for fees, daily results, signal context and discussion prompts. The report is created locally and does not use a paid AI service. Activity logs omit API credentials and private keys.

This personal edition does not require a Whop customer license. Do not distribute it as the subscription-gated customer product. The existing Testnet product, monthly licenses and download URLs remain separate. No real-account execution is performed as part of the offline native acceptance tests; their results are included in the package.
