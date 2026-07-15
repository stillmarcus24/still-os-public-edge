# GitHub Collaboration Scope — Phase 1

## Repository topology found (this was not previously documented anywhere)

Three genuinely independent git repositories exist, none with a remote configured yet:

| Path | Branch | Size | Contains |
|---|---|---|---|
| `/home/marcus` | `main` | — | Outer StillOS repo. Explicitly `.gitignore`s `core/` as "its OWN embedded git repo" |
| `/home/marcus/still-os-consciousness` | `flagship/prediction-ledger` | 37G | Trading engines, STRAT doctrine, governors, business ops |
| `/home/marcus/core` | `main` | 153M | Founder-ops tooling — CRM, deal desk, decision ledger, corporate rating, discovery engines, **and** the notary/attribution/traffic files this task cares about |

`/home/marcus/core` is not a symlink or submodule of the other two — it's a fully separate `.git` history that happens to live inside `/home/marcus`'s working tree.

## Where the actual target files live

- `core/notary_service_marcus.cjs` — in `/home/marcus/core`
- `core/actor_attribution.cjs` — in `/home/marcus/core`
- `core/live_traffic_server.cjs` — in `/home/marcus/core`
- `deploy/live-traffic-watchdog.sh` — in `/home/marcus/still-os-consciousness/deploy/`
- `deploy-notary.sh`, `rollback-notary.sh` — **do not exist yet anywhere on disk**, need to be written as part of this prep (flagged for Phase 4/5, not invented content, real gap)
- `openapi.json` — two copies found: `sites/nolawealth-site/openapi.json` (the live public one, served) and `still-os-consciousness/state/machine-identity/openapi.json` (looks like a generated/state artifact, not source — needs review before deciding which is canonical)
- `sites/nolawealth-site/` — **not a git repo at all**. This is the live public web root and currently has zero git history of its own (the outer `/home/marcus` repo whitelists it via `!sites/` in its `.gitignore`, so it IS tracked there, just noted for completeness)

## Decision: A (extend existing) vs B (new focused repo)

**Recommendation: B — create the new focused repo, `still-os-public-edge`.**

Evidence against reusing `/home/marcus/core` directly:
1. It is not scoped to the notary/public-edge surface at all — it's ~150+ files of
   unrelated founder-ops tooling (decision ledger, CRM, corporate rating, deal desk,
   anomaly engines). Giving a collaborator write access to this repo means write access
   to all of that, even with CODEOWNERS gates on specific paths.
2. Its `.gitignore` is minimal (`node_modules/`, `*.log`, `.DS_Store`, `__pycache__/`)
   — it does **not** exclude `.bak`, `secrets/`, `.env`, key/cert files, or wallet files.
3. **Confirmed via git history inspection**: two `.bak` files are already committed —
   `notary_service_marcus.cjs.bak-pre-catalog-20260715105322` and
   `notary_service_marcus.v1.cjs.bak.20260714151702`. This is exactly the clutter class
   the brief warned about, and it's already in this repo's history, unaudited.
4. Right now, five separate `.bak-*`/`.v1`/`.v2stage` variants of `notary_service_marcus.cjs`
   sit on disk in `/home/marcus/core`, several created today — a live repo full of
   scratch/debug artifacts is not what a new collaborator should be reviewing PRs against.

This meets the "strong reason" bar the brief set for not just defaulting to the
existing canonical repo. `still-os-consciousness` (Option "keep existing canonical")
was also considered and rejected — the actual notary source doesn't live there at all,
and its 37G size / trading-engine content is even further from what Val needs.

## Included paths (proposed)
- `core/notary_service_marcus.cjs` (from `/home/marcus/core`, the current non-`.bak` version — needs Phase 2 clearance first)
- `core/actor_attribution.cjs`
- `core/live_traffic_server.cjs`
- `deploy/live-traffic-watchdog.sh` (from `still-os-consciousness/deploy/`)
- `site/openapi.json` (canonical copy TBD — see open question below)
- Public site pages under `sites/nolawealth-site/` relevant to discovery/showroom (needs a Phase 2 pass to confirm no secrets embedded)

## Excluded paths
- Everything else in `/home/marcus/core` (CRM, decision ledger, corporate rating, etc.)
- Everything in `still-os-consciousness` except the one watchdog script
- All `.bak*`, `.v1`, `.v2stage` scratch files — treated as source history, not shipped
- `secrets/`, any `.env`, wallet/key material — see Phase 2

## Open question requiring your input before Phase 4
Two `openapi.json` files exist. `sites/nolawealth-site/openapi.json` looks like the
live-served copy; `still-os-consciousness/state/machine-identity/openapi.json` looks
generated (lives under `state/`, which is StillOS's convention for non-source runtime
output, not hand-authored source). I'll treat the `sites/` copy as canonical unless
told otherwise — flag if that's wrong.

## Deploy/rollback scripts
`deploy-notary.sh` and `rollback-notary.sh` don't exist on disk anywhere. They're named
in scope but not yet real. I'll draft them in Phase 4/5 based on how the notary service
is actually currently deployed (need to find the real deploy mechanism — checking next),
not invent one from scratch.

## Correction after cross-checking today's audit memory
The `stillos-notary.service` systemd unit (port 8455, `core/proof_endpoint.cjs`) is
**RETIRED since 2026-07-04** — still installed and runnable, but not routed by Caddy,
not production. I almost documented it as "the" deploy mechanism before catching this.

**Real production deploy mechanism**, confirmed via `ps aux` + Caddy routing check:
port **8466**, `/home/marcus/core/notary_service_marcus.cjs`, launched inside a `bwrap`
sandbox by `still-os-consciousness/deploy/notary-marcus-watchdog.sh` (cron, every 1 min,
self-healing, restarts if not running — this IS the "deploy-notary.sh"/"rollback-notary.sh"
role the brief asked for, just not literally named that). `deploy/caddy-root-guard.sh`
keeps Caddy's live routing pinned to 8466 in case it ever drifts back to the retired port.

Documenting this real mechanism (watchdog + bwrap sandbox + cron self-heal) in
`docs/ARCHITECTURE.md` instead of inventing `deploy-notary.sh`/`rollback-notary.sh` from
nothing — the brief named a script pattern, the box already has the real equivalent,
better to document truth than fabricate parallel scripts that would drift from reality.

## Also found, not yet in scope (flagging, not auto-including)
Three other notary-adjacent live services exist: `signal_endpoint.cjs` (port 8456,
CPI/GDP/portfolio signals), `x402_grade.cjs` (port 8457), `calibrate_api.cjs` (port 8479).
Same x402/payment-boundary risk class as the notary itself. The brief's file list didn't
name these — leaving them out of the first repo unless you want them included. Also:
today's audit found a real, already-fixed signed-receipt leak across 8 endpoints in these
services (see machine-commerce-audit-2026-07-15 memory) — worth knowing before Val gets
anywhere near this code, so I'm including that history in ARCHITECTURE.md as real context,
not routing her toward the still-open unknowns (unfunded x402 wallet, unverified paid-tier
correctness) without flagging them explicitly as unverified.
