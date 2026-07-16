// tests/attribution/classification.test.cjs — real fixture tests over the pure
// classification functions (no live data, no secrets, no server). Regression guard
// for the exact bug class fixed 2026-07-16: a header/path added to funnel/payment
// classification without the real x402 gate recognizing it (ghost payment signal).
'use strict';
const assert = require('assert');
const { highestFunnelStage, parseLine } = require('../../core/actor_attribution.cjs');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); }
  catch (e) { failures++; console.error(`  FAIL  ${name}: ${e.message}`); }
}

check('/notary/verify and /verify both classify as RECEIPT_VERIFIED', () => {
  for (const path of ['/notary/verify', '/verify', '/notary/check', '/check']) {
    const stage = highestFunnelStage([{ path, status: 200, hasPaymentHeader: false }]);
    assert.strictEqual(stage, 'RECEIPT_VERIFIED', `${path} should reach RECEIPT_VERIFIED, got ${stage}`);
  }
});

check('an unrelated path never reaches RECEIPT_VERIFIED', () => {
  const stage = highestFunnelStage([{ path: '/health', status: 200, hasPaymentHeader: false }]);
  assert.notStrictEqual(stage, 'RECEIPT_VERIFIED');
});

check('hasPaymentHeader only recognizes real x-payment headers (x402 protocol), no unverified aliases', () => {
  const real = parseLine(JSON.stringify({ ts: 1, request: { remote_ip: '1.2.3.4', headers: { 'X-Payment': ['abc'] }, uri: '/commit', method: 'POST' }, status: 200 }));
  assert.strictEqual(real.hasPaymentHeader, true, 'X-Payment header must be recognized');

  const ghost = parseLine(JSON.stringify({ ts: 1, request: { remote_ip: '1.2.3.4', headers: { 'Payment-Signature': ['abc'] }, uri: '/commit', method: 'POST' }, status: 200 }));
  assert.strictEqual(ghost.hasPaymentHeader, false, 'Payment-Signature is not a real x402 header and must not be recognized — the actual payment gate (x402-express) only checks X-PAYMENT, so treating an alias as a payment signal here creates a ledger/attribution entry with no corresponding real payment');
});

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll attribution classification checks passed.');
