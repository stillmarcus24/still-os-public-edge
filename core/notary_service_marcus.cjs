#!/usr/bin/env node
/*
 * notary_service_marcus.cjs — a marcus-owned notary service. Runs as whatever
 * user starts it (marcus), supervised by cron (see deploy/notary-marcus-crontab.txt),
 * not systemd. No root is ever involved in restarting, deploying, or healing this.
 *
 * Why this exists: stillos-notary.service runs as a sandboxed low-privilege
 * user, which is good security isolation but means only root can restart it.
 * That's an acceptable tradeoff when restarts are rare and root is available.
 * It stops being acceptable when root is NOT available and a restart is the
 * only recovery path. This service sidesteps that entirely: it's marcus-owned,
 * so restarting it is exactly as privileged as running any other command in
 * this session -- none.
 *
 * Reuses core/notary_recovery_signer.cjs's already-proven commit/verdict logic
 * unchanged. Adds: a persistent HTTP listener, the same self-healing secrets
 * watcher pattern from proof_endpoint.cjs, and a /health endpoint.
 *
 * Port: 127.0.0.1:8466 (does not conflict with stillos-notary's 8455).
 * Not exposed publicly by Caddy -- that's a deliberate, separate decision
 * (see deploy notes). This is the always-available internal signing path;
 * the public-facing decision (whether to point Caddy here) is Marcus's call,
 * not something this script does on its own.
 */
'use strict';
// Crash containment (2026-07-12): a single failing request must never take down
// the whole notary. The x402-express payment middleware throws an unhandled
// rejection when the facilitator returns an error status (e.g. a replayed-nonce
// settle), which was crash-looping this service. Log and survive instead of dying.
process.on('unhandledRejection', (e) => { try { console.error('[notary-marcus] unhandledRejection (contained):', (e && e.message) || e); } catch {} });
process.on('uncaughtException', (e) => { try { console.error('[notary-marcus] uncaughtException (contained):', (e && e.message) || e); } catch {} });
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const signer = require('./notary_recovery_signer.cjs');
let edgeGate; try { edgeGate = require('/home/marcus/still-os-consciousness/quant/edge_gate.cjs'); } catch { /* edge gate optional */ }
let ofacScreen; try { ofacScreen = require('./ofac_screen.cjs'); } catch { /* screen route optional */ }
let fedRegister; try { fedRegister = require('./federal_register_lookup.cjs'); } catch { /* optional */ }
let usaSpending; try { usaSpending = require('./usaspending_lookup.cjs'); } catch { /* optional */ }
let insiderConviction; try { insiderConviction = require('./insider_conviction_lookup.cjs'); } catch { /* optional */ }
let smartMoney; try { smartMoney = require('./smart_money_lookup.cjs'); } catch { /* optional */ }
let distressScore; try { distressScore = require('./distress_score_lookup.cjs'); } catch { /* optional */ }
let agentClearance; try { agentClearance = require('./agent_clearance.cjs'); } catch { /* optional */ }

const PORT = process.env.NOTARY_MARCUS_PORT || 8466;
const HOST = '127.0.0.1';
const DIR = '/home/marcus/still-os-consciousness/state/proof-notary';
const LEDGER = path.join(DIR, 'receipts.jsonl');
const SPLITFILE = path.join(DIR, 'notary-key-split.json');
const USAGE = path.join(DIR, 'usage.json'); // shared with the original service -- one meter, not two

// Findings feed -- real ticker+status+receipt_hash per real /distress-score
// call, for the homepage's live dispatch marquee (2026-07-07). Deliberately
// NOT hardcoded demo data: the site's entire thesis is "every number is real
// and recomputable," so the marquee only ever shows what actually happened.
// Starts empty and fills up as real visitors run real checks.
const FINDINGS_FEED = path.join(DIR, 'findings-feed.jsonl');
const FINDINGS_FEED_CAP = 200;
function appendFindingsFeed(entry) {
  try {
    fs.appendFileSync(FINDINGS_FEED, JSON.stringify(entry) + '\n');
    const lines = fs.readFileSync(FINDINGS_FEED, 'utf8').split('\n').filter(Boolean);
    if (lines.length > FINDINGS_FEED_CAP) fs.writeFileSync(FINDINGS_FEED, lines.slice(-FINDINGS_FEED_CAP).join('\n') + '\n');
  } catch (e) { console.error('[notary-marcus] findings feed append failed:', e.message); }
}
function readFindingsFeed(limit) {
  try {
    return fs.readFileSync(FINDINGS_FEED, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .slice(-limit).reverse();
  } catch { return []; }
}

// ── admin auth + self-restart, ported from proof_endpoint.cjs 2026-07-07 ──────
// Same admin key file, same fresh-read-not-cached pattern (a process that
// booted with a bad key read must still be able to authorize its own repair).
function readAdminKeyFromDisk() { try { return fs.readFileSync('/home/marcus/still-os-consciousness/secrets/notary-admin.key', 'utf8').trim(); } catch { return null; } }
let ADMIN_KEY = readAdminKeyFromDisk();
function isAdmin(req, u) {
  if (!ADMIN_KEY) return false;
  const k = (u && u.searchParams.get('k')) || req.headers['x-admin-key'] || '';
  const A = Buffer.from(String(k)), B = Buffer.from(ADMIN_KEY);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ── Pricing, enforced (not just documented) ──────────────────────────────────
// Reuses the exact same x402-express library + facilitator config as the
// original service -- not a reimplementation of payment verification. Ported
// here 2026-07-04 after a launch-post review caught that this service had
// signing but no payment enforcement: /commit was free and unmetered, which
// contradicted every public statement about pricing. Fixed before shipping.
try {
  const envFile = '/home/marcus/still-os-consciousness/secrets/calibrate-mainnet.env';
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* facilitator falls back to default if this file is absent */ }

// Free-tier defaults raised 2026-07-06 -- the wallet-funding tax (an agent needs a
// funded Base/USDC wallet before it can pay at all) was the top conversion blocker
// found in the live audit that day. This doesn't remove that requirement -- it delays
// it, giving a real caller much more room to feel the product's value before ever
// needing a wallet. Same per-agent-per-day rate limiter as before (same Sybil exposure
// already accepted at the old numbers); this is a bigger number on the same mechanism,
// not a new credit pool or a new attack surface.
const VERDICT_FREE_LIMIT = parseInt(process.env.PROOF_VERDICT_FREE_LIMIT || '3', 10);
const VERDICT_X402_USD = 0.25;
const DISPUTE_X402_USD = 1.00; // bonded, non-refundable either way -- anti-spam, no escrow/refund logic (see core/verdict_dispute_DESIGN.md)
const GRADE_X402_USD = 0.25; // edge-gate grade-strategy -- same price as the sandboxed service's paid tier
// 5→2 (2026-07-12, ICP-test): grade-strategy + agent-clearance are the ONLY two
// products with real repeat external demand (2 Alibaba-HK agents, ~75 calls, ~50
// throttles, $0 converted). Free returns the full answer, so heavy users never need
// to pay. Tightening the daily cap forces the conversion moment sooner — a live test
// of whether those callers are ICP (pay) or scrapers (leave). Reversible via env.
const GRADE_FREE_LIMIT = parseInt(process.env.PROOF_GRADE_FREE_LIMIT || '2', 10);
const SCREEN_X402_USD = 0.02; // OFAC SDN name screen -- matches the x402 market norm for data-lookup endpoints ($0.01-0.02/call)
const SCREEN_FREE_LIMIT = parseInt(process.env.PROOF_SCREEN_FREE_LIMIT || '5', 10);
const REGISTER_X402_USD = 0.02;
const REGISTER_FREE_LIMIT = parseInt(process.env.PROOF_REGISTER_FREE_LIMIT || '15', 10);
const AWARDS_X402_USD = 0.02;
const AWARDS_FREE_LIMIT = parseInt(process.env.PROOF_AWARDS_FREE_LIMIT || '15', 10);
const INSIDER_X402_USD = 0.10; // proprietary scoring over public filings, not a data pass-through -- priced like grade-strategy
const INSIDER_FREE_LIMIT = parseInt(process.env.PROOF_INSIDER_FREE_LIMIT || '3', 10);
const SMARTMONEY_X402_USD = 0.10;
const SMARTMONEY_FREE_LIMIT = parseInt(process.env.PROOF_SMARTMONEY_FREE_LIMIT || '3', 10);
const DISTRESS_X402_USD = 0.15; // flagship validated thesis (71% sens / 100% spec / ~109d lead) -- live per-ticker SEC fetch
// This is the actual hero-demo endpoint as of 2026-07-06 -- raised the most of any tier.
const DISTRESS_FREE_LIMIT = parseInt(process.env.PROOF_DISTRESS_FREE_LIMIT || '3', 10);
// Priced against a live scan of the x402 Bazaar (2026-07-06): real, currently-operating
// competitors charge $1.00-$1.50/call for this exact bundle shape (OFAC + on-chain wallet
// signal -> CLEAR/REVIEW/BLOCK). This version is deliberately narrower in scope than the
// $1.50 competitor (no mixer screening, no multi-hop fund-flow forensics -- not built, not
// claimed) so it's priced below it, not at parity with a broader claim.
const CLEARANCE_X402_USD = 0.75;
const CLEARANCE_FREE_LIMIT = parseInt(process.env.PROOF_CLEARANCE_FREE_LIMIT || '2', 10); // 5→2 ICP-test, see GRADE_FREE_LIMIT note
// Machine value boundary, 2026-07-15: /findings-feed and /export were fully free,
// unlimited, no auth -- confirmed live that findings-feed is also called by our OWN
// homepage marquee (real UX dependency, not just bots), so this is a free-tier
// guardrail, not a blanket paywall -- 20/day covers a real visitor's session many
// times over and only bites at scrape volume. /export has no frontend caller at all
// (confirmed against site JS) -- pure bulk-corpus pull, gated from the first call
// past a small preview. Priced below the cheapest existing read-tier ($0.02) since
// this is a read of already-computed data, not new compute.
const FINDINGS_FEED_X402_USD = 0.005;
const FINDINGS_FEED_FREE_LIMIT = parseInt(process.env.PROOF_FINDINGS_FEED_FREE_LIMIT || '20', 10);
const EXPORT_X402_USD = 2.00; // flat per full pull, not metered per-record -- corpus is still small (~900 receipts); revisit as per-1000-records pricing once it's 5,000+
const EXPORT_PREVIEW_LIMIT = 10;
const PAYTO_X402 = process.env.PAYTO || '0xfAB07d26F7627fc4cE459ecf90d7E015F7eEcE71';
const NET_X402 = process.env.NETWORK || 'base';

// Bazaar discovery extension (2026-07-13): x402 Bazaar's indexer needs a declared
// extensions.bazaar.info block (input/output shape + example) to actually index a
// resource for search -- a bare accepts[] array gets crawled but not indexed, which
// is why this service was invisible on Coinbase's Agentic.Market despite 6 discovery
// crawlers hitting it for weeks. See CoinbaseBazaarDiscovery in discovery-graph.json.
function bazaarExt(inputExample, outputExample) {
  return { bazaar: { info: {
    input: { type: 'http', method: 'POST', bodyType: 'json', body: inputExample },
    output: { type: 'json', example: outputExample },
  } } };
}

// P0 fix (2026-07-08): every request carrying X-Payment gets exactly one immutable
// ledger line at the response boundary, regardless of which branch inside the
// third-party x402-express middleware decides the outcome. Prior to this, this file
// had NO payment ledger write at all -- not even a success-only one -- across any of
// its 11 paid routes. Root cause found via a Payment Evidence Trace: a real x402
// payment attempt left zero trace anywhere on the box because nothing here ever wrote
// one. This hook fires on res.on('finish') -- unconditional, can't be short-circuited.
const PAY_LEDGER = path.join('/home/marcus/still-os-consciousness/state/proof-notary', 'notary-payments.jsonl');
function logPaymentAttempt(req, res) {
  try {
    const hdr = req.headers['x-payment'] || req.headers['payment-signature'];
    if (!hdr) return; // only requests that actually carried a payment attempt are logged here
    const status = res.statusCode;
    let network = null, amount_usd = null, payer_wallet = null;
    try {
      const decoded = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
      network = decoded.network || null;
      const auth = decoded && decoded.payload && decoded.payload.authorization;
      const val = auth && auth.value;
      if (val != null && !isNaN(Number(val))) amount_usd = Number(val) / 1e6; // USDC, 6 decimals
      // payer wallet drives the self-deception rail in payment_notifier.cjs: a
      // wash transaction from an own-wallet must never be counted as external
      // revenue. Without this field the notifier fell back to source_ip and
      // mislabeled our own facilitator traffic (over the box public IP) as a
      // real counterparty. Persist the on-chain payer so the rail can see it.
      if (auth && auth.from) payer_wallet = String(auth.from);
    } catch { /* undecodable token -- network/amount/payer stay null, never guessed */ }
    let failure_class = 'unknown';
    if (status >= 200 && status < 300) failure_class = 'app_success';
    else if (status === 402) failure_class = 'rejected_by_x402_middleware';
    else if (status >= 500) failure_class = 'app_error';
    const row = {
      ts: new Date().toISOString(),
      route: req.url,
      method: req.method,
      status,
      source_ip: req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || null,
      user_agent: req.headers['user-agent'] || null,
      x_payment_present: true,
      x_payment_hash: crypto.createHash('sha256').update(String(hdr)).digest('hex').slice(0, 16), // never the raw token
      network,
      amount_usd,
      payer_wallet,
      settled: status >= 200 && status < 300,
      failure_class,
    };
    fs.appendFileSync(PAY_LEDGER, JSON.stringify(row) + '\n');
    // Real-time founder alert (email + telegram). Fire-and-forget, self-dedupes,
    // never awaited, never throws into the payment path.
    try { require('/home/marcus/core/payment_notifier.cjs').onPaymentEvent(row); } catch { /* notifier optional */ }
  } catch (e) { /* observability must never crash the payment path */ }
}
function dispatchX402(req, res) {
  res.on('finish', () => logPaymentAttempt(req, res));
  app402(req, res);
}

// API-key auth for /commit (2026-07-08) -- ported from proof_endpoint.cjs's keyValid().
// Closes the real blocker found while scoping the 8455 retirement: 4 internal callers
// (stillos_mcp_server.cjs, stillos_agentkit_provider.cjs, signal_endpoint.cjs,
// stillos_autonomous_agent.cjs) commit via x-api-key, not x402 -- they were silently
// still talking to the deprecated 8455 service because this file's /commit was x402-only.
// Reads the SAME api-keys.json both services already share -- sk_notary_stillos_internal_001
// and sk_internal_signal_autocommit are real, already-active keys, not new ones.
// Deliberately /commit-only, not ported to the other 10 x402 routes -- no known internal
// caller needs API-key auth on those, so this stays the minimum fix for the actual gap.
const API_KEYS_FILE = '/home/marcus/still-os-consciousness/state/proof-notary/api-keys.json';
function keyValid(k) {
  if (!k) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8'))[k];
    return rec && rec.active ? rec : null;
  } catch { return null; }
}
function handleCommitWithKey(req, res, apiKeyRecord) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try {
      const b = JSON.parse(body || '{}');
      if (!b.agent || !b.claim) return send(res, 400, { error: 'agent and claim required' });
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({
        agent: b.agent, claim: b.claim, privateKey, notary_fp,
        actor_evidence: actorClassifier.classify({
          agent_id: b.agent, source_ip, user_agent: req.headers['user-agent'] || null,
          api_key_record: apiKeyRecord, api_key_raw: req.headers['x-api-key'] || null,
        }),
      });
      receipt.tier = 'key';
      try { receipt.bond_ref = require('/home/marcus/core/notary_bond.cjs').bondRef(); } catch { /* bond optional to the receipt path */ }
      return send(res, 200, receipt);
    } catch (e) { return send(res, 400, { error: e.message }); }
  });
}

