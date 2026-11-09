## Multi-symbol update 0.4.0

The desktop selector refreshes the public Spot Testnet catalog of eligible USDT pairs. One symbol runs at a time. Switching requires a stopped, flat current strategy with no pending orders or retained locks; reconnect and explicit start are required. BTC records retain their legacy path; other symbols use markets/SYMBOL/.paper-data. Risk counters remain per symbol, not portfolio-wide. Shared license and exchange key storage are unchanged. The public catalog is not a promise that every production-listed asset exists in Testnet.

# Adaptive Spot Bot — Windows Desktop Subscription Candidate 0.4.0

The 0.4.0 buyer build uses the verified Cloudflare Workers licensing endpoint.

0.4.0 adds confirmed same-account API key rotation. Authenticated Testnet account UIDs
must match before rebinding the existing account tag. When Testnet omits UID, both keys must
authenticate access to the same filled private historical order; matching balances is insufficient.
The entire trading state (including
positions, pending safeguards, orders and daily risk counters) is retained, with exact local
backups. Pending orders, running work, retained locks and unverifiable identity block rotation.
Rotation is GET-only and never starts a worker. It does not reset history or subscription status.
The signing public key, Whop product and monthly plan are unchanged. Older
installers do not automatically switch endpoints; stop and close the app before
repairing/upgrading with the matching installer. Paid-order acceptance remains
pending. The hosting account is on Workers Free with daily request/CPU limits.

Native WPF trading workspace, per-user repair installer and verified Node.js 24.
Uses the existing Testnet strategy with a signed, online subscription gate.
Not the offline EMA replay product. This is not a sale-readiness certificate.

Ordinary users: read QUICKSTART-ZH.txt or QUICKSTART-EN.txt and use Setup.exe.
No trading starts on installation, save, launch or read-only connection test.

## Build from source (developer only)

Windows x64, Node.js 24, .NET Framework 4.8 with the Windows framework C# compiler.
From the extracted source root:

```
node --test tests/*.test.mjs products/adaptive-spot-desktop/desktop*.test.mjs
node products/adaptive-spot-desktop/build.mjs --node "C:\Program Files\nodejs\node.exe" --license "C:\path\to\official-Node-v24.15.0-LICENSE.txt"
```

A normal build fails closed unless license-config.json contains a valid HTTPS
validation URL, Ed25519 PUBLIC key and exact Whop company/product/plan IDs.
This structural check is not a live product, payment or expiry acceptance test.
Only public verifier configuration belongs here; Whop merchant API keys and
private signing keys belong exclusively in the separately deployed service.
Never put them in this repository's desktop package or the buyer app.

For offline packaging QA ONLY, append `--staging`. It deliberately blanks the
packaged license configuration even if the source has production settings.
The output directory/ZIP names and notice identify LOCKED-QA. Its trading stays
locked. Do not upload it as the paid active product or call it production-ready.

The runtime binary and full third-party license must match the pinned official
Node v24.15.0 hashes in build.mjs. Official sources:
https://nodejs.org/dist/v24.15.0/SHASUMS256.txt
https://raw.githubusercontent.com/nodejs/node/v24.15.0/LICENSE

No download/install script runs at buyer install time. Build emits a fresh
versioned directory under exports with buyer ZIP, Setup.exe, source ZIP,
per-file SHA256 manifest and checksums. Source collection is an explicit allowlist,
never an archive of the workspace. No personal dotenv, keys or live records.
The server source and test-license-fixture.mjs are excluded from the buyer engine.
The buyer's derived scripts/testnet.mjs entry has an additional subscription
prelude; the standalone root source CLI is not altered by this packaging step.

## Architecture and guarantees

- Native WPF dashboard-first UI → anonymous-pipe JSON → Node controller → fixed Testnet worker.
- No browser write endpoints, no loopback port dependency, no arbitrary command
  execution, no editable host. All API operations use the original fixed client.
- Windows CurrentUser DPAPI protects credentials and the saved subscription key. PEM files
  are not additionally encrypted; generated files inherit profile-only ACLs.
