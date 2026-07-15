# Contributing

## Rules
- **No direct pushes to `main`.** Every change goes through a branch and a pull request.
- **One feature per branch.** Don't bundle unrelated changes.
- **Draft pull requests** for work in progress — mark it "Ready for review" only when
  it's actually done and self-tested.
- **Tests and evidence required.** Run `bash tests/run-all.sh` before opening a PR.
  For anything with a visible/frontend component, include a screenshot in the PR
  description.
- **No secret material, ever.** No `.env` files, no API keys, no wallet addresses tied
  to real funds, no production log excerpts with real IPs. If you're not sure whether
  something is sensitive, leave it out and ask.
- **No production changes from feature branches.** This repo is source and docs. It
  does not deploy itself — see `docs/ARCHITECTURE.md`. Don't add deploy automation that
  writes to the production box without explicit sign-off.
- **Small, reviewable commits.** A PR that's easy to review gets merged faster.

## Branch naming
- `val/<workstream>` — e.g. `val/machine-commerce-dashboard`
- `claude/<workstream>`
- `fix/<issue>`
- `feat/<feature>`

## Commit style
```
feat: add actor journey funnel visualization
fix: correct scanner classification for burst-rate false positive
docs: document endpoint economics for /notary/screen-entity
test: add free-tier signature-leak regression test
chore: update .gitignore for sanitized fixtures
security: <describe, and flag @marcus for review immediately>
```

## What requires explicit founder approval before you touch it
See `CODEOWNERS` — anything touching payment, x402, wallet, signer, receipt-generation,
the notary service's trust boundary, deploy scripts, or proxy/production configuration
requires Marcus's review, no exceptions, regardless of how small the change looks.

## Workflow
```
git checkout main
git pull
git checkout -b val/your-workstream

# ... do the work ...

git add .
git commit -m "feat: describe what you built"
git push -u origin val/your-workstream
```
Then open a **draft** pull request against `main`. Claude and/or Marcus reviews it
against the real architecture before anything is considered for production.