// x402 Bazaar discovery metadata (2026-07-12): every discoverable route now carries an
// inputSchema (request body shape) + outputSchema (response shape). x402-express spreads
// inputSchema into the 402's accepts[].outputSchema.input and passes outputSchema through
// as .output -- the exact fields the CDP facilitator catalogs and a buyer agent reads to
// call us. Prior state: routes were discoverable:true but shape-less, so even after a real
// settlement the listing had nothing to index/render. Descriptions unchanged.
const OUT_SIGNED = { receipt_hash: 'sha256 hex of the canonical claim', signature: 'Ed25519 signature (base64)', verify_url: 'GET URL that re-verifies this receipt', ts: 'ISO8601 issue time' };
let app402 = null;
// x402 v2 (2026-07-14): additive, env-gated. USE_X402_V2=true switches the payment
// gate from x402-express (v1) to @x402/express (v2, vendored isolated at
// core/vendor/x402v2/node_modules, resolved via NODE_PATH). v2 emits the Bazaar
// discovery extension INSIDE every 402 (per-route input/output schema) -- the
// metadata Coinbase's Bazaar indexer needs to actually list a resource; v1's bare
// discoverable:true was crawled but never indexed. Default (flag unset/false) is
// byte-for-byte the same v1 path that has been live and proven since 2026-07-04 --
// this branch changes NOTHING for the current production behavior until explicitly
// flipped. Root-caused before this was ever attempted: the earlier CDP facilitator
// path 401'd (dead CDP key) AND v2's resource server hardcodes x402Version=2 when
// checking facilitator support, which our facilitator didn't advertise, AND v2
// requires CAIP-2 network strings ('eip155:8453') while the v1 verify/settle
// primitives only know the plain chain name ('base'). All three fixed and proven
// in an isolated scratch test (ports 8468/8486) before this file was ever touched:
// core/x402_facilitator.cjs now advertises both kinds and normalizes CAIP-2 -> v1
// chain names before calling verify/settle.
const USE_X402_V2 = process.env.USE_X402_V2 === 'true';
try {
  const express = require('/home/marcus/still-os-consciousness/node_modules/express');
  app402 = express();
  app402.use(express.json());

  if (USE_X402_V2) {
    const { paymentMiddleware: pmw2, x402ResourceServer } = require('@x402/express');
    const { ExactEvmScheme } = require('@x402/evm/exact/server');
    const { HTTPFacilitatorClient } = require('@x402/core/server');
    const { bazaarResourceServerExtension, declareDiscoveryExtension } = require('@x402/extensions/bazaar');
    const NET_V2 = process.env.NETWORK_V2 || 'eip155:8453'; // Base mainnet, CAIP-2
    const fc2 = new HTTPFacilitatorClient({ url: process.env.SELFHOSTED_FACILITATOR_URL || 'http://127.0.0.1:8467' });
    const rs = new x402ResourceServer(fc2);
    rs.register(NET_V2, new ExactEvmScheme());
    rs.registerExtension(bazaarResourceServerExtension);
    const R = (price, description, input, inputSchema, output) => ({
      accepts: { scheme: 'exact', price, network: NET_V2, payTo: PAYTO_X402 },
      description,
      extensions: declareDiscoveryExtension({ method: 'POST', bodyType: 'json', input, inputSchema, output }),
    });
    const S = (props, required) => ({ properties: props, required });
    const routesV2 = {
      'POST /commit':             R('$0.10',                    'StillOS Notary — commit a claim hash (tamper-evident, Ed25519-signed receipt)', {agent:'stillos',claim:'x'}, S({agent:{type:'string'},claim:{}}, ['agent','claim']), {example:{receipt_hash:'0x',signature:'0x',tier:'x402'}}),
      'POST /claim-verdict':      R(`$${VERDICT_X402_USD}`,     'StillOS Notary — signed claim verdict, resolved against external ground truth, Ed25519-signed, hash-chained', {agent:'stillos',claim:'x',resolver:{}}, S({agent:{type:'string'},claim:{type:'string'},resolver:{type:'object'}}, ['agent','claim','resolver']), {example:{verdict:'CONFIRMED'}}),
      'POST /dispute':            R(`$${DISPUTE_X402_USD}`,     'StillOS Notary — file a bonded dispute against a verdict receipt, resolved by independent re-run', {agent:'stillos',receipt_hash:'0x'}, S({agent:{type:'string'},receipt_hash:{type:'string'}}, ['agent','receipt_hash']), {example:{dispute_id:'0x'}}),
      'POST /grade-strategy':     R(`$${GRADE_X402_USD}`,       'StillOS Edge-Gate — grade a settled strategy track record: REAL_EDGE|REGIME_LUCK|NEGATIVE_EV|INSUFFICIENT_DATA, out-of-sample + fee/slippage adjusted, Ed25519-signed', {agent:'stillos',trades:[]}, S({agent:{type:'string'},trades:{type:'array'}}, ['agent','trades']), {example:{verdict:'REAL_EDGE'}}),
      'POST /screen-entity':      R(`$${SCREEN_X402_USD}`,      'StillOS — OFAC SDN sanctions name screen, signed receipt, source_as_of freshness timestamp included', {agent:'stillos',entity:'Acme Corp'}, S({agent:{type:'string'},entity:{type:'string'}}, ['agent','entity']), {example:{match:false}}),
      'POST /regulatory-rules':   R(`$${REGISTER_X402_USD}`,    'StillOS — Federal Register recent-rules search (agency/keyword), signed receipt', {agent:'stillos',agency:'EPA',keyword:'water'}, S({agent:{type:'string'},agency:{type:'string'},keyword:{type:'string'}}, ['agent']), {example:{rules:[]}}),
      'POST /federal-awards':     R(`$${AWARDS_X402_USD}`,      'StillOS — USAspending.gov top-100-by-amount award snapshot search (recipient/min_amount), signed receipt', {agent:'stillos',recipient:'Boeing'}, S({agent:{type:'string'},recipient:{type:'string'},min_amount:{type:'number'}}, ['agent']), {example:{awards:[]}}),
      'POST /insider-conviction': R(`$${INSIDER_X402_USD}`,     'StillOS — proprietary insider cluster-buy conviction scoring (EDGAR Form 4), distress cross-referenced, signed receipt', {agent:'stillos',ticker:'AAPL'}, S({agent:{type:'string'},ticker:{type:'string'},min_conviction:{type:'number'}}, ['agent']), {example:{conviction:0.0}}),
      'POST /smart-money':        R(`$${SMARTMONEY_X402_USD}`,  'StillOS — proprietary 13D activist x insider conviction composite, signed receipt', {agent:'stillos',ticker:'AAPL'}, S({agent:{type:'string'},ticker:{type:'string'},apex_only:{type:'boolean'}}, ['agent']), {example:{composite:[]}}),
      'POST /distress-score':     R(`$${DISTRESS_X402_USD}`,    'StillOS — validated distress-foresight score (Altman Z from live SEC XBRL, 71% sensitivity / 100% specificity / ~109-day median lead backtested), signed receipt', {agent:'stillos',ticker:'AAPL'}, S({agent:{type:'string'},ticker:{type:'string'}}, ['agent','ticker']), {example:{z_score:0.0}}),
      'POST /agent-clearance':    R(`$${CLEARANCE_X402_USD}`,   'StillOS — pre-transaction clearance: OFAC SDN name screen + live on-chain wallet signals fused into CLEAR/REVIEW/BLOCK, signed receipt', {agent:'stillos',counterparty_wallet:'0x'}, S({agent:{type:'string'},counterparty_name:{type:'string'},counterparty_wallet:{type:'string'}}, ['agent']), {example:{verdict:'CLEAR'}}),
    };
    rs.initialize().catch(e => console.error('[notary-marcus] x402 v2 init failed (payment gate stays up, routes 503 until fixed):', e.message));
    app402.use(pmw2(routesV2, rs));
  } else {
    const { paymentMiddleware: pmw } = require('/home/marcus/still-os-consciousness/node_modules/x402-express');
    let facCfg;
    // StillOS self-hosted facilitator (core/x402_facilitator.cjs) settles Base mainnet
    // x402 without any CDP dependency. Preferred when USE_SELFHOSTED_FACILITATOR=true and
    // the local facilitator is deployed. Our CDP key is dead (401) so this is the live path
    // forward; CDP remains as an explicit opt-out fallback. See VSC / bazaar-settle diagnosis.
    if (process.env.USE_SELFHOSTED_FACILITATOR === 'true') {
      facCfg = { url: process.env.SELFHOSTED_FACILITATOR_URL || 'http://127.0.0.1:8467' };
    } else if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
      try { facCfg = require('/home/marcus/still-os-consciousness/node_modules/@coinbase/x402').facilitator; } catch { /* falls back to default facilitator */ }
    }
    app402.use(pmw(PAYTO_X402, {
      'POST /commit': { price: '$0.10', network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/commit', description: 'StillOS Notary — commit a claim hash (tamper-evident, Ed25519-signed receipt)', inputSchema: { body: { agent: 'string — caller agent id', claim: 'string — the claim text to notarize' } }, outputSchema: { ...OUT_SIGNED, tier: 'string' } } },
      'POST /claim-verdict': { price: `$${VERDICT_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/claim-verdict', description: 'StillOS Notary — signed claim verdict, resolved against external ground truth, Ed25519-signed, hash-chained', inputSchema: { body: { agent: 'string — caller agent id', claim: 'string — claim to adjudicate', resolver: 'string — named external resolver' } }, outputSchema: { verdict: 'TRUE | FALSE | UNRESOLVED', claim_receipt: '{hash, verify}', ...OUT_SIGNED } } },
      'POST /dispute': { price: `$${DISPUTE_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/dispute', description: 'StillOS Notary — file a bonded dispute against a verdict receipt, resolved by independent re-run', inputSchema: { body: { agent: 'string — caller agent id', receipt_hash: 'string — verdict receipt hash being disputed' } }, outputSchema: { resolution: 'string — re-run outcome', ...OUT_SIGNED } } },
      'POST /grade-strategy': { price: `$${GRADE_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/grade-strategy', description: 'StillOS Edge-Gate — grade a settled strategy track record: fail-closed REAL_EDGE|REGIME_LUCK|NEGATIVE_EV|INSUFFICIENT_DATA verdict, out-of-sample + fee/slippage adjusted, Ed25519-signed receipt', inputSchema: { body: { agent: 'string — caller agent id', trades: 'array — [{t, price, side, outcome}]' } }, outputSchema: { grade: 'REAL_EDGE | REGIME_LUCK | NEGATIVE_EV | INSUFFICIENT_DATA', ...OUT_SIGNED } } },
      'POST /screen-entity': { price: `$${SCREEN_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/screen-entity', description: 'StillOS — OFAC SDN sanctions name screen, signed receipt, source_as_of freshness timestamp included', inputSchema: { body: { entity: 'string — legal name to screen against OFAC SDN' } }, outputSchema: { match: 'boolean', hits: 'array', source_as_of: 'ISO8601', ...OUT_SIGNED } } },
      'POST /regulatory-rules': { price: `$${REGISTER_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/regulatory-rules', description: 'StillOS — Federal Register recent-rules search (agency/keyword), signed receipt', inputSchema: { body: { agency: 'string — agency name (optional)', keyword: 'string — search term' } }, outputSchema: { rules: 'array — recent matching rules', ...OUT_SIGNED } } },
      'POST /federal-awards': { price: `$${AWARDS_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/federal-awards', description: 'StillOS — USAspending.gov top-100-by-amount award snapshot search (recipient/min_amount), signed receipt', inputSchema: { body: { recipient: 'string — recipient name', min_amount: 'number — minimum award $ (optional)' } }, outputSchema: { awards: 'array — top matches by amount', ...OUT_SIGNED } } },
      'POST /insider-conviction': { price: `$${INSIDER_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/insider-conviction', description: 'StillOS — proprietary insider cluster-buy conviction scoring (EDGAR Form 4), distress cross-referenced, signed receipt', inputSchema: { body: { ticker: 'string — equity ticker', min_conviction: 'number — filter threshold (optional)' } }, outputSchema: { conviction: 'number — 0..100 score', clusters: 'array', ...OUT_SIGNED } } },
      'POST /smart-money': { price: `$${SMARTMONEY_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/smart-money', description: 'StillOS — proprietary 13D activist x insider conviction composite, signed receipt', inputSchema: { body: { ticker: 'string — equity ticker', apex_only: 'boolean — only apex signals (optional)' } }, outputSchema: { composite: 'number — 0..100 score', signals: 'array', ...OUT_SIGNED } } },
      'POST /distress-score': { price: `$${DISTRESS_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/distress-score', description: 'StillOS — validated distress-foresight score for a single ticker (Altman Z-score from live SEC XBRL, 71% sensitivity / 100% specificity / ~109-day median lead backtested), signed receipt', inputSchema: { body: { ticker: 'string — equity ticker' } }, outputSchema: { z_score: 'number — Altman Z', flag: 'string — distress band', ...OUT_SIGNED } } },
      'POST /agent-clearance': { price: `$${CLEARANCE_X402_USD}`, network: NET_X402, config: { discoverable: true, resource: 'https://nolawealthfinancial.com/notary/agent-clearance', description: 'StillOS — pre-transaction clearance: OFAC SDN name screen + live on-chain wallet signals (contract status, balance, transaction count), fused into a CLEAR/REVIEW/BLOCK verdict, signed receipt', inputSchema: { body: { counterparty_name: 'string — legal name', counterparty_wallet: 'string — 0x address' } }, outputSchema: { verdict: 'CLEAR | REVIEW | BLOCK', ofac: 'object', wallet_signals: 'object', ...OUT_SIGNED } } },
    }, facCfg, { appName: 'Still OS · Notary' }));
  }
  app402.post('/commit', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.agent || !b.claim) return res.status(400).json({ error: 'agent and claim required' });
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent: b.agent, claim: b.claim, privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: b.agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      // Standing correctness bond that backs this receipt (never let a bond
      // hiccup break receipt issuance).
      try { receipt.bond_ref = require('/home/marcus/core/notary_bond.cjs').bondRef(); } catch { /* bond optional to the receipt path */ }
      res.status(200).json(receipt);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/claim-verdict', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.agent || !b.claim || !b.resolver) return res.status(400).json({ error: 'agent, claim, resolver required' });
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const result = await signer.processClaimVerdict(b.agent, b.claim, b.resolver, b.partner_receipt_hash, { source_ip, user_agent: req.headers['user-agent'] || null });
      res.status(200).json({
        claim_receipt: { hash: result.claimReceipt.receipt_hash, verify: result.claimReceipt.verify },
        verdict: result.verdictObj,
        verdict_receipt: { hash: result.verdictReceipt.receipt_hash, verify: result.verdictReceipt.verify, signature: result.verdictReceipt.signature },
        tier: 'x402',
        bond_ref: (() => { try { return require('/home/marcus/core/notary_bond.cjs').bondRef(); } catch { return null; } })(),
      });
      // Partner revenue-share accrual — this is the x402-PAID path, so payment has settled.
      // A call carrying a registered partner's receipt hash accrues their share (fail-safe: never breaks the response).
      try { require('/home/marcus/core/partner_revshare.cjs').recordCall({ partner_receipt_hash: b.partner_receipt_hash, agent: b.agent, fee_usd: VERDICT_X402_USD, endpoint: 'claim-verdict' }); }
      catch (e) { console.error('[revshare] accrual failed:', e.message); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app402.post('/grade-strategy', (req, res) => {
    try {
      if (!edgeGate) return res.status(503).json({ error: 'edge gate unavailable' });
      const b = req.body || {};
      const agent = b.agent || 'anon';
      if (!Array.isArray(b.trades)) return res.status(400).json({ error: 'trades[] required: [{t,price,side,outcome}]' });
      const v = edgeGate.gradeStrategy(b.trades, b.opts || {});
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent, claim: JSON.stringify(v), privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      res.status(200).json({ ...v, agent, tier: 'x402', receipt_hash: receipt.receipt_hash, signature: receipt.signature, verify: receipt.verify, attestation_type: receipt.attestation_type, authoritative: receipt.authoritative, proves: receipt.proves });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/screen-entity', (req, res) => {
    try {
      if (!ofacScreen) return res.status(503).json({ error: 'screen module unavailable' });
      const b = req.body || {};
      const agent = b.agent || 'anon';
      if (!b.entity) return res.status(400).json({ error: 'entity required' });
      const result = ofacScreen.screen(b.entity);
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent, claim: JSON.stringify(result), privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      res.status(200).json({ ...result, agent, tier: 'x402', receipt_hash: receipt.receipt_hash, signature: receipt.signature, verify: receipt.verify, attestation_type: receipt.attestation_type, authoritative: receipt.authoritative, proves: receipt.proves });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/regulatory-rules', (req, res) => {
    try {
      if (!fedRegister) return res.status(503).json({ error: 'lookup module unavailable' });
      const b = req.body || {};
      const agent = b.agent || 'anon';
      const result = fedRegister.search({ agency: b.agency, keyword: b.keyword, limit: b.limit });
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent, claim: JSON.stringify(result), privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      res.status(200).json({ ...result, agent, tier: 'x402', receipt_hash: receipt.receipt_hash, signature: receipt.signature, verify: receipt.verify, attestation_type: receipt.attestation_type, authoritative: receipt.authoritative, proves: receipt.proves });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/federal-awards', (req, res) => {
    try {
      if (!usaSpending) return res.status(503).json({ error: 'lookup module unavailable' });
      const b = req.body || {};
      const agent = b.agent || 'anon';
      const result = usaSpending.search({ recipient: b.recipient, min_amount: b.min_amount, limit: b.limit });
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent, claim: JSON.stringify(result), privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      res.status(200).json({ ...result, agent, tier: 'x402', receipt_hash: receipt.receipt_hash, signature: receipt.signature, verify: receipt.verify, attestation_type: receipt.attestation_type, authoritative: receipt.authoritative, proves: receipt.proves });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/insider-conviction', (req, res) => {
    try {
      if (!insiderConviction) return res.status(503).json({ error: 'lookup module unavailable' });
      const b = req.body || {};
      const agent = b.agent || 'anon';
      const result = insiderConviction.top({ ticker: b.ticker, min_conviction: b.min_conviction, limit: b.limit });
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent, claim: JSON.stringify(result), privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      res.status(200).json({ ...result, agent, tier: 'x402', receipt_hash: receipt.receipt_hash, signature: receipt.signature, verify: receipt.verify, attestation_type: receipt.attestation_type, authoritative: receipt.authoritative, proves: receipt.proves });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/smart-money', (req, res) => {
    try {
      if (!smartMoney) return res.status(503).json({ error: 'lookup module unavailable' });
      const b = req.body || {};
      const agent = b.agent || 'anon';
      const result = smartMoney.top({ ticker: b.ticker, apex_only: b.apex_only, limit: b.limit });
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent, claim: JSON.stringify(result), privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      res.status(200).json({ ...result, agent, tier: 'x402', receipt_hash: receipt.receipt_hash, signature: receipt.signature, verify: receipt.verify, attestation_type: receipt.attestation_type, authoritative: receipt.authoritative, proves: receipt.proves });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/distress-score', async (req, res) => {
    try {
      if (!distressScore) return res.status(503).json({ error: 'lookup module unavailable' });
      const b = req.body || {};
      const agent = b.agent || 'anon';
      if (!b.ticker) return res.status(400).json({ error: 'ticker required' });
      const result = await distressScore.score(b.ticker);
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent, claim: JSON.stringify(result), privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      res.status(200).json({ ...result, agent, tier: 'x402', receipt_hash: receipt.receipt_hash, signature: receipt.signature, verify: receipt.verify, attestation_type: receipt.attestation_type, authoritative: receipt.authoritative, proves: receipt.proves });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/agent-clearance', async (req, res) => {
    try {
      if (!agentClearance) return res.status(503).json({ error: 'clearance module unavailable' });
      const b = req.body || {};
      const agent = b.agent || 'anon';
      const result = await agentClearance.clear({ counterparty_name: b.counterparty_name, counterparty_wallet: b.counterparty_wallet, intent_hash: b.intent_hash, max_age_seconds: b.max_age_seconds });
      const { privateKey, notary_fp } = signer.loadPrivateKey();
      const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const receipt = signer.commit({ agent, claim: JSON.stringify(result), privateKey, notary_fp, actor_evidence: actorClassifier.classify({ agent_id: agent, source_ip, user_agent: req.headers['user-agent'] || null }) });
      receipt.tier = 'x402';
      res.status(200).json({ ...result, agent, tier: 'x402', receipt_hash: receipt.receipt_hash, signature: receipt.signature, verify: receipt.verify, attestation_type: receipt.attestation_type, authoritative: receipt.authoritative, proves: receipt.proves });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app402.post('/dispute', async (req, res) => {
    try {
      const b = req.body || {};
      const dispute = require('./verdict_dispute.cjs');
      const result = await dispute.fileDispute({
        verdict_receipt_hash: b.verdict_receipt_hash, verdict_object: b.verdict_object,
        original_resolver_spec: b.original_resolver_spec, agent: b.agent, reason: b.reason,
      });
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.status(200).json({
        upheld: result.upheld,
        dispute_receipt: { hash: result.receipt.receipt_hash, verify: result.receipt.verify, signature: result.receipt.signature },
        summary: result.upheld ? 'Original verdict OVERTURNED — fresh re-resolution disagreed with the original outcome.' : 'Dispute REJECTED — fresh re-resolution agrees with the original outcome, which stands.',
        tier: 'x402',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  console.log(`[notary-marcus] x402 payment gate live (${NET_X402}) — /commit $0.10, /claim-verdict $${VERDICT_X402_USD}, /dispute $${DISPUTE_X402_USD}`);
} catch (e) {
  console.error(`[notary-marcus] x402 gate FAILED to load (${e.message}) -- /commit and /claim-verdict will refuse rather than serve unmetered`);
}

function loadUsage() { try { return JSON.parse(fs.readFileSync(USAGE, 'utf8')); } catch { return {}; } }
function saveUsage(u) { fs.writeFileSync(USAGE, JSON.stringify(u)); }
function meterToday(bucket, req) {
  const u = loadUsage();
  // toISOString() always returns UTC regardless of system timezone -- fixed
  // 2026-07-04, same bug class as the moltbook report date bug. The free-tier
  // day now resets at Phoenix midnight, not 5pm Phoenix (UTC midnight).
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
  // SYBIL LEAK FIX (2026-07-12): the free-tier count used to key on the
  // caller-supplied `agent`/bucket string ALONE, so any caller rotated its agent
  // id for a fresh quota -- the free tier was effectively unlimited and nobody
  // ever had to pay (found by live test: agent="A" and agent="B" both served
  // free). Now the per-day count is keyed on source IP (which a caller cannot
  // rotate for free -- a costly signal), while the bucket's endpoint prefix is
  // preserved so each endpoint keeps its own quota. Falls back to the raw bucket
  // only for internal/localhost calls that carry no forwarded IP (those are ours).
  const ip = (req && (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || null;
  const endpoint = String(bucket).split(':')[0];
  const idPart = ip ? `ip:${ip}` : String(bucket);
  const k = `${endpoint}|${idPart}|${day}`;
  u[k] = (u[k] || 0) + 1;
  saveUsage(u);
  return u[k];
}

// Evaluator ($29/mo) fulfillment. The webhook receiver (stillos-public/server.js
// /stripe/webhook, on a separate process/port) writes here on a completed
// checkout for this product; this side just reads it. Deliberately reads fresh
// from disk on every check rather than caching -- a subscriber file this small
// is cheap to read and a cache would risk serving a stale grant after a
// cancellation (which the current webhook doesn't yet handle -- see gap below).
const EVAL_SUBSCRIBERS_FILE = '/home/marcus/state/proof-notary/evaluator-subscribers.json';
// "several hundred calls/mo" (the marketing copy) ~ 20/day. Meaningfully above
// the 15/day free tier so paying is a real upgrade, not a rounding error.
const EVALUATOR_DAILY_BONUS = 20;
// KNOWN GAP, not silently hidden: the live Stripe webhook is only subscribed to
// checkout.session.completed and invoice.paid (confirmed via commercial_readiness_gate.cjs
// 2026-07-06) -- not customer.subscription.deleted. A cancelled subscriber keeps
// this bonus until their invoice.paid events simply stop arriving; there is no
// active revocation on cancellation yet. Flagged for a follow-up, not solved here.
function evaluatorBonus(agent) {
  try {
    const subs = JSON.parse(fs.readFileSync(EVAL_SUBSCRIBERS_FILE, 'utf8'));
    const rec = subs[agent];
    return (rec && rec.status === 'active') ? EVALUATOR_DAILY_BONUS : 0;
  } catch { return 0; }
}

// ── Self-check / self-healing, same pattern as proof_endpoint.cjs ───────────
function health() {
  let splitReadable = false, publicKeyPem = null;
  try { const rec = JSON.parse(fs.readFileSync(SPLITFILE, 'utf8')); splitReadable = !!(rec.shareA && rec.publicKey); publicKeyPem = rec.publicKey; } catch {}
  let signingWorks = false;
  try { signer.loadPrivateKey(); signingWorks = true; } catch {}
  return { split_file_readable: splitReadable, signing_works: signingWorks, healthy: splitReadable && signingWorks, publicKeyPem };
}

let _lastHealthy = null;
function watchAndSelfCheck() {
  function tick() {
    const h = health();
    if (_lastHealthy === false && h.healthy) console.log('[notary-marcus] SELF-HEALED -- signing works again, no action taken by anyone');
    if (_lastHealthy === true && !h.healthy) console.error('[notary-marcus] UNHEALTHY -- entering fast retry, self-heals automatically when the underlying file is fixed');
    _lastHealthy = h.healthy;
    setTimeout(tick, h.healthy ? 60000 : 5000).unref();
  }
  try { fs.watch(SPLITFILE, { persistent: false }, () => tick()); } catch { /* poll loop below still covers it */ }
  tick();
}
watchAndSelfCheck();

function verifyReceipt(hash) {
  const receipts = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const rec = receipts.find(r => r.receipt_hash === hash);
  if (!rec) return { found: false };
  const { signature, verify: _v, ...core } = rec;
  const recompute = crypto.createHash('sha256').update(JSON.stringify({ agent: core.agent, claim_sha256: core.claim_sha256, ts: core.ts, prev_hash: core.prev_hash, notary_fp: core.notary_fp, ...(core.resolver_hash ? { resolver_hash: core.resolver_hash } : {}) })).digest('hex');
  const hashOk = recompute === core.receipt_hash;
  let sigOk = false;
  try {
    const { publicKeyPem } = signer.loadPrivateKey();
    sigOk = crypto.verify(null, Buffer.from(core.receipt_hash), crypto.createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
  } catch {}
  return { found: true, hash_intact: hashOk, signature_valid: sigOk, receipt: rec };
}

// Ported from proof_endpoint.cjs (2026-07-04) -- publicly described as live
// ("Verifiable offline... /notary/export returns the full ledger, the Ed25519
// public key, and an explicit verification procedure") before it actually
// existed on THIS service. Same gap class as the reputation-tier fix above.
function exportLedger() {
  const receiptFields = ['agent', 'claim_sha256', 'ts', 'prev_hash', 'notary_fp', 'resolver_hash', 'receipt_hash', 'signature'];
  const receipts = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .map(r => { const out = {}; for (const f of receiptFields) if (r[f] !== undefined) out[f] = r[f]; return out; });
  const { publicKeyPem } = signer.loadPrivateKey();
  return {
    notary_fingerprint: crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16),
    public_key: publicKeyPem,
    how_to_verify: 'Recompute each receipt_hash = SHA256(JSON.stringify({agent,claim_sha256,ts,prev_hash,notary_fp,resolver_hash?})) in that key order, check it matches, check prev_hash chains to the prior receipt_hash in order, and verify the signature against public_key.',
    exported_at: new Date().toISOString(),
    receipts,
  };
}

// Same summary shape as the original service's /notary/stats -- this URL is
// already public and referenced in past posts as "verify the number yourself."
//
// Found 2026-07-05 auditing this against the raw ledger: actor_class is stamped
// ONCE at receipt-creation time and frozen forever -- when notary_actor_classifier's
// INTERNAL_EXACT/INTERNAL_PREFIXES allowlist gets fixed (e.g. 'verify-hardening-',
// 'onchain-exploit-test', 'external-ip-simulation' were all added after being
// confirmed as our own security-hardening test traffic), none of the already-
// written receipts retroactively benefit. All 4 "unknown_visitor_distinct_ip_
// clusters" this stat has reported were, at time of audit, 100% these exact
// already-allowlisted internal test names -- stats() was reporting them as
// external because it trusted the stale frozen field instead of re-checking.
// Fix: re-run the CURRENT name-based rule (isInternal) live against every
// receipt's agent_id before falling back to the historical actor_class. This
// self-heals as the allowlist improves, instead of needing a one-time backfill
// migration every time a new internal-test-name pattern gets added.
function stats() {
  const actorClassifier = require('/home/marcus/still-os-consciousness/core/notary_actor_classifier.cjs');
  const receipts = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const items = receipts.map(x => {
    const stored = x.actor_class || 'UNKNOWN_VISITOR';
    const actor_class = (stored !== 'INTERNAL_SYSTEM' && actorClassifier.isInternal(x.agent)) ? 'INTERNAL_SYSTEM' : stored;
    return { agent_id: x.agent, actor_class, ts: x.ts, source_ip_hash: x.source_ip_hash || null };
  });
  const summary = actorClassifier.summarize(items);
  return { ...summary, receipts_issued: summary.receipts_total, first: receipts[0]?.ts || null, last: receipts[receipts.length - 1]?.ts || null };
}

// ── Paywall lead capture (Wire #2, 2026-07-12) ───────────────────────────────
// A free-tier throttle (429) is our hottest demand signal — a caller that used the
// free tier and hit the wall. We used to meter it and forget it, so we were blind
// to whether repeat 429s were real buyers or scrapers. Now every throttle is logged
// as a lead and any source IP throttled ≥3× on one product fires a one-per-day
// founder alert. Keyed on source IP (the sybil-resistant identity — agent id is
// caller-spoofable, per the meterToday sybil-leak fix). Every path is fail-safe:
// a lead-capture or comms error must never break the actual response.
const LEADS_LOG = path.join(DIR, 'paywall-leads.jsonl');
const _throttleCounts = new Map(); // `${day}|${ip}|${product}` -> count (in-memory; comms dedupe covers restarts)
function productFrom(obj) {
  try { return new URL(obj.accepts[0].resource).pathname; } catch { return (obj && obj.accepts && obj.accepts[0] && obj.accepts[0].resource) || 'unknown'; }
}
function fireThrottleAlert(ip, product, n, ua) {
  try {
    const comms = require('/home/marcus/still-os-consciousness/core/comms.cjs');
    Promise.resolve(comms.emit({
      source: 'notary_paywall', severity: 'INFO',
      summary: `Repeat paywall throttle: ${ip} hit ${product} free limit ${n}× today`,
      action: `Real convertible-demand candidate. Review state/proof-notary/paywall-leads.jsonl → tune free limit or reach out. UA: ${ua || 'n/a'}`,
      data: { ip, product, throttles_today: n, ua }, dedupe_ttl_min: 1440,
    })).catch(() => {});
  } catch { /* comms optional — never break the response */ }
}
function recordThrottleLead(req, obj) {
  try {
    const h = (req && req.headers) || {};
    const ip = (h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim()) || null;
    const ua = String(h['user-agent'] || '').slice(0, 160);
    const product = productFrom(obj);
    const price = (obj.accepts && obj.accepts[0] && obj.accepts[0].maxAmountRequired) ? Number(obj.accepts[0].maxAmountRequired) / 1e6 : null;
    fs.appendFileSync(LEADS_LOG, JSON.stringify({ ts: new Date().toISOString(), kind: 'throttle_402', ip, ua, product, used: obj.used ?? null, free_limit_per_day: obj.free_limit_per_day ?? null, price_usd: price }) + '\n');
    if (!ip) return; // internal/localhost (no forwarded IP) — logged, not alerted (that's us)
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
    const key = `${day}|${ip}|${product}`;
    const n = (_throttleCounts.get(key) || 0) + 1;
    _throttleCounts.set(key, n);
    if (n === 3) fireThrottleAlert(ip, product, n, ua); // fire once, on crossing the 3rd throttle
  } catch { /* lead-capture failure must never break a response */ }
}

function send(res, code, obj) {
  // Hook the single chokepoint: every product route's free-tier throttle (402,
  // formerly 429 — switched 2026-07-13 to speak real x402) flows through here.
  // The /commit 402 does NOT (it's the x402-express middleware), so this
  // captures real free-tier throttles only — zero crawler-probe noise.
  if (code === 402 && obj && obj.free_limit_per_day != null) recordThrottleLead(res.req, obj);
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

// ── GET-on-monetized-POST discovery, ported from proof_endpoint.cjs 2026-07-07 ──
// Same finding as the sandboxed service: agents/crawlers probe with GET before
// committing to a paid POST. A bare 404 loses that lead; a 405 with schema
// converts it into a discovery asset. Reuses the price/free-limit constants
// already defined above rather than restating numbers.
const MONETIZED_ENDPOINT_SCHEMA = {
  '/commit': { purpose: 'Commit a claim hash -- tamper-evident, Ed25519-signed receipt, no resolver attached.', price: () => '$0.10 USDC (Base) via x402, no free tier.', required_schema: { agent: 'string', claim: 'string' } },
  '/dispute': { purpose: 'File a bonded dispute against a verdict receipt, resolved by independent re-run.', price: () => `$${DISPUTE_X402_USD} USDC (Base) via x402, non-refundable either way.`, required_schema: { agent: 'string', receipt_hash: 'string' } },
  '/grade-strategy': { purpose: 'Grade a settled trading track record: fail-closed REAL_EDGE|REGIME_LUCK|NEGATIVE_EV|INSUFFICIENT_DATA verdict, Ed25519-signed.', price: () => `Free up to ${GRADE_FREE_LIMIT}/agent/day, then $${GRADE_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', trades: '[{t, price, side, outcome}]' } },
  '/screen-entity': { purpose: 'OFAC SDN sanctions name screen, signed receipt with source-freshness timestamp.', price: () => `Free up to ${SCREEN_FREE_LIMIT}/agent/day, then $${SCREEN_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', entity: 'string' } },
  '/regulatory-rules': { purpose: 'Search recent Federal Register RULE documents by agency and/or keyword, signed receipt.', price: () => `Free up to ${REGISTER_FREE_LIMIT}/agent/day, then $${REGISTER_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', agency: 'string (optional)', keyword: 'string (optional)' } },
  '/federal-awards': { purpose: 'Search top-100-by-amount federal contract award snapshot (trailing 30 days), signed receipt.', price: () => `Free up to ${AWARDS_FREE_LIMIT}/agent/day, then $${AWARDS_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', recipient: 'string (optional)', min_amount: 'number (optional)' } },
  '/insider-conviction': { purpose: 'Proprietary conviction score over EDGAR Form 4 insider cluster buys, signed receipt.', price: () => `Free up to ${INSIDER_FREE_LIMIT}/agent/day, then $${INSIDER_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', ticker: 'string (optional)', min_conviction: 'number (optional)' } },
  '/smart-money': { purpose: 'Proprietary 13D activist x insider conviction composite, signed receipt.', price: () => `Free up to ${SMARTMONEY_FREE_LIMIT}/agent/day, then $${SMARTMONEY_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', ticker: 'string (optional)', apex_only: 'boolean (optional)' } },
  '/distress-score': { purpose: 'Validated distress-foresight score for a single ticker (71% sens / 100% spec / ~109d lead), live SEC fetch.', price: () => `Free up to ${DISTRESS_FREE_LIMIT}/agent/day, then $${DISTRESS_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', ticker: 'string' } },
  '/claim-verdict': { purpose: 'Commit a claim, resolve it against a named external resolver, receive a signed verdict.', price: () => `Free up to ${VERDICT_FREE_LIMIT}/agent/day (+ reputation bonus), then $${VERDICT_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', claim: 'string', resolver: '{ type, ...resolver-specific fields }' } },
  '/agent-clearance': { purpose: 'Pre-transaction OFAC + on-chain wallet clearance for agent-to-agent payments, fused into CLEAR/REVIEW/BLOCK.', price: () => `Free up to ${CLEARANCE_FREE_LIMIT}/agent/day, then $${CLEARANCE_X402_USD} USDC (Base) via x402.`, required_schema: { agent: 'string', counterparty_name: 'string (optional)', counterparty_wallet: 'string EVM address (optional)' } },
  '/register-policy': { purpose: 'Register a pre-action spend policy for an agent -- free, not a paid product.', price: () => 'Free, no x402.', required_schema: { agent: 'string', max_per_action: 'number (optional)', max_per_day: 'number (optional)', currency: 'string (optional)' } },
  '/authorize': { purpose: 'Check a proposed spend against an agent\'s registered policy -- free, not a paid product.', price: () => 'Free, no x402.', required_schema: { agent: 'string', amount: 'number', currency: 'string (optional)' } },
};
function discoveryResponse(endpoint) {
  const spec = MONETIZED_ENDPOINT_SCHEMA[endpoint];
  return { error: 'method_not_allowed', required_method: 'POST', endpoint, purpose: spec.purpose, price: spec.price(), required_schema: spec.required_schema, docs: '/notary/docs', next_action: 'Resend this request as POST with the schema above, or see GET /docs for the full quickstart. Questions: stillmarcus24@gmail.com' };
}

// ── Discovery-hit lead capture -- found 2026-07-13: this GET/405 path served
// real crawlers (x402station, TLM-Audit-Scanner, kkj-x402-trust-index) correctly
// but this live process never recorded a single one -- the equivalent logger
// existed only on the decommissioned proof_endpoint.cjs (dead since Caddy moved
// traffic to this file), so every real discovery lead here was invisible.
const DISCOVERY_LOG = path.join(DIR, 'surface-discovery.jsonl');
function classifyDiscoverySource(ua) {
  const a = String(ua || '');
  if (!a) return 'unknown';
  if (/malware|nikto|sqlmap|masscan|nmap|zgrab|censys|shodan/i.test(a)) return 'scanner';
  if (/googlebot|bingbot|yandexbot|duckduckbot|baiduspider|semrushbot|ahrefsbot|mj12bot|applebot|gptbot|claudebot|anthropic-ai|perplexitybot|ccbot|meta-externalagent|amazonbot|bytespider/i.test(a)) return 'crawler';
  if (/agent|scout|explorer|enrichment|prober|indexer|station|bazaar|x402/i.test(a)) return 'agent_indexer';
  if (/mozilla\/5\.0.*(applewebkit|gecko\/\d)/i.test(a)) return 'browser';
  if (/curl|wget|python|axios|go-http-client|guzzlehttp|okhttp|^node$/i.test(a)) return 'agent_indexer';
  return 'unknown';
}
function logSurfaceDiscovery(req, endpoint) {
  try {
    const rec = {
      ts: new Date().toISOString(),
      type: 'surface_discovery_hit',
      source_ip: req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || null,
      user_agent: req.headers['user-agent'] || '',
      path: endpoint,
      class: classifyDiscoverySource(req.headers['user-agent']),
    };
    fs.appendFileSync(DISCOVERY_LOG, JSON.stringify(rec) + '\n');
  } catch (e) {
    try { fs.appendFileSync(path.join(DIR, 'crash.log'), `[${new Date().toISOString()}] logSurfaceDiscovery FAILED: ${e && e.stack || e}\n`); } catch {}
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && MONETIZED_ENDPOINT_SCHEMA[u.pathname]) { logSurfaceDiscovery(req, u.pathname); return send(res, 405, discoveryResponse(u.pathname)); }

  // POST /admin/restart -- ported from proof_endpoint.cjs 2026-07-07. Less critical
  // here than on 8455 (this process is cron-watchdog-restarted within ~60s on any
  // crash, not root-locked), but kept for parity: a deliberate on-purpose reload
  // without waiting for the watchdog's next poll.
  if (req.method === 'POST' && u.pathname === '/admin/restart') {
    const supplied = (u.searchParams.get('k')) || req.headers['x-admin-key'] || '';
    const fresh = readAdminKeyFromDisk();
    if (!fresh) return send(res, 404, { error: 'not found' });
    const A = Buffer.from(String(supplied)), B = Buffer.from(fresh);
    const ok = A.length === B.length && crypto.timingSafeEqual(A, B);
    if (!ok) return send(res, 404, { error: 'not found' });
    console.log('[notary-marcus] /admin/restart: deliberate restart requested -- exiting for cron watchdog to reload from disk');
    res.on('finish', () => setTimeout(() => process.exit(1), 50));
    return send(res, 200, { ok: true, note: 'Restarting now -- cron watchdog reloads this process from disk within ~60s.' });
  }

  // Bare /notary or /notary/ used to fall through to the generic 404 route-dump below --
  // the literal product-name link on the homepage nav pointed here. A curious human
  // clicking the product's own name got a raw JSON error instead of an explanation.
  // Redirect to /docs (a real quickstart, not a route list) instead. Found 2026-07-06.
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '')) {
    res.writeHead(302, { Location: '/notary/docs' });
    return res.end();
  }

  // KYA landing page — served at nolawealthfinancial.com/notary/kya (Caddy routes /notary/* here).
  if (req.method === 'GET' && (u.pathname === '/kya' || u.pathname === '/kya/')) {
    try {
      const page = require('fs').readFileSync('/home/marcus/still-os-consciousness/sites/kya/index.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(page);
    } catch (e) { return send(res, 500, { error: 'landing unavailable' }); }
  }
  if (req.method === 'GET' && u.pathname === '/health') return send(res, 200, { status: 'ok', ts: new Date().toISOString(), notary: health() });
  // Correctness bond — real USDC skin-in-the-game, on-chain-verifiable. Lets any
  // agent check "is StillOS bonded, and has it been slashed?" before transacting.
  if (req.method === 'GET' && u.pathname === '/bond') {
    require('/home/marcus/core/notary_bond.cjs').getSignedStatus()
      .then(s => send(res, 200, s))
      .catch(e => send(res, 500, { error: 'bond_status_failed', detail: String(e && e.message || e) }));
    return;
  }
  if (req.method === 'GET' && u.pathname === '/stats') return send(res, 200, stats());
  if (req.method === 'GET' && u.pathname === '/export') {
    if (u.searchParams.get('preview') === 'true') {
      const full = exportLedger();
      return send(res, 200, { ...full, receipts: full.receipts.slice(-EXPORT_PREVIEW_LIMIT), preview: true, note: `Preview: last ${EXPORT_PREVIEW_LIMIT} of ${full.receipts.length} receipts. Full export: GET /export (x402, $${EXPORT_X402_USD}).` });
    }
    // No free full-export tier at all -- ?preview=true above is the free path.
    return send(res, 402, {
      x402Version: 1,
      error: `full corpus export is a paid data license — use ?preview=true for a free ${EXPORT_PREVIEW_LIMIT}-record sample, or retry with an x402 X-PAYMENT header for the full export`,
      accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(EXPORT_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/export`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
    });
  }

  // Free discovery-tier endpoints, added 2026-07-15: separates "what can I buy"
  // (free — charging for the menu is self-defeating) from the paid resources
  // themselves. Derived from the same MONETIZED_ENDPOINT_SCHEMA table that
  // already drives the 405 discoveryResponse() and /.well-known/x402 — one
  // source of truth, not a second hand-maintained copy that can drift.
  if (req.method === 'GET' && (u.pathname === '/catalog' || u.pathname === '/pricing')) {
    const items = Object.entries(MONETIZED_ENDPOINT_SCHEMA).map(([endpoint, spec]) => ({
      endpoint: '/notary' + endpoint,
      method: 'POST',
      purpose: spec.purpose,
      price: spec.price(),
      required_schema: spec.required_schema,
    }));
    return send(res, 200, {
      service: 'Still OS Notary',
      note: 'Discovery is always free. Payment is required only for the resource itself (see each entry\'s price).',
      full_x402_schema: 'https://nolawealthfinancial.com/.well-known/x402',
      openapi: 'https://nolawealthfinancial.com/openapi.json',
      endpoints: items,
    });
  }

  // Landing page for this service, rebuilt 2026-07-07 around one metric: time to
  // first verified receipt. Old version led with a 7-endpoint/3-tier menu (protocol
  // surface) instead of a task -- the funnel audit that day found 604 external
  // discovery hits collapsing to ~0 genuine free-tier attempts, before x402/wallet
  // friction ever entered the picture. Every field below exists only if it moves a
  // fresh visitor toward one outcome: hero -> one command -> real output -> "you
  // just did it" -> automate -> (only then) SDK and paid path. Full endpoint list,
  // pricing tiers, and machine-discovery manifests moved to GET /reference -- they
  // don't belong in front of someone who hasn't made their first call yet.
  if (req.method === 'GET' && u.pathname === '/docs') {
    return send(res, 200, {
      hero: 'Get a cryptographically signed, independently verifiable proof for any claim. Free. No signup. No wallet.',
      run_this: `curl -s -X POST https://nolawealthfinancial.com/notary/claim-verdict -H "Content-Type: application/json" -d '{"agent":"you","claim":"nolawealthfinancial.com resolves HTTP 200","resolver":{"type":"http_status","url":"https://nolawealthfinancial.com","expect_code":200}}'`,
      expect_this_back: {
        verdict: 'CONFIRMED',
        receipt_hash: '<64-char hash, unique to your call>',
        verify: 'https://nolawealthfinancial.com/notary/verify?hash=<receipt_hash>',
      },
      you_just_verified_your_first_claim: 'That response is a real, independently signed receipt — not a mockup. Paste the verify URL into a browser or curl it: it recomputes the hash and checks the Ed25519 signature itself, no account or trust in us required.',
      now_automate_this: `Same endpoint, your own code, any language — it's plain HTTP + JSON, no client library required. Swap "claim" and "resolver" for your own use case. Free tier: ${VERDICT_FREE_LIMIT}/agent/day base (repeat, diverse, well-calibrated agents earn more).`,
      sdk: 'For grading a trading-strategy track record specifically (real edge vs regime luck), we publish a CLI: `npx stillos-edge-gate grade trades.json` — wraps this same free-tier endpoint, same signed receipt. No SDK yet for other claim types; raw HTTP is the integration.',
      past_free_tier: `Same call, add an X-PAYMENT header (x402, USDC on ${NET_X402}) — $${VERDICT_X402_USD}/call, no signup, no account. The 429 you get at your limit includes the exact payment terms (payTo, asset, amount) needed to construct it. Full endpoint list, flat monthly tiers, and machine-discovery manifests: GET /reference.`,
    });
  }

  // Full protocol surface, split out of /docs 2026-07-07 so first-time visitors
  // see one task instead of a menu. Same content /docs used to inline.
  if (req.method === 'GET' && u.pathname === '/reference') {
    return send(res, 200, {
      // Added 2026-07-07: real callers who got past the /docs hello-world example
      // (http_status only) hit ERROR on their first attempt at a resolver type
      // specific to their own use case -- malformed url_json spec, ed25519_signature
      // input format guessed wrong. Every example below was run against this live
      // service before being published here; each returns verdict:CONFIRMED as shown.
      // Do not add an example without testing it first -- a broken "working example"
      // is worse than none.
      resolver_examples: {
        url_json: {
          resolver_spec: { type: 'url_json', url: 'https://nolawealthfinancial.com/notary/health', path: 'status', expect: 'ok' },
          note: 'path is dot-notation into the JSON response; expect is matched exactly against the value at that path. Point url_json at a field that is STABLE (a status string), not a counter that grows every call (e.g. not /stats\' receipts_total) -- an exact-match example against a growing number only works once.',
          tested_result: 'verdict:CONFIRMED, resolver_confidence:1 -- verified live 2026-07-07',
        },
        ed25519_signature: {
          resolver_spec: { type: 'ed25519_signature', message: '<your message string>', signature: '<base64 signature>', public_key: '<base64 or hex, 32 raw bytes -- or a full PEM block>', public_key_encoding: 'base64' },
          note: 'message_encoding defaults to utf8, signature_encoding defaults to base64, public_key_encoding defaults to pem -- if your public key is 32 raw bytes (not a PEM block), you MUST set public_key_encoding to "base64" or "hex" explicitly, or verification will fail on a correctly-signed message. This resolver proves the signature is valid against the given key ONLY -- it does not prove the key belongs to any identity; that is a separate claim this resolver does not make.',
          copy_paste_curl: `curl -s -X POST https://nolawealthfinancial.com/notary/claim-verdict -H "Content-Type: application/json" -d '{"agent":"you","claim":"my message signed correctly","resolver":{"type":"ed25519_signature","message":"hello notary","signature":"y6Hj9RMhwXjKo3b3YEYpKfQNjzgxnY1U/Pm+89+feDdLu+XqBJONCeXyYMD+kPR/I55FYcZ1dqcFqkffWAnZAw==","public_key":"CXQK3EMKTxtyTwFdqW0Y1+nhGANgG8cFd8j47p0gIEU=","public_key_encoding":"base64"}}'`,
          tested_result: 'verdict:CONFIRMED, resolver_confidence:1 -- verified live 2026-07-07 (this exact keypair+signature+curl command, run against this service, not a hypothetical)',
        },
      },
      other_endpoints: {
        commit: `POST /commit — x402-paid only ($0.10/call), raw signed receipt, no resolver attached. Production path once you're past evaluation.`,
        dispute: 'POST /dispute — x402-paid, file a bonded dispute against a verdict receipt, resolved by independent re-run.',
        grade_strategy: `POST /grade-strategy — free tier ${GRADE_FREE_LIMIT}/agent/day then x402-paid. Fail-closed REAL_EDGE|REGIME_LUCK|NEGATIVE_EV|INSUFFICIENT_DATA verdict on a settled trade track record.`,
        screen_entity: 'POST /screen-entity — x402-paid ($0.02/call), OFAC SDN sanctions name screen, signed receipt.',
        agent_clearance: `POST /agent-clearance — free tier ${CLEARANCE_FREE_LIMIT}/agent/day then x402-paid ($${CLEARANCE_X402_USD}/call). Pre-transaction clearance: OFAC SDN name screen + on-chain wallet signals (contract status, balance, tx count), fused into CLEAR/REVIEW/BLOCK. Scope is stated in every response -- no mixer or fund-flow forensics claimed.`,
        verify: 'GET /verify?hash=... — recompute and confirm any receipt this service has ever issued.',
        stats: 'GET /stats — live totals: receipts issued, by class, revenue attributed.',
      },
      machine_discovery: {
        x402_manifest: 'GET /.well-known/x402.json — full machine-readable price list, no docs page needed if your agent just reads this.',
        agent_card: 'GET /.well-known/agent-card.json — A2A-style skill manifest.',
      },
      flat_tiers_for_humans: {
        evaluator: '$29/mo — several hundred calls/mo, no SLA. Self-serve, no sales conversation required: https://buy.stripe.com/dRm00kfqWatA7hu0Br6kg1L',
        operator: '$499/mo — unlimited commits, priority resolver, SLA. Talk to us: https://nolawealthfinancial.com/#contact',
        enterprise: '$2,000/mo — dedicated notary instance, audit export. Talk to us: https://nolawealthfinancial.com/#contact',
      },
    });
  }

  // Human-facing verify pages -- /notary/check (general traders) and
  // /notary/verify-tout (sports-betting cappers/touts wedge), same engine
  // and free-tier metering underneath, different framing/copy for each
  // audience so links can be dropped into the right community directly.
  if (req.method === 'GET' && (u.pathname === '/check' || u.pathname === '/verify-tout')) {
    const file = u.pathname === '/verify-tout' ? 'verify_tout_page.html' : 'verify_page.html';
    try {
      const html = fs.readFileSync(`/home/marcus/core/${file}`, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) { return send(res, 500, { error: 'page unavailable' }); }
  }

  // ERC-8004 registration file -- reachable at nolawealthfinancial.com/notary/erc8004-registration.json
  // Distinct from the A2A agent-card below: this follows the ERC-8004
  // registration-v1 schema (type/name/description/image/services/active/
  // registrations), not the A2A schema (skills/capabilities). agentId in
  // `registrations` is filled in AFTER on-chain registration succeeds (the
  // registry assigns it; this file can't know it in advance) -- see
  // core/erc8004_register.cjs and state/erc8004/registration.json.
  if (req.method === 'GET' && u.pathname === '/erc8004-registration.json') {
    let onchain = null;
    try { onchain = JSON.parse(fs.readFileSync('/home/marcus/still-os-consciousness/state/erc8004/registration.json', 'utf8')); } catch { /* not registered yet */ }
    return send(res, 200, {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Still OS Notary',
      description: 'Signed, fail-closed verification, screening, and proprietary research primitives for autonomous agents. Grades trading track records (REAL_EDGE/REGIME_LUCK/NEGATIVE_EV), screens OFAC sanctions, searches Federal Register + USAspending data, scores insider conviction and 13D activist accumulation, and grades single-ticker distress foresight -- every response Ed25519-signed and independently verifiable.',
      image: 'https://nolawealthfinancial.com/favicon.ico',
      services: [
        { name: 'x402', endpoint: 'https://nolawealthfinancial.com/notary' },
        { name: 'A2A', endpoint: 'https://nolawealthfinancial.com/notary/.well-known/agent-card.json' },
      ],
      active: true,
      registrations: onchain ? [{ agentId: onchain.agentId, agentRegistry: `eip155:8453:${onchain.registryAddress}` }] : [],
      x402Support: true,
      supportedTrust: ['reputation'],
    });
  }

  // A2A Agent Card -- reachable at nolawealthfinancial.com/notary/.well-known/agent-card.json
  // (standard path is domain-root /.well-known/agent-card.json per RFC 8615;
  // shipping under /notary/ for the same Caddy-prefix-safety reason as the
  // x402 manifest above -- root-level Caddy edits are a separate decision).
  if (req.method === 'GET' && u.pathname === '/.well-known/agent-card.json') {
    const skill = (id, name, description, priceUsd) => ({ id, name, description, tags: ['x402', 'verification'], inputModes: ['application/json'], outputModes: ['application/json'], examples: [`POST /notary/${id} {"agent":"your-id", ...}`] });
    return send(res, 200, {
      protocolVersion: '0.2.1',
      name: 'Still OS Notary',
      description: 'Signed, fail-closed verification, screening, and proprietary research primitives for autonomous agents, operated by Still OS Digital Holdings. Every response is Ed25519-signed and independently verifiable. Evaluation access for human operators is available on a self-serve monthly basis at https://buy.stripe.com/dRm00kfqWatA7hu0Br6kg1L, requiring no commercial conversation.',
      url: 'https://nolawealthfinancial.com/notary',
      provider: { organization: 'Still OS Digital Holdings', url: 'https://nolawealthfinancial.com' },
      version: '1.0.1',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      securitySchemes: { x402: { type: 'http', scheme: 'x402', description: 'USDC on Base via x402 payment header; a complimentary tier of up to 15 calls/agent/day is available per endpoint before payment is required, see skill descriptions' } },
      skills: [
        skill('grade-strategy', 'Grade Strategy', 'Fail-closed REAL_EDGE/REGIME_LUCK/NEGATIVE_EV/INSUFFICIENT_DATA verdict on a settled trading track record.', GRADE_X402_USD),
        skill('screen-entity', 'Screen Entity', 'OFAC SDN sanctions name screen with source-freshness timestamp.', SCREEN_X402_USD),
        skill('claim-verdict', 'Claim Verdict', 'Signed verdict on a probabilistic claim, resolved against external ground truth.', VERDICT_X402_USD),
        skill('regulatory-rules', 'Regulatory Rules Search', 'Search recent Federal Register rule changes by agency/keyword.', REGISTER_X402_USD),
        skill('federal-awards', 'Federal Awards Search', 'Search the top-100-by-amount federal contract award snapshot.', AWARDS_X402_USD),
        skill('insider-conviction', 'Insider Conviction Score', 'Proprietary conviction scoring over public EDGAR Form 4 insider cluster buys.', INSIDER_X402_USD),
        skill('smart-money', 'Smart-Money Accumulation', 'Proprietary 13D activist x insider conviction composite.', SMARTMONEY_X402_USD),
        skill('distress-score', 'Distress Foresight Score', 'Validated distress-foresight score for a single ticker (71% sensitivity / 100% specificity / ~109-day median lead backtested).', DISTRESS_X402_USD),
        skill('agent-clearance', 'Agent Clearance', 'Pre-transaction OFAC + on-chain wallet clearance for agent-to-agent payments, fused into a CLEAR/REVIEW/BLOCK verdict.', CLEARANCE_X402_USD),
      ],
      discovery: { x402Manifest: 'https://nolawealthfinancial.com/notary/.well-known/x402.json' },
    });
  }

  // x402 discovery manifest -- reachable at nolawealthfinancial.com/notary/.well-known/x402.json
  // (Caddy strips the /notary prefix before proxying here, so this path matches
  // the emerging convention's file name even though it isn't domain-root).
  if (req.method === 'GET' && u.pathname === '/.well-known/x402.json') {
    return send(res, 200, {
      generated_at: new Date().toISOString(),
      service: { name: 'Still OS Notary', description: 'Signed, fail-closed verification and screening primitives for autonomous agents.', baseUrl: 'https://nolawealthfinancial.com/notary' },
      protocols: { primary: 'x402', network: NET_X402 },
      settlement: { asset: 'USDC', chain: 'Base', payTo: PAYTO_X402 },
      paid_services: [
        { id: 'grade-strategy', name: 'Edge-Gate Grade Strategy', endpoint: '/notary/grade-strategy', method: 'POST', price_usd: GRADE_X402_USD, free_tier: `${GRADE_FREE_LIMIT}/agent/day`, description: 'Grade a settled trading track record -- fail-closed REAL_EDGE|REGIME_LUCK|NEGATIVE_EV|INSUFFICIENT_DATA verdict, out-of-sample + fee/slippage adjusted, Ed25519-signed receipt.', input_schema: { agent: 'string', trades: '[{t,price,side,outcome}]' } },
        { id: 'screen-entity', name: 'OFAC SDN Screen', endpoint: '/notary/screen-entity', method: 'POST', price_usd: SCREEN_X402_USD, free_tier: `${SCREEN_FREE_LIMIT}/agent/day`, description: 'Name-based OFAC Specially Designated Nationals sanctions screen, signed receipt, source_as_of freshness timestamp included.', input_schema: { agent: 'string', entity: 'string' } },
        { id: 'claim-verdict', name: 'Claim Verdict', endpoint: '/notary/claim-verdict', method: 'POST', price_usd: VERDICT_X402_USD, free_tier: `${VERDICT_FREE_LIMIT}/agent/day (+ reputation bonus)`, description: 'Signed verdict on a probabilistic claim, resolved against external ground truth, Ed25519-signed and hash-chained.', input_schema: { agent: 'string', claim: 'string', resolver: 'object' } },
        { id: 'commit', name: 'Commit', endpoint: '/notary/commit', method: 'POST', price_usd: 0.10, free_tier: 'none', description: 'Commit a claim hash -- tamper-evident, Ed25519-signed receipt.', input_schema: { agent: 'string', claim: 'string' } },
        { id: 'regulatory-rules', name: 'Federal Register Rules Search', endpoint: '/notary/regulatory-rules', method: 'POST', price_usd: REGISTER_X402_USD, free_tier: `${REGISTER_FREE_LIMIT}/agent/day`, description: 'Search the most recent 100 published Federal Register RULE documents by agency and/or keyword, signed receipt.', input_schema: { agent: 'string', agency: 'string (optional)', keyword: 'string (optional)' } },
        { id: 'federal-awards', name: 'USAspending Top Awards Search', endpoint: '/notary/federal-awards', method: 'POST', price_usd: AWARDS_X402_USD, free_tier: `${AWARDS_FREE_LIMIT}/agent/day`, description: 'Search the top-100-by-dollar-amount federal contract award snapshot (trailing 30 days) by recipient name and/or minimum amount, signed receipt.', input_schema: { agent: 'string', recipient: 'string (optional)', min_amount: 'number (optional)' } },
        { id: 'insider-conviction', name: 'Insider Conviction Score', endpoint: '/notary/insider-conviction', method: 'POST', price_usd: INSIDER_X402_USD, free_tier: `${INSIDER_FREE_LIMIT}/agent/day`, description: 'Proprietary conviction scoring over public EDGAR Form 4 open-market insider cluster buys (cluster size, dollar weight, ownership delta, distress cross-ref), refreshed nightly, signed receipt.', input_schema: { agent: 'string', ticker: 'string (optional)', min_conviction: 'number (optional)' } },
        { id: 'smart-money', name: 'Smart-Money Accumulation', endpoint: '/notary/smart-money', method: 'POST', price_usd: SMARTMONEY_X402_USD, free_tier: `${SMARTMONEY_FREE_LIMIT}/agent/day`, description: 'Proprietary 13D activist filing x insider conviction composite, refreshed nightly on trading days, signed receipt.', input_schema: { agent: 'string', ticker: 'string (optional)', apex_only: 'boolean (optional)' } },
        { id: 'distress-score', name: 'Distress Foresight Score', endpoint: '/notary/distress-score', method: 'POST', price_usd: DISTRESS_X402_USD, free_tier: `${DISTRESS_FREE_LIMIT}/agent/day`, description: 'Validated distress-foresight score for a single ticker: modified Altman Z-score from live SEC XBRL companyfacts, point-in-time, non-financials only. Backtested 71% sensitivity / 100% specificity / ~109-day median lead on real Chapter 11 filings. Live per-call SEC fetch, not cached.', input_schema: { agent: 'string', ticker: 'string' } },
        { id: 'agent-clearance', name: 'Agent Clearance', endpoint: '/notary/agent-clearance', method: 'POST', price_usd: CLEARANCE_X402_USD, free_tier: `${CLEARANCE_FREE_LIMIT}/agent/day`, description: 'Pre-transaction clearance for agent-to-agent payments: name-based OFAC SDN screen plus live on-chain wallet signals (contract bytecode presence, native balance, transaction count on Base), fused into a CLEAR/REVIEW/BLOCK verdict with stated reasons, signed receipt. Scope stated in every response: no mixer screening or multi-hop fund-flow forensics.', input_schema: { agent: 'string', counterparty_name: 'string (optional)', counterparty_wallet: 'string EVM address (optional)' } },
      ],
      discovery: { manifest: 'https://nolawealthfinancial.com/notary/.well-known/x402.json', verify: 'https://nolawealthfinancial.com/notary/verify?hash=<receipt_hash>' },
    });
  }

  // Free, no x402 -- pre-action authorization is a safety gate, not a paid
  // product. Charging per-check would incentivize callers to skip it to
  // save money, which defeats its entire purpose. Unlike claim-verdict, this
  // touches only our own local ledger, no external API cost to us.
  if (req.method === 'POST' && u.pathname === '/register-policy') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
      try {
        const auth = require('./pre_action_authorization.cjs');
        const policy = auth.registerPolicy(b.agent, { max_per_action: b.max_per_action, max_per_day: b.max_per_day, currency: b.currency });
        return send(res, 200, { ok: true, policy });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/authorize') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let b; try { b = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
      try {
        const auth = require('./pre_action_authorization.cjs');
        const result = await auth.authorize({ agent: b.agent, action: b.action, amount: b.amount });
        return send(res, result.ok ? 200 : 403, {
          decision: result.decision, reason: result.reason,
          receipt: { hash: result.receipt.receipt_hash, verify: result.receipt.verify, signature: result.receipt.signature },
        });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/verify') {
    const h = u.searchParams.get('hash');
    if (!h) return send(res, 400, { error: 'hash query param required' });
    const result = verifyReceipt(h);
    // Content-negotiated receipt permalink page (2026-07-07 design review):
    // browsers get a rendered page, API/curl callers (Accept: */* or
    // application/json, or explicit ?format=json) keep getting raw JSON --
    // zero behavior change for existing programmatic callers.
    const wantsHtml = !u.searchParams.has('format') && (req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      try {
        const { renderReceiptPage } = require('/home/marcus/core/receipt_page.cjs');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(renderReceiptPage({ hash: h, verifyResult: result, publicBase: 'https://nolawealthfinancial.com/notary' }));
      } catch (e) { console.error('[notary-marcus] receipt page render failed:', e.message); /* fall through to JSON */ }
    }
    return send(res, 200, result);
  }

  // Dynamic sitemap for receipt permalinks (2026-07-07 SEO fix) -- each
  // signed receipt is unique, timestamped, indexable content, but the
  // site's static sitemap.xml only ever listed 5 fixed pages. Referenced as
  // a second `Sitemap:` line in robots.txt (standard, doesn't touch the
  // existing static sitemap). Capped at the 500 most recent receipts --
  // recent-first, so the freshest proof is always what search engines see.
  if (req.method === 'GET' && u.pathname === '/sitemap-receipts.xml') {
    let entries = [];
    try {
      entries = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .slice(-500).reverse();
    } catch {}
    const urls = entries.map(r => `  <url><loc>https://nolawealthfinancial.com/notary/verify?hash=${r.receipt_hash}</loc><lastmod>${r.ts.slice(0, 10)}</lastmod><changefreq>never</changefreq></url>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    return res.end(xml);
  }

  if (req.method === 'GET' && u.pathname === '/findings-feed') {
    const limit = Math.min(parseInt(u.searchParams.get('limit'), 10) || 30, FINDINGS_FEED_CAP);
    const agent = u.searchParams.get('agent') || 'anon';
    const used = meterToday('findings-feed:' + agent, req);
    if (used > FINDINGS_FEED_FREE_LIMIT) {
      return send(res, 402, {
        x402Version: 1,
        error: `free findings-feed tier exhausted (${FINDINGS_FEED_FREE_LIMIT}/agent/day) — retry with an x402 X-PAYMENT header`,
        used, free_limit_per_day: FINDINGS_FEED_FREE_LIMIT,
        accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(FINDINGS_FEED_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/findings-feed`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
      });
    }
    return send(res, 200, { findings: readFindingsFeed(limit) });
  }

  // /commit has no free tier -- always requires payment OR a valid API key
  // (ported 2026-07-08, see handleCommitWithKey/keyValid above). There is no
  // free path being offered that isn't actually free.
  if (req.method === 'POST' && u.pathname === '/commit') {
    const apiKeyRecord = keyValid(req.headers['x-api-key']);
    if (apiKeyRecord) return handleCommitWithKey(req, res, apiKeyRecord);
    if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
    return dispatchX402(req, res);
  }

  if (req.method === 'POST' && u.pathname === '/dispute') {
    if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
    return dispatchX402(req, res);
  }

  if (req.method === 'POST' && u.pathname === '/grade-strategy') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    if (!edgeGate) return send(res, 503, { error: 'edge gate unavailable' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = b.agent || 'anon';
      if (!Array.isArray(b.trades)) return send(res, 400, { error: 'trades[] required: [{t,price,side,outcome}]' });
      const used = meterToday('grade:' + agent, req);
      const effLimit_GRADE_FREE_LIMIT = GRADE_FREE_LIMIT + evaluatorBonus(agent);
      if (used > effLimit_GRADE_FREE_LIMIT) {
        return send(res, 402, {
          x402Version: 1,
          error: `free grading tier exhausted (${effLimit_GRADE_FREE_LIMIT}/agent/day) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effLimit_GRADE_FREE_LIMIT,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(GRADE_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/grade-strategy`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            extensions: bazaarExt(
              { agent: 'my-agent', trades: [{ t: '2026-07-01T00:00:00Z', price: 100, side: 'buy', outcome: 'win' }] },
              { verdict: 'REAL_EDGE', profit_factor: 1.8, sample_size: 42, receipt_hash: 'def456...', signature: 'base64_ed25519_sig' },
            ) }],
        });
      }
      try {
        const v = edgeGate.gradeStrategy(b.trades, b.opts || {});
        // FREE TIER = UNSIGNED (money-leak fix 2026-07-09). The verdict is the local
        // edge-gate math — free forever, that's the distribution. The Ed25519-signed,
        // independently-verifiable receipt is the PAID product ($x402). Free no longer
        // hands out the exact artifact agents pay for; it hands out the answer plus a
        // reason to pay for proof of it. This is also the machine-payable signal
        // (accepts[]) the x402 discovery crawler needs to index this resource.
        return send(res, 200, {
          ...v, agent, tier: 'free', signed: false, receipt_hash: null, signature: null, verify: null,
          upgrade: `UNSIGNED — this verdict is not independently verifiable and cannot be shown to a counterparty. Retry this exact request with an x402 X-PAYMENT header for a signed, verifiable receipt.`,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(GRADE_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/grade-strategy`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' },
            extensions: bazaarExt(
              { agent: 'my-agent', trades: [{ t: '2026-07-01T00:00:00Z', price: 100, side: 'buy', outcome: 'win' }] },
              { verdict: 'REAL_EDGE', profit_factor: 1.8, sample_size: 42, receipt_hash: 'def456...', signature: 'base64_ed25519_sig' },
            ) }],
        });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/screen-entity') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    if (!ofacScreen) return send(res, 503, { error: 'screen module unavailable' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = b.agent || 'anon';
      if (!b.entity) return send(res, 400, { error: 'entity required' });
      const used = meterToday('screen:' + agent, req);
      const effLimit_SCREEN_FREE_LIMIT = SCREEN_FREE_LIMIT + evaluatorBonus(agent);
      if (used > effLimit_SCREEN_FREE_LIMIT) {
        return send(res, 402, {
          x402Version: 1,
          error: `free screen tier exhausted (${effLimit_SCREEN_FREE_LIMIT}/agent/day) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effLimit_SCREEN_FREE_LIMIT,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(SCREEN_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/screen-entity`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
        });
      }
      try {
        const result = ofacScreen.screen(b.entity);
        // FREE TIER = UNSIGNED (money-leak fix 2026-07-15, same pattern as grade-strategy
        // 2026-07-09). Computed result is free forever; the Ed25519-signed, independently
        // verifiable receipt is the paid product.
        return send(res, 200, { ...result, agent, tier: 'free', signed: false, receipt_hash: null, signature: null, verify: null,
          upgrade: 'UNSIGNED — this result is not independently verifiable and cannot be shown to a counterparty. Retry this exact request with an x402 X-PAYMENT header for a signed, verifiable receipt.' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/regulatory-rules') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    if (!fedRegister) return send(res, 503, { error: 'lookup module unavailable' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = b.agent || 'anon';
      const used = meterToday('register:' + agent, req);
      const effLimit_REGISTER_FREE_LIMIT = REGISTER_FREE_LIMIT + evaluatorBonus(agent);
      if (used > effLimit_REGISTER_FREE_LIMIT) {
        return send(res, 402, {
          x402Version: 1,
          error: `free tier exhausted (${effLimit_REGISTER_FREE_LIMIT}/agent/day) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effLimit_REGISTER_FREE_LIMIT,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(REGISTER_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/regulatory-rules`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
        });
      }
      try {
        const result = fedRegister.search({ agency: b.agency, keyword: b.keyword, limit: b.limit });
        // FREE TIER = UNSIGNED (money-leak fix 2026-07-15, same pattern as grade-strategy
        // 2026-07-09). Computed result is free forever; the Ed25519-signed, independently
        // verifiable receipt is the paid product.
        return send(res, 200, { ...result, agent, tier: 'free', signed: false, receipt_hash: null, signature: null, verify: null,
          upgrade: 'UNSIGNED — this result is not independently verifiable and cannot be shown to a counterparty. Retry this exact request with an x402 X-PAYMENT header for a signed, verifiable receipt.' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/federal-awards') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    if (!usaSpending) return send(res, 503, { error: 'lookup module unavailable' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = b.agent || 'anon';
      const used = meterToday('awards:' + agent, req);
      const effLimit_AWARDS_FREE_LIMIT = AWARDS_FREE_LIMIT + evaluatorBonus(agent);
      if (used > effLimit_AWARDS_FREE_LIMIT) {
        return send(res, 402, {
          x402Version: 1,
          error: `free tier exhausted (${effLimit_AWARDS_FREE_LIMIT}/agent/day) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effLimit_AWARDS_FREE_LIMIT,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(AWARDS_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/federal-awards`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
        });
      }
      try {
        const result = usaSpending.search({ recipient: b.recipient, min_amount: b.min_amount, limit: b.limit });
        // FREE TIER = UNSIGNED (money-leak fix 2026-07-15, same pattern as grade-strategy
        // 2026-07-09). Computed result is free forever; the Ed25519-signed, independently
        // verifiable receipt is the paid product.
        return send(res, 200, { ...result, agent, tier: 'free', signed: false, receipt_hash: null, signature: null, verify: null,
          upgrade: 'UNSIGNED — this result is not independently verifiable and cannot be shown to a counterparty. Retry this exact request with an x402 X-PAYMENT header for a signed, verifiable receipt.' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/insider-conviction') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    if (!insiderConviction) return send(res, 503, { error: 'lookup module unavailable' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = b.agent || 'anon';
      const used = meterToday('insider:' + agent, req);
      const effLimit_INSIDER_FREE_LIMIT = INSIDER_FREE_LIMIT + evaluatorBonus(agent);
      if (used > effLimit_INSIDER_FREE_LIMIT) {
        return send(res, 402, {
          x402Version: 1,
          error: `free tier exhausted (${effLimit_INSIDER_FREE_LIMIT}/agent/day) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effLimit_INSIDER_FREE_LIMIT,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(INSIDER_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/insider-conviction`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
        });
      }
      try {
        const result = insiderConviction.top({ ticker: b.ticker, min_conviction: b.min_conviction, limit: b.limit });
        // FREE TIER = UNSIGNED (money-leak fix 2026-07-15, same pattern as grade-strategy
        // 2026-07-09). Computed result is free forever; the Ed25519-signed, independently
        // verifiable receipt is the paid product.
        return send(res, 200, { ...result, agent, tier: 'free', signed: false, receipt_hash: null, signature: null, verify: null,
          upgrade: 'UNSIGNED — this result is not independently verifiable and cannot be shown to a counterparty. Retry this exact request with an x402 X-PAYMENT header for a signed, verifiable receipt.' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/smart-money') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    if (!smartMoney) return send(res, 503, { error: 'lookup module unavailable' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = b.agent || 'anon';
      const used = meterToday('smartmoney:' + agent, req);
      const effLimit_SMARTMONEY_FREE_LIMIT = SMARTMONEY_FREE_LIMIT + evaluatorBonus(agent);
      if (used > effLimit_SMARTMONEY_FREE_LIMIT) {
        return send(res, 402, {
          x402Version: 1,
          error: `free tier exhausted (${effLimit_SMARTMONEY_FREE_LIMIT}/agent/day) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effLimit_SMARTMONEY_FREE_LIMIT,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(SMARTMONEY_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/smart-money`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
        });
      }
      try {
        const result = smartMoney.top({ ticker: b.ticker, apex_only: b.apex_only, limit: b.limit });
        // FREE TIER = UNSIGNED (money-leak fix 2026-07-15, same pattern as grade-strategy
        // 2026-07-09). Computed result is free forever; the Ed25519-signed, independently
        // verifiable receipt is the paid product.
        return send(res, 200, { ...result, agent, tier: 'free', signed: false, receipt_hash: null, signature: null, verify: null,
          upgrade: 'UNSIGNED — this result is not independently verifiable and cannot be shown to a counterparty. Retry this exact request with an x402 X-PAYMENT header for a signed, verifiable receipt.' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/distress-score') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    if (!distressScore) return send(res, 503, { error: 'lookup module unavailable' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = b.agent || 'anon';
      if (!b.ticker) return send(res, 400, { error: 'ticker required' });
      const used = meterToday('distress:' + agent, req);
      const effLimit_DISTRESS_FREE_LIMIT = DISTRESS_FREE_LIMIT + evaluatorBonus(agent);
      if (used > effLimit_DISTRESS_FREE_LIMIT) {
        return send(res, 402, {
          x402Version: 1,
          error: `free tier exhausted (${effLimit_DISTRESS_FREE_LIMIT}/agent/day) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effLimit_DISTRESS_FREE_LIMIT,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(DISTRESS_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/distress-score`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
        });
      }
      try {
        const result = await distressScore.score(b.ticker);
        // FREE TIER = UNSIGNED (money-leak fix 2026-07-15, same pattern as grade-strategy
        // 2026-07-09). Computed result is free forever; the Ed25519-signed, independently
        // verifiable receipt is the paid product. findings-feed still records the
        // (unsigned) result happened -- receipt_hash null marks it as unsigned there too.
        appendFindingsFeed({ ticker: result.ticker, status: result.status, receipt_hash: null, ts: new Date().toISOString() });
        return send(res, 200, { ...result, agent, tier: 'free', signed: false, receipt_hash: null, signature: null, verify: null,
          upgrade: 'UNSIGNED — this result is not independently verifiable and cannot be shown to a counterparty. Retry this exact request with an x402 X-PAYMENT header for a signed, verifiable receipt.' });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/claim-verdict') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let b; try { b = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
      if (!b.agent || !b.claim) return send(res, 400, { error: 'agent and claim required' });
      if (!b.resolver || !b.resolver.type) return send(res, 400, { error: 'resolver required' });
      const used = meterToday('verdict:' + b.agent, req);
      // Reputation-weighted bonus, ported from proof_endpoint.cjs (2026-07-04) --
      // this was documented publicly (cost-to-fake weight table, tiered free
      // limits) before it was actually wired into THIS live service. Same
      // verdicts.jsonl ledger both services already share, same function,
      // not a reimplementation -- the anti-Sybil/anti-gaming hardening
      // (rolling window, diversity cap, negative-signal symmetry, stake gate)
      // only holds if this is the exact function, not a rewrite.
      let bonus = 0;
      try { bonus = require('/home/marcus/still-os-consciousness/core/proof_endpoint.cjs').reputationFreeLimitBonus(b.agent); } catch (e) { console.error('[notary-marcus] reputation bonus lookup failed:', e.message); }
      const evalBonus = evaluatorBonus(b.agent);
      const effectiveLimit = VERDICT_FREE_LIMIT + bonus + evalBonus;
      if (used > effectiveLimit) {
        return send(res, 402, {
          x402Version: 1,
          error: `free claim-verdict tier exhausted (${effectiveLimit}/agent/day, base ${VERDICT_FREE_LIMIT} + reputation bonus ${bonus} + evaluator bonus ${evalBonus}) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effectiveLimit, base_limit: VERDICT_FREE_LIMIT, reputation_bonus: bonus, evaluator_bonus: evalBonus,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(VERDICT_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/claim-verdict`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            extensions: bazaarExt(
              { agent: 'my-agent', claim: 'Model X scored 0.87 on benchmark Y at 2026-07-13T00:00:00Z', resolver: { type: 'url_json', url: 'https://example.com/results.json', path: 'score' } },
              { claim_sha256: 'abc123...', receipt_hash: 'def456...', signature: 'base64_ed25519_sig', verify: 'https://nolawealthfinancial.com/notary/verify?hash=def456...', verdict: 'CONFIRMED' },
            ) }],
        });
      }
      const source_ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || null;
      const user_agent = req.headers['user-agent'] || null;
      try {
        const result = await signer.processClaimVerdict(b.agent, b.claim, b.resolver, b.partner_receipt_hash, { source_ip, user_agent });
        // FREE TIER = UNSIGNED (money-leak fix 2026-07-15, same pattern as grade-strategy
        // 2026-07-09). claim_receipt stays (anti-backdating proof the claim predates the
        // outcome, not itself the sellable artifact). verdict_receipt -- the signed proof
        // OF THE OUTCOME -- is the paid product and is withheld on the free tier.
        return send(res, 200, {
          claim_receipt: { hash: result.claimReceipt.receipt_hash, verify: result.claimReceipt.verify },
          verdict: result.verdictObj,
          tier: 'free', signed: false, verdict_receipt: null,
          upgrade: 'UNSIGNED — the verdict above has no signed receipt and cannot be shown to a counterparty. Retry this exact request with an x402 X-PAYMENT header for a signed, verifiable verdict_receipt.',
        });
      } catch (e) { return send(res, 500, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/agent-clearance') {
    if (req.headers['x-payment']) {
      if (!app402) return send(res, 503, { error: 'payment gate unavailable -- refusing rather than serving unmetered' });
      return dispatchX402(req, res);
    }
    if (!agentClearance) return send(res, 503, { error: 'clearance module unavailable' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      let b; try { b = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = b.agent || 'anon';
      if (!b.counterparty_name && !b.counterparty_wallet) return send(res, 400, { error: 'counterparty_name and/or counterparty_wallet required' });
      const used = meterToday('clearance:' + agent, req);
      const effLimit_CLEARANCE_FREE_LIMIT = CLEARANCE_FREE_LIMIT + evaluatorBonus(agent);
      if (used > effLimit_CLEARANCE_FREE_LIMIT) {
        return send(res, 402, {
          x402Version: 1,
          error: `free clearance tier exhausted (${effLimit_CLEARANCE_FREE_LIMIT}/agent/day) — retry this exact request with an x402 X-PAYMENT header`,
          used, free_limit_per_day: effLimit_CLEARANCE_FREE_LIMIT,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(CLEARANCE_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/agent-clearance`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
        });
      }
      try {
        const result = await agentClearance.clear({ counterparty_name: b.counterparty_name, counterparty_wallet: b.counterparty_wallet, intent_hash: b.intent_hash, max_age_seconds: b.max_age_seconds });
        // FREE TIER = UNSIGNED (M2M money-leak fix 2026-07-09). The CLEAR/REVIEW/BLOCK
        // answer is free — that's the adoption hook. The Ed25519-signed receipt is the
        // PAID product: an agent's provable proof-of-diligence that it screened a
        // counterparty BEFORE paying it (the audit artifact that matters in M2M). Free
        // no longer hands out that proof; it hands out the answer + a reason to pay.
        return send(res, 200, {
          ...result, agent, tier: 'free', signed: false, receipt_hash: null, signature: null, verify: null,
          upgrade: `UNSIGNED — this clearance is not provable diligence. Retry with an x402 X-PAYMENT header for a signed, verifiable proof-of-screening receipt you can attach to the transaction.`,
          accepts: [{ scheme: 'exact', network: NET_X402, maxAmountRequired: String(Math.round(CLEARANCE_X402_USD * 1e6)), resource: `https://nolawealthfinancial.com/notary/agent-clearance`, payTo: PAYTO_X402, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', extra: { name: 'USD Coin', version: '2' } }],
        });
      } catch (e) { return send(res, 400, { error: e.message }); }
    });
    return;
  }

  send(res, 404, { error: 'not found', routes: ['GET /health', 'GET /verify?hash=', 'GET /export', 'GET /.well-known/x402.json', 'POST /commit', 'POST /claim-verdict', 'POST /grade-strategy', 'POST /screen-entity', 'POST /regulatory-rules', 'POST /federal-awards', 'POST /insider-conviction', 'POST /smart-money', 'POST /distress-score', 'POST /agent-clearance', 'POST /dispute', 'POST /register-policy', 'POST /authorize'] });
});

server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.on('error', (e) => console.error('[notary-marcus] server error (non-fatal):', e.message));

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`[notary-marcus] listening on http://${HOST}:${PORT} — marcus-owned, no root ever needed to restart this`));
}
module.exports = { server, health, verifyReceipt };
