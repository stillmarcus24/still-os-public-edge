# Val Onboarding

Welcome. Read `README.md` and `docs/ARCHITECTURE.md` first — they're short, and they'll
save you from building against the wrong assumptions.

## Your first workstream: Machine Commerce Journey Reporting

The goal: turn raw traffic requests into actor sessions, intentional actions, funnel
stages, and drop-off reasons. `core/actor_attribution.cjs` already does the first pass
of this (sessionizing + classification) — your job is building the reporting/dashboard
layer on top of it, and improving the classification itself where you find gaps.

You can work on:
- Sessionizing requests (grouping by actor, not just by raw hit)
- Grouping automatic asset/API polls separately from intentional actions
- Separating humans, scanners, discovery bots, and evaluators
- Building actor journey cards (what did this actor actually do, in order)
- Showing funnel termination points (where do actors drop off, and can we tell why)
- Documenting endpoint economics (keep `docs/ENDPOINT-ECONOMICS.md` accurate as pricing changes)
- Improving public onboarding copy (README, discovery docs, error messages agents see)
- Testing OpenAPI examples (do the documented request/response shapes actually match reality)
- Creating sanitized reports (`reports/examples/` — real patterns, no real IPs/PII)

## What you must not change without explicit approval
- Signing keys or anything that touches them
- The receipt-generation trust boundary (`OUT_SIGNED`, signature/receipt_hash logic)
- x402 settlement logic
- Payment recipient (`PAYTO` and anything that resolves it)
- Wallet code
- Production Caddy configuration
- Deployment credentials
- Production service restart behavior (the watchdog scripts)

If a task seems to require touching one of these, stop and flag it — don't work around
it by finding an indirect path to the same file. `CODEOWNERS` enforces review on these
paths, but the intent matters more than the mechanism: this is the boundary that keeps
the money rail safe while you build.

## A real bug you should know about before you start
See `docs/ARCHITECTURE.md` → "Known history." Free-tier responses were leaking signed
receipts on 8 endpoints until a fix landed 2026-07-15. If you're writing attribution or
reporting code that touches response payloads, be aware this class of bug exists and
worth a passing check, not because you're expected to re-audit it, but because it's
useful context for understanding what "free" vs "paid" response shapes should look like.

## Getting started
```
git checkout main
git pull
git checkout -b val/machine-commerce-dashboard
```
Work against `tests/fixtures/sanitized/` sample data — you generally won't need a live
running server for this workstream. Open a draft PR early, even before it's done; it's
easier to review incrementally than as one large diff at the end.
