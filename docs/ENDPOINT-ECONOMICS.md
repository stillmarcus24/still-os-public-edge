# Endpoint Economics

Derived directly from `core/notary_service_marcus.cjs` price constants and free-tier
config as of 2026-07-15. Every number below is read from live source, not estimated.

## Classification key
- **Free discovery** — no auth, no payment, meant for bots/agents to find the service
- **Free preview (bounded)** — free up to a daily per-agent limit, then paid
- **Paid, no free tier** — x402-gated from the first call
- **Free, not a paid product** — utility endpoints, never monetized by design

## Endpoints

| Endpoint | Classification | Price | Free tier |
|---|---|---|---|
| `GET /notary/catalog` | Free discovery | — | unlimited |
| `GET /notary/pricing` | Free discovery | — | unlimited |
| `GET /openapi.json` + 5 discovery aliases | Free discovery | — | unlimited |
| `POST /commit` | Paid, no free tier | $0.10 | none |
| `POST /dispute` | Paid, no free tier | $1.00 (bonded, non-refundable either way) | none |
| `POST /claim-verdict` | Free preview (bounded) | $0.25 | `VERDICT_FREE_LIMIT`/agent/day (+ reputation bonus for repeat, well-calibrated agents) |
| `POST /grade-strategy` | Free preview (bounded) | $0.25 | `GRADE_FREE_LIMIT`/agent/day |
| `POST /screen-entity` | Free preview (bounded) | $0.02 | `SCREEN_FREE_LIMIT`/agent/day |
| `POST /regulatory-rules` | Free preview (bounded) | $0.02 | `REGISTER_FREE_LIMIT`/agent/day |
| `POST /federal-awards` | Free preview (bounded) | $0.02 | `AWARDS_FREE_LIMIT`/agent/day |
| `POST /insider-conviction` | Free preview (bounded) | $0.10 | `INSIDER_FREE_LIMIT`/agent/day |
| `POST /smart-money` | Free preview (bounded) | $0.10 | `SMARTMONEY_FREE_LIMIT`/agent/day |
| `POST /distress-score` | Free preview (bounded) | $0.15 | `DISTRESS_FREE_LIMIT`/agent/day |
| `POST /agent-clearance` | Free preview (bounded) | $0.75 | `CLEARANCE_FREE_LIMIT`/agent/day |
| `POST /register-policy` | Free, not a paid product | — | unlimited |
| `POST /authorize` | Free, not a paid product | — | unlimited |

Every `_FREE_LIMIT` value is an env var (`process.env.PROOF_*_FREE_LIMIT`), not a
hardcoded number — tunable without a code change. Actual current values weren't printed
here on purpose (operational config, not architecture); check `secrets/*.env` on the
production box if you need the live number.

## Pricing logic, as documented in source (not invented here)
- Pure data pass-through endpoints (screen-entity, regulatory-rules, federal-awards) are
  priced at $0.02 — "matches the x402 market norm for data-lookup endpoints ($0.01-0.02/call)"
- Proprietary scoring endpoints (insider-conviction, smart-money) are priced at $0.10 —
  "not a data pass-through," priced like grade-strategy
- distress-score is priced highest of the scoring tier ($0.15) — "flagship validated
  thesis (71% sens / 100% spec / ~109d lead)"
- dispute is priced high ($1.00) deliberately as an anti-spam measure — bonded and
  non-refundable regardless of outcome (no escrow/refund logic exists)

## What every paid response includes
Every paid (x402-settled) response is Ed25519-signed and includes `receipt_hash`,
`signature`, and a `verify_url`. **The free tier strips these three fields** — this was
a real, recently-fixed leak (see `docs/ARCHITECTURE.md` → "Known history") across 8
endpoints where the free tier was accidentally returning full signed receipts.

## What is NOT yet verified (real, current unknowns — not swept under the rug)
- The *paid* branch of every endpoint (does payment settlement actually deliver the
  correct signed receipt end-to-end) has never been tested with a real, funded x402
  buyer wallet. No such wallet exists on the box as of this writing.
- Real end-to-end settlement (discover → 402 → pay → verify) has never happened once,
  by any real external buyer, on any endpoint. Everything above describes designed and
  code-reviewed behavior, not proven transaction outcomes.

If your work involves anything that assumes a completed real payment, flag it and check
with Marcus before building further on that assumption.