- Child processes receive an allowlisted environment without NODE_OPTIONS,
  dotenv, production API settings or inherited proxy rewrites.
- User data lives separately in LocalAppData, not in installation files.
- One GUI owns a no-share profile lock; bot retains original state lock and
  pending-order safeguards. Neither protects against other folders/computers.
- No account or record migration. First start requires an unused Testnet account
  or separately reviewed manual migration and no old program-owned positions.
- Start requires explicit confirmations, a successful canTrade=true GET, and a
  fresh signed online entitlement. A UI checkbox/date is never authorization.
- Stop is not liquidation/cancellation; no force-kill, automatic restart or
  safety-lock deletion. Controller EOF and worker IPC disconnect request stop.
- Sticky STOP IPC blocks new fetches even when STOP races runner startup.
- Saved credentials auto-configure only the local controller, never auto-connect
  or auto-start. Failed credential replacement revokes the old client.
- Installer is per-user, no auto-launch, admin request, autostart, system proxy
  change or power setting change. Uninstall retains the private profile.
- Existing installs repair through verified staging, a whole-old-folder retained
  backup and rollback. Unknown additions remain in that reported backup path.
- "Open trading workspace" launches the UI only, not trading.

## Subscription behavior and limits

- Buyers enter their Whop software license, not an exchange API key, on the
  Subscription page. License activation uses the seller's fixed HTTPS service.
  No Binance keys, balances, private keys or trade records are sent to that service.
- The controller rechecks every 30 seconds; signed session-bound leases last
  at most 120 seconds and never beyond the verified paid term. The worker checks
  the grant before outbound work too. 120 seconds is a maximum lease, NOT a
  promised offline grace period or an instantaneous exchange cancellation SLA.
- A failed online check (including outage), expiry or revocation requests a
  graceful stop and blocks new work. In-flight exchange work can still finish.
  There is no automatic trading restart after renewal or network recovery.
- Stopping does not sell holdings or cancel exchange orders. Local stop-loss,
  take-profit and other risk checks STOP TOO. Users must review and manage
  Testnet positions/orders themselves. Local records, read-only account checks
  and the stop request remain available without an active subscription.
- Canceling renewal does not end a valid paid term early: access stops when that
  term expires, unless the platform separately revokes access/refunds it earlier.
- Installing 0.3.0 cannot remotely disable previously distributed 0.2.0 or old
  source copies. Do not keep distributing those as subscription-enforced builds.
  Downloaded local code is not tamper-proof DRM. The separately produced source
  ZIP contains the original standalone CLI and is for developer review, not the
  subscription buyer's downloadable installer.

## Offline QA interfaces

`Setup.exe --verify-payload <new-empty-output-folder>` only extracts and verifies
embedded bytes; no registry/shortcuts/install or account access.

`Setup.exe --self-test-install <new-empty-output-folder>` exercises isolated fresh
install/repair/rollback, fake-profile retention, locks and owned shortcuts, with
no real account profile or Windows app registration modified.

`AdaptiveSpotBot.exe --self-test <new-empty-output-folder>` checks dashboard-first
layout, missing-service locking, credential/subscription DPAPI and the bundled
controller with an EMPTY local account. No network/trade configuration.

`AdaptiveSpotBot.exe --preview-ui` opens a clearly marked offline empty preview;
all account/key/trading controls are disabled. It does not load the real profile.

## Commercial readiness

Unsigned technical candidate with subscription validation code, not a certified
publisher/product. The seller must provision the real service and Whop software
licenses, then verify purchase, active-term start, renewal, cancellation-at-term,
expiry/refund/revocation, outage stopping and manual restart end-to-end before
sale. A syntactically configured build or passing offline QA is not that approval.
Final commercial terms, privacy/refund disclosures, platform/payout eligibility,
update/support scope and independent clean-PC compatibility remain to be reviewed.
No auto-update service, hosted operation or live-money trading is included.
No source rights of third parties are changed by this packaging work; Node's
full upstream notices ship with the bundled runtime.
