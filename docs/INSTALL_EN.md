# Adaptive Spot Bot — installation and operation

Pre-commercial source candidate. **Binance Spot Testnet only; virtual funds.**
This is the original automated bot, not the separate offline EMA replay app.
It reads Testnet market/account data and can submit Testnet spot orders after
explicit local enablement. It contains no production trading adapter, no futures,
no transfers, no withdrawals and no order-cancellation command.

The current default policy is `v3 / adaptive / short`, BTCUSDT. The strategy is
deterministic code, not a chat model watching the market. Nothing starts just
because the ZIP is extracted. Software tests are not evidence of profitability.

## 1. Requirements and a fresh installation

- Install Node.js **24.x** from [the official site](https://nodejs.org/en/download).
- Use a modern browser, a terminal and a permitted connection to
  [Binance Spot Testnet](https://testnet.binance.vision/).
- Windows is the locally checked environment. macOS/Linux instructions require
  separate release testing; do not assume they have been verified here.
- No `npm install`, Python, Docker, Next.js or application database is needed
  for this standalone source package.

Extract into a new empty directory. **Do not start another copy for an account
already managed by an existing bot.** The ZIP excludes position/order state and
is not an account-recovery backup. The exclusive lock only protects one local
directory, not multiple computers or copies using the same account.

In a terminal at the extracted package root, run these offline checks:

```text
node --version
node scripts/virtual-trading.mjs --describe
npm.cmd test
npm.cmd run check
```

On macOS/Linux replace `npm.cmd` with `npm`; PowerShell-specific examples below
are for Windows. Node should report `v24.`. `--describe` does not load the local
credential file, query an account or place orders. Tests use mocks and fixtures;
`check` validates the export allowlist. No run/install hook starts the bot.

If Windows blocks `npm.ps1`, use `npm.cmd` rather than weakening system-wide
execution policy. Do not use an administrator shell just to run this package.

## 2. Set up your own Testnet credentials locally

Sign in to Spot Testnet yourself. Do not use a production Binance key. A browser
login is not the bot's API configuration. Follow the current Testnet UI for API
registration; do not guess new permission labels from an old screenshot.

For a new installation with no existing key pair, run once:

```text
node scripts/testnet-keygen.mjs
```

It creates `.secrets/testnet-ed25519-public.pem` and the matching private PEM,
and refuses to overwrite existing files. Register **only the public key** with
Testnet. Keep the private key local. Enable only the Testnet account-read and
spot-order permissions the bot needs. Read-only permission is not enough to
submit virtual orders. No withdrawal or transfer permission is required.

Create a local config only if it does not already exist. Windows PowerShell:

```powershell
if (Test-Path -LiteralPath '.env.testnet') {
    throw 'Existing configuration: preserve it and review before continuing.'
}
Copy-Item -LiteralPath '.env.testnet.adaptive.example' -Destination '.env.testnet' -ErrorAction Stop
```

Edit `.env.testnet` in your own local editor. All exported credential fields are
blank. For Ed25519, set your Testnet-issued `BINANCE_TESTNET_API_KEY` and set
`BINANCE_TESTNET_PRIVATE_KEY_PATH` to `.secrets/testnet-ed25519-private.pem`.
Leave `BINANCE_TESTNET_API_SECRET` blank. Do not paste a PEM body into a path.

Alternatively, for a supported Testnet HMAC key, set its Testnet API key and
secret locally and leave the private-key path blank. Do not combine both methods.
Ensure the filename is `.env.testnet`, not `.env.testnet.txt`.

Never send credentials, private PEM files, passwords, verification codes, account
records or full private logs to the seller, chat, GitHub or a support form.
Private keys are ordinary unencrypted local files: restrict access and keep
them out of public/shared/synchronized folders. Public-key registration does
not make the matching private file safe to disclose.

The host is fixed to `https://testnet.binance.vision`. Production environment
variables are rejected. Changing keys or a URL is not a supported live switch.

## 3. Preview first; enable virtual orders separately

After checking the account, policy and any existing state:

```text
npm.cmd run virtual:status
npm.cmd run virtual:preview
```

These actions access Testnet. Status reads the test account. Preview evaluates
one strategy check without submitting or persisting a trade. Warm-up or WAIT
can be a valid result; one preview does not promise a BUY. They do not start
continuous execution. Account permission and network errors must be resolved
before enabling orders, without bypassing access restrictions.

For a verified fresh setup, or after reviewing a stopped existing instance:

```text
npm.cmd run virtual:run -- --enable-testnet-orders
```

This is the explicit Testnet-order enablement command. Without the extra flag,
the run action refuses to start. Keep that foreground terminal open. Start only
one runner for the account. Do not use one-off manual test buys to manufacture
strategy trades, erase state, or bypass a WAIT decision.

## 4. Watch the read-only monitor

In a second terminal in the same package directory:

```text
npm.cmd run testnet:dashboard
```

Open [http://127.0.0.1:3001/](http://127.0.0.1:3001/). The monitor binds to
loopback only. Do not expose it through a public port, tunnel or hosted page.
It reads test-account information and reports recorded bot inventory, confirmed
fills, decisions and heartbeats. Some dashboard labels/messages remain Chinese;
this is not advertised as a fully English-translated UI.

A visible page or configured strategy is not proof of a running bot or a fill.
Check timestamps and freshness/error messages. Closing the browser or monitor
does not stop the separate runner. Old values after a failed refresh are stale.

## 5. Default v3 short behavior and limitations

- Approximately five-second decision checks plus network/runtime delays,
  **not an order every five seconds**. Closed one-minute EMA/RSI/ATR and complete
  five-minute context inform trend/rebound routes, momentum, spread and cost gates.
- At most 100 virtual USDT deployed purchase notional per round, staged 40/30/30
  only if the relevant conditions continue to hold. It does not average down or
  sell unrelated/gifted inventory to enlarge a bot position.
- ATR-adjusted exit thresholds are frozen at the initial fill. The one-minute
  soft-exit rule is conditional on cost coverage; the default three-minute
  maximum-hold exit is a local rule, not guaranteed execution by that time.
- Fees, slippage, spread, incomplete fee valuation, latency, dust and exchange
  filters affect the result. The purchase budget is not a guaranteed loss cap.
- Stops/targets are local software decisions, not exchange-hosted protective
  orders. They cannot execute while the machine is asleep, stopped, offline,
  blocked, or unable to resolve an order. Testnet behavior is not production
  liquidity or a validated live-trading edge.

Read `VIRTUAL_TRADING_LOGIC.md` and `QUANT_PROGRAM.md` for full rules and legacy
profile distinctions. `strategies/virtual-only.json` is the current policy.
Do not mix fields from different policy versions or silently migrate inventory.

## 6. Stop, reconcile and recover

```text
npm.cmd run virtual:stop
```

This requests a graceful stop. **It does not liquidate positions or cancel
orders.** Check the last activity and pending-order state. Local exits no longer
operate once stopped. Do not repeatedly resend an uncertain order, delete a
pending client order ID, remove a live lock or erase `.paper-data/` to restart.

An unknown submitted-order result must be queried and reconciled before another
order. Testnet resets may make local records inconsistent; stop and inspect.
Access/region refusals, permissions and rate limits are not grounds to change
hosts or circumvent eligibility rules. Read-only temporary errors can back off;
order submissions are not blindly retried.

For an existing account/installation, preserve credentials and state privately,
stop the original instance and reconcile before moving computers, directories,
keys or strategy versions. Read the migration section of the Chinese guide or
the English recovery section of `QUANT_PROGRAM.md`. Supported adoption is an
explicit reviewed action, not a general repair button or automatic restart.

## 7. Troubleshooting and distribution

- Connection refused at port 3001: check the monitor terminal; this alone does
  not establish that the separate runner stopped.
- WAIT/no new fills: inspect warm-up, cost, trend, spread and entry-limit reasons.
  Never promise a fixed fill interval or remove safeguards to create activity.
- Authentication: check Testnet origin, correct key pair and required permission
  locally. Do not print secrets or supply a production key as a workaround.
- Permission, geography or access refusal: stop and verify permitted access with
  Binance. This package includes no circumvention mechanism.
- Saved/pending order mismatch: stop, preserve the record and reconcile before
  enabling a new run; do not reset the account by deleting local data.

The ZIP checksum and `SOURCE_MANIFEST.json` check content integrity, not publisher
identity, bug absence or profitability. This source candidate is not a finalized
commercial licence, merchant approval or ready-to-charge storefront. Obtain the
actual seller/provider approvals and final terms before selling it.
