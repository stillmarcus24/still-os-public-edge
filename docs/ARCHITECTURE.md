# Architecture

## The planes
1. **Public discovery plane** — `GET /openapi.json` (+ 5 convention aliases:
   `.well-known/openapi.json`, `m2m-openapi.json`, `swagger.json`,
   `.well-known/agent-registration.json`, `.well-known/ucp`), `GET /notary/catalog`,
   `GET /notary/pricing`. No auth, no payment. Exists so AI agents/scrapers can find and
   understand the service without a human reading docs first.
2. **Free preview plane** — most paid endpoints allow a bounded number of free calls per
   agent per day (see `docs/ENDPOINT-ECONOMICS.md`), so a buyer can evaluate quality
   before paying. Free responses deliberately omit the signed receipt fields.
3. **Payment boundary** — x402 (`@x402/express` v2 SDK, `USE_X402_V2=true` in production).
   A request past the free tier gets a 402 response; the SDK delivers the payment
   challenge via a response **header**, not the JSON body — this is the SDK's designed
   behavior, not a bug.
4. **Paid compute** — the actual scoring/lookup logic (OFAC screen, Federal Register
   search, insider conviction scoring, distress score, etc).
5. **Signed receipt** — every paid response is Ed25519-signed, includes `receipt_hash`
   and a `verify_url` for independent verification.
6. **Verification** — the receipt hash + signature can be independently checked against
   the notary's public key without trusting the notary's own claim.
7. **Telemetry / reporting** — `core/actor_attribution.cjs` sessionizes raw Caddy access
   logs into actor journeys (human / scanner / discovery bot / evaluator), with
   behavioral classification, confidence, and evidence. This is the layer the Machine
   Commerce Dashboard (Val's first workstream) builds on top of.
8. **Production deployment** — see below. Deliberately outside this repo's control.

## Production deployment (the real mechanism, not a hypothetical script)
There is no `deploy.sh` you run by hand. The live notary
(`/home/marcus/core/notary_service_marcus.cjs`, port 8466) runs inside a `bwrap`
sandbox, launched and kept alive by a cron'd watchdog script
(`deploy/notary-marcus-watchdog.sh`, checks every minute, restarts on failure — this is
the closest real equivalent to a "deploy/rollback" script). A separate script
(`deploy/caddy-root-guard.sh`, not included in this repo — production-only) keeps
Caddy's live routing pinned to port 8466 in case it ever drifts.

**Important: a second, older notary process exists on port 8455
(`core/proof_endpoint.cjs`) and is retired** (dead since 2026-07-04) — still installed
and technically runnable, but not routed by Caddy, not production. If you ever see
references to port 8455 or `stillos-notary.service` (the systemd unit), that's the
retired path — don't build against it.

Merging a PR to `main` in this repo does **not** deploy anything. Deployment to the
production box is a separate, deliberate, founder-controlled step.

## Known history — read before touching payment-adjacent code
On 2026-07-15, a full audit found and fixed a real production bug: **the free tier on 8
endpoints (across the notary and signal services) was returning full signed receipts**
(`signature`, `receipt_hash`, `verify_url`) instead of stripping them — meaning free
callers could get the same cryptographic proof paid callers get, for nothing. Fixed in
three waves because each fix revealed a differently-shaped instance of the same bug
elsewhere. The lesson that came out of it, worth internalizing before writing tests for
this boundary: grepping for the exact pattern of the first fix misses differently-shaped
leaks of the same underlying bug — check every instance of the free/paid boundary
individually, don't assume one regex catches them all.

## What is genuinely unverified right now (as of 2026-07-15)
- No real end-to-end x402 settlement (discover → 402 → pay → verify) has ever completed
  with a real funded buyer wallet. Everything about the paid path is code-reviewed, not
  transaction-proven.
- `/notary/passport` (listed in `/.well-known/x402`) was never located/audited in the
  last full pass — unknown whether it has the same leak class the other 8 endpoints had.
- Three other notary-adjacent live services exist (`signal_endpoint.cjs` port 8456,
  `x402_grade.cjs` port 8457, `calibrate_api.cjs` port 8479) — not included in this repo,
  same risk class as the notary itself.

Don't state any of the above as "working" or "verified" in docs, PRs, or the public
site — say what's actually been proven vs. what's designed-but-unproven.
