# GitHub Secret Audit — Phase 2

Scope: the exact files proposed for the new repo (see `github-collaboration-scope.md`).
Method: filename inspection + regex pattern scan for hardcoded secrets (API keys, PEM/SSH
key blocks, 64-hex private-key-shaped strings, AWS/OpenAI/Slack token shapes), plus a
targeted, redacted scan of the systemd unit and watchdog scripts referenced by the deploy
docs. Full findings below; no secret VALUE is printed anywhere in this report or its JSON
twin — only classification, file, and line number.

## Files scanned
- `core/notary_service_marcus.cjs`
- `core/actor_attribution.cjs`
- `core/live_traffic_server.cjs`
- `deploy/notary-marcus-watchdog.sh`
- `deploy/live-traffic-watchdog.sh`
- `deploy/notary-proof-endpoint-watchdog.sh`
- `sites/nolawealth-site/openapi.json`
- `/etc/systemd/system/stillos-notary.service` (referenced for deploy docs, not copied into repo)

## Result: CLEAN — no hardcoded secrets found in any scanned file

Every regex pass (hardcoded `key=`/`token=`/`password=`/`secret=` assignments, PEM/SSH
private-key headers, 64-hex-char strings, AWS `AKIA...`, OpenAI `sk-...`, Slack `xox...`)
returned zero matches across all seven source/script files.

All configuration that looks secret-shaped is correctly sourced via `process.env.*` in
`notary_service_marcus.cjs` — confirmed names only, no values:
`PAYTO`, `NETWORK`, `NETWORK_V`, `SELFHOSTED_FACILITATOR_URL`, `USE_SELFHOSTED_FACILITATOR`,
`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `NOTARY_MARCUS_PORT`, plus several
`PROOF_*_FREE_LIMIT` numeric config vars. This is the correct pattern — env vars loaded
externally (from `secrets/*.env`, never in source), not committed.

The systemd unit's `Environment=` lines (checked separately, names only):
`PROOF_PORT`, `PROOF_HOST`, `PROOF_PUBLIC_BASE` — all non-secret config. **Note: this
specific unit is the retired 8455 service, not being copied into the repo at all** — see
scope doc correction. Checked anyway since it was the first deploy artifact found.

## Classification table

| Item | Classification | Notes |
|---|---|---|
| `process.env.CDP_API_KEY_ID` / `_SECRET` references | Safe public identifier | Names only, referenced correctly, real values live in `secrets/*.env`, not in scope |
| `process.env.PAYTO` reference | Safe public identifier | This env var holds a receiving wallet **address** at runtime, not a private key — addresses are meant to be public. The variable NAME is safe to reference in source; confirming it never gets logged/printed as a literal is a Phase 6 test candidate |
| Watchdog scripts (3 files) | Safe public identifier | Zero matches on any secret pattern; scripts only reference process names, ports, and restart logic |
| `sites/nolawealth-site/openapi.json` | Safe public identifier | Public-facing API discovery doc by design; scanned clean |
| `notary_service_marcus.cjs` — full 116KB file | Safe public identifier | Zero hardcoded secrets across the entire file |

## Not applicable — no existing git history to remediate
This is a **fresh copy into a new repo**, not a migration of `/home/marcus/core`'s
existing git history. The two `.bak` files already committed in `/home/marcus/core`'s
history (`notary_service_marcus.cjs.bak-pre-catalog-*`, `.v1.cjs.bak.*`) are **not**
being carried over — we're copying current file contents fresh, not `git clone`-ing or
importing that repo's history. No history-remediation/credential-rotation flag needed
for this specific new repo. (Whether `/home/marcus/core`'s own separate history needs
its own future cleanup is a different, out-of-scope question — flagging it exists, not
fixing it here.)

## What still needs a human pass before merge-ready
- `sites/nolawealth-site/` beyond `openapi.json` was not fully scanned line-by-line in
  this pass — only the openapi.json was pattern-scanned. If additional site pages are
  added to the repo, they need the same scan before staging.
- This is a regex/pattern audit, not an entropy-based scanner (no tool like `gitleaks`/
  `trufflehog` was available/installed to run as a second method, per the brief's
  "available secret-scanning tools where installed" — confirming none found on this box).
  Recommend running one before the actual push if you want a second, automated method
  layered on top of this manual pass.
