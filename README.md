# still-os-public-edge

**[stillosdigitalholdings.com](https://stillosdigitalholdings.com)** — the product this repo is the public edge for.

The public-facing surface of StillOS's Notary service — the part designed for machine
buyers (AI agents, scrapers, discovery bots) to find, evaluate, and pay for signed data
verdicts via [x402](https://x402.org). This repo is the **collaborative development
layer**: source, tests, and docs for the public edge, kept deliberately separate from
production secrets, wallet configuration, and live deployment credentials.

## What's in here right now
- `core/notary_service_marcus.cjs` — the notary service itself (x402-gated endpoints,
  free/paid tiering, signed receipts)
- `core/actor_attribution.cjs` — sessionizes raw traffic into actor journeys with
  behavioral classification (human / scanner / discovery bot / evaluator)
- `core/live_traffic_server.cjs` — live traffic feed server
- `deploy/*-watchdog.sh` — the real self-healing deploy mechanism (see ARCHITECTURE.md —
  there's no separate "deploy script" to run by hand; a cron'd watchdog keeps the
  service alive inside a sandbox)
- `site/openapi.json` — the public API discovery document served at `/openapi.json`

## Local development
This is Node.js (CommonJS, `.cjs`). No build step. To read/modify a service file:

```
node -c core/notary_service_marcus.cjs   # syntax check only, does not start a server
```

Running the actual service locally requires environment variables this repo
intentionally does not ship (`PAYTO`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, etc. — see
`docs/ARCHITECTURE.md` for the full list of names, never values). If your work doesn't
require a live-running server — most of the Machine Commerce Dashboard work won't —
work against `tests/fixtures/sanitized/` sample data instead.

## Architecture
See `docs/ARCHITECTURE.md` for the full picture: discovery plane, free preview plane,
payment boundary, paid compute, signed receipts, verification, and how production
deployment (which stays outside this repo) relates to this source.

## Testing
```
bash tests/run-all.sh
```
Runs syntax checks, OpenAPI schema validation, and free/paid boundary contract tests.
**Never calls real x402 settlement or spends real funds** — see `tests/README.md` for
what's mocked vs real.

## Branch workflow
No direct pushes to `main`. Every change goes through a feature branch and a pull
request. See `CONTRIBUTING.md` for the full workflow, branch naming, and commit style.

## Production deployment is separate
This repo contains **source only**. The live service runs from
`/home/marcus/core/notary_service_marcus.cjs` on the production box, inside a sandboxed
process managed by a cron'd watchdog script — not from a `git pull` in this repo.
Merging a PR here does not deploy anything; deployment is a deliberate, separate,
founder-controlled step. See `docs/ARCHITECTURE.md` → "Production deployment" for the
real mechanism.
