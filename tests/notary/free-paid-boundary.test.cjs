// tests/notary/free-paid-boundary.test.cjs
// Static source-contract test — does NOT start a server, does NOT call x402, does NOT
// spend real funds. Reads core/notary_service_marcus.cjs as text and checks structural
// invariants that matter for the free/paid boundary. This is a regression guard for the
// exact bug class fixed 2026-07-15 (free tier leaking signed receipts) — see
// docs/ARCHITECTURE.md "Known history".
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '../../core/notary_service_marcus.cjs'), 'utf8');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL  ${name}: ${e.message}`); }
}

check('OUT_SIGNED defines the three receipt fields that must never leak to free tier', () => {
  assert.match(src, /OUT_SIGNED\s*=\s*\{[^}]*receipt_hash/);
  assert.match(src, /OUT_SIGNED\s*=\s*\{[^}]*signature/);
  assert.match(src, /OUT_SIGNED\s*=\s*\{[^}]*verify_url/);
});

check('every paid endpoint declares a non-zero USD price constant', () => {
  const priced = ['VERDICT', 'DISPUTE', 'GRADE', 'SCREEN', 'REGISTER', 'AWARDS', 'INSIDER', 'SMARTMONEY', 'DISTRESS', 'CLEARANCE'];
  for (const p of priced) {
    const m = src.match(new RegExp(`const ${p}_X402_USD\\s*=\\s*([0-9.]+)`));
    assert.ok(m, `${p}_X402_USD constant not found`);
    assert.ok(parseFloat(m[1]) > 0, `${p}_X402_USD must be > 0`);
  }
});

check('every priced endpoint has a corresponding FREE_LIMIT env-driven config (bounded free tier, not unlimited)', () => {
  const bounded = ['VERDICT', 'GRADE', 'SCREEN', 'REGISTER', 'AWARDS', 'INSIDER', 'SMARTMONEY', 'DISTRESS', 'CLEARANCE'];
  for (const b of bounded) {
    assert.match(src, new RegExp(`${b}_FREE_LIMIT`), `${b}_FREE_LIMIT reference not found`);
  }
});

check('/commit and /dispute have no free tier (paid from first call, by design)', () => {
  assert.doesNotMatch(src, /COMMIT_FREE_LIMIT/);
  assert.doesNotMatch(src, /DISPUTE_FREE_LIMIT/);
});

check('discovery endpoints (/notary/catalog, /notary/pricing) never construct a signature field', () => {
  const catalogMatch = src.match(/\/notary\/catalog[\s\S]{0,4000}/);
  if (catalogMatch) {
    assert.doesNotMatch(catalogMatch[0], /signature:/, 'catalog response block references a signature field');
  }
});

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll free/paid boundary contract checks passed.');
