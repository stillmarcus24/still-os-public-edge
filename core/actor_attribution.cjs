#!/usr/bin/env node
'use strict';
// Actor Attribution & Intent Engine — sessionizes raw Caddy access-log requests into
// per-actor journeys, scores behavioral intent, and separates asserted identity
// (what the requester called itself) from observed identity (where it actually came
// from). Answers, per actor: where did it originate, what kind of actor is it, what
// was it trying to do, how far did it progress, how certain are we.
//
// Deliberately does NOT claim verified human/company identity — every classification
// carries a confidence score and states its evidence, per Marcus's explicit design
// spec (2026-07-15): "report it as asserted name + observed infrastructure + inferred
// behavior + confidence."
//
// CLI:  node core/actor_attribution.cjs [--json]
// Also mounted live at GET /attribution.json on live_traffic_server.cjs.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const LOG_DIR = '/var/log/caddy';
const SELF_IP = '49.13.49.149';
const GEO_CACHE_FILE = '/home/marcus/state/traction/actor-geo-cache.json';
const TOP_N_TO_ENRICH = 40; // geo lookups are rate-limited; only enrich the actors that matter

const BOT_UAS = [
  ['Agent402', 'Agent402'], ['CarbonMonitor', 'CarbonMonitor'], ['TLM-Audit-Scanner', 'TLM-Audit-Scanner'],
  ['mako-pulse-prober', 'mako-pulse-prober'], ['ClaudeBot', 'ClaudeBot'], ['DataForSeoBot', 'DataForSeoBot'],
  ['402explorer', '402explorer'], ['x402station', 'x402station'], ['x402-observer', 'x402-observer'],
  ['agent-tools.cloud', 'agent-tools.cloud'], ['l9scan', 'l9scan'], ['GuzzleHttp', 'GuzzleHttp'],
  ['axios', 'axios'], ['python-requests', 'python-requests'], ['Python-urllib', 'Python-urllib'],
  ['curl/', 'curl'], ['HeadlessChrome', 'HeadlessChrome'],
];
const BROWSER_UA_RE = /Mozilla\/5\.0.*(Chrome|Safari|Firefox|Version)/;
// Coarse hosting/cloud signal — org-string keyword heuristic, not a real ASN database.
// Stated as a heuristic throughout; never presented as verified operator identity.
const HOSTING_KEYWORDS = /amazon|aws|google|microsoft|azure|cloud|digitalocean|linode|vultr|ovh|hetzner|railway|render|fly\.io|tencent|alibaba|oracle|hosting|server|datacenter|data center|colo/i;
const RESIDENTIAL_KEYWORDS = /comcast|verizon|at&t|spectrum|xfinity|charter|cox|frontier|centurylink|telecom|broadband|fiber|residential|mobile|cellular|t-mobile|vodafone|orange|deutsche telekom/i;

const DISCOVERY_PATHS = new Set(['/.well-known/x402', '/openapi.json', '/notary/.well-known/agent-card.json', '/notary/erc8004-registration.json', '/.well-known/agent-card.json', '/agent-card']);
const PAID_PATHS = new Set(['/notary/commit', '/notary/claim-verdict', '/notary/grade-strategy', '/notary/agent-clearance', '/notary/screen-entity', '/notary/distress-score', '/notary/insider-conviction', '/notary/smart-money', '/notary/regulatory-rules', '/notary/federal-awards', '/passport']);

function classifyBotName(ua) {
  for (const [needle, name] of BOT_UAS) if (ua.includes(needle)) return name;
  return null;
}

function actorId(ip, ua) {
  // IP is hashed with a fixed local salt-less sha256 truncation — a correlation
  // handle for grouping likely-related activity, never presented as verified identity.
  const normUa = ua.replace(/\d+\.\d+(\.\d+)?/g, 'N').slice(0, 120); // normalize version numbers so "curl/8.18.0" and "curl/8.17.1" group together
  return 'actor_' + crypto.createHash('sha256').update(ip + '|' + normUa).digest('hex').slice(0, 10);
}

function allNolawealthLogLines() {
  let files;
  try { files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('nolawealth-access')); }
  catch { return []; }
  let lines = [];
  for (const f of files) {
    const fp = path.join(LOG_DIR, f);
    try {
      const raw = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(fp)).toString('utf8') : fs.readFileSync(fp, 'utf8');
      lines = lines.concat(raw.split('\n'));
    } catch {}
  }
  return lines;
}

function loadGeoCache() {
  try { return JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveGeoCache(c) {
  try { fs.mkdirSync(path.dirname(GEO_CACHE_FILE), { recursive: true }); fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(c)); } catch {}
}
function enrichOne(ip) {
  return new Promise(resolve => {
    const req = http.get(`http://ip-api.com/json/${ip}?fields=status,country,isp,org,as`, res => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(j.status === 'success' ? { country: j.country, org: j.org || j.isp || 'unknown' } : { country: 'unknown', org: 'unknown' }); }
        catch { resolve({ country: 'unknown', org: 'unknown' }); }
      });
    });
    req.on('error', () => resolve({ country: 'unknown', org: 'lookup-failed' }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ country: 'unknown', org: 'timeout' }); });
  });
}
async function enrichTopActors(actors, geoCache) {
  const byIp = new Map(); // ip -> total requests across actors sharing it
  for (const a of actors) byIp.set(a.sample_ip, (byIp.get(a.sample_ip) || 0) + a.requests);
  const toEnrich = [...byIp.entries()].filter(([ip]) => ip !== SELF_IP && !geoCache[ip]).sort((a, b) => b[1] - a[1]).slice(0, TOP_N_TO_ENRICH).map(([ip]) => ip);
  for (const ip of toEnrich) {
    geoCache[ip] = await enrichOne(ip);
    await new Promise(r => setTimeout(r, 1400)); // stay under ip-api's free 45/min limit
  }
  saveGeoCache(geoCache);
}

function classifyOrigin(org) {
  if (!org) return { class: 'unknown', confidence: 'unknown' };
  if (HOSTING_KEYWORDS.test(org)) return { class: 'cloud/hosting', confidence: 'high for network, low for operator' };
  if (RESIDENTIAL_KEYWORDS.test(org)) return { class: 'residential ISP', confidence: 'moderate — residential ISP does not itself prove a human' };
  return { class: 'unclassified', confidence: 'unknown' };
}

// Classifies the SEQUENCE of paths/statuses/methods an actor produced — not the
// self-reported name, which can be spoofed or is simply absent (curl, axios, etc).
function classifyBehavior(reqs) {
  const paths = new Set(reqs.map(r => r.path));
  const methods = new Set(reqs.map(r => r.method));
  const statuses = reqs.map(r => r.status);
  const paidHits = reqs.filter(r => PAID_PATHS.has(r.path));
  const discoveryHits = reqs.filter(r => DISCOVERY_PATHS.has(r.path));
  const nonPaidNonDiscovery = reqs.filter(r => !PAID_PATHS.has(r.path) && !DISCOVERY_PATHS.has(r.path));
  const has402 = statuses.includes(402);
  const has405 = statuses.includes(405);
  const hasPaymentHeader = reqs.some(r => r.hasPaymentHeader);
  const has200OnPaid = paidHits.some(r => r.status === 200);

  // cadence: median gap between consecutive requests (ms)
  const sorted = [...reqs].sort((a, b) => a.ts - b.ts);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].ts - sorted[i - 1].ts);
  gaps.sort((a, b) => a - b);
  const medianGapMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const regularCadence = medianGapMs && gaps.length >= 3 && gaps.every(g => Math.abs(g - medianGapMs) < medianGapMs * 0.6 + 5000);

  if (has200OnPaid && hasPaymentHeader) {
    return { classification: 'successfully settled buyer', confidence: 0.95, why: 'paid endpoint returned 200 on a request carrying a payment header' };
  }
  if (hasPaymentHeader) {
    return { classification: 'payment-attempting buyer', confidence: 0.85, why: 'sent a payment header to a paid endpoint but did not receive 200' };
  }
  if (paidHits.length && discoveryHits.length && nonPaidNonDiscovery.length === 0) {
    return { classification: 'x402-aware buyer (discovery + pricing, no payment yet)', confidence: 0.6, why: 'read discovery docs AND probed the paid endpoint, but no payment header seen' };
  }
  if (paidHits.length >= 3 && regularCadence && discoveryHits.length === 0 && nonPaidNonDiscovery.length === 0) {
    return { classification: 'recurring x402 endpoint monitor', confidence: 0.9, why: `${paidHits.length} hits to paid endpoint(s), regular ~${Math.round(medianGapMs / 60000)}min cadence, no discovery reads, no payment` };
  }
  if (has405 && methods.size <= 2 && paths.size <= 2) {
    return { classification: 'generic route prober', confidence: 0.75, why: 'wrong-method probe (405) against a known path, no follow-up with correct method' };
  }
  if (discoveryHits.length && !paidHits.length) {
    return { classification: 'discovery crawler', confidence: 0.85, why: 'read discovery metadata only, never touched a paid endpoint' };
  }
  // Burst-rate + high-404 override: a rapid burst of requests hitting mostly
  // nonexistent paths is a vulnerability/path-enumeration scanner regardless of
  // UA shape — scanners routinely spoof a browser UA to evade naive filtering.
  // Checked BEFORE the browser-shaped check so UA can't override real behavior.
  const notFoundRatio = statuses.length ? statuses.filter(s => s === 404 || s === 308).length / statuses.length : 0;
  const burstWindowMs = reqs.length >= 2 ? Math.max(1, sorted[sorted.length - 1].ts - sorted[0].ts) : Infinity;
  const burstRatePerSec = reqs.length / (burstWindowMs / 1000);
  if (reqs.length >= 8 && burstRatePerSec > 3 && notFoundRatio > 0.5) {
    return { classification: 'vulnerability/path-enumeration scanner', confidence: 0.85, why: `${reqs.length} requests in ${(burstWindowMs / 1000).toFixed(1)}s (${burstRatePerSec.toFixed(1)}/sec), ${Math.round(notFoundRatio * 100)}% 404/308 — burst+miss-rate pattern overrides UA shape` };
  }
  const browserLike = reqs.some(r => BROWSER_UA_RE.test(r.ua) && !classifyBotName(r.ua));
  if (browserLike && nonPaidNonDiscovery.length >= 2) {
    return { classification: 'human browser (probable)', confidence: 0.4, why: 'browser-shaped UA, multiple page/asset requests — no JS beacon corroboration available from access log alone' };
  }
  if (paidHits.length && has402 && !discoveryHits.length) {
    return { classification: 'unknown automation (paid-endpoint prober)', confidence: 0.5, why: 'hit paid endpoint directly without reading discovery docs first' };
  }
  return { classification: 'unknown', confidence: 0.2, why: 'no matching behavioral pattern' };
}

function highestFunnelStage(reqs) {
  const order = ['DISCOVERED', 'METADATA_READ', 'UNPAID_REQUEST', '402_ISSUED', 'PAYMENT_HEADER_RECEIVED', 'PAID_RETRY_200', 'RECEIPT_VERIFIED'];
  let stage = 'DISCOVERED';
  for (const r of reqs) {
    if (DISCOVERY_PATHS.has(r.path) && r.status === 200) stage = maxStage(stage, 'METADATA_READ', order);
    if (PAID_PATHS.has(r.path)) stage = maxStage(stage, 'UNPAID_REQUEST', order);
    if (r.status === 402) stage = maxStage(stage, '402_ISSUED', order);
    if (r.hasPaymentHeader) stage = maxStage(stage, 'PAYMENT_HEADER_RECEIVED', order);
    if (PAID_PATHS.has(r.path) && r.status === 200) stage = maxStage(stage, 'PAID_RETRY_200', order);
    if (r.path === '/notary/check' || r.path === '/check' || r.path === '/notary/verify' || r.path === '/verify') stage = maxStage(stage, 'RECEIPT_VERIFIED', order);
  }
  return stage;
}
function maxStage(a, b, order) { return order.indexOf(b) > order.indexOf(a) ? b : a; }

function parseLine(line) {
  let d; try { d = JSON.parse(line); } catch { return null; }
  if (!d.ts) return null;
  const req = d.request || {};
  const ip = req.remote_ip || '';
  if (ip === SELF_IP) return null; // internal self-traffic excluded from actor attribution entirely
  const ua = ((req.headers || {})['User-Agent'] || [''])[0] || '';
  const hasPaymentHeader = Object.keys(req.headers || {}).some(h => /^x-payment/i.test(h) || /^payment-signature/i.test(h));
  return {
    ts: d.ts * 1000,
    ip,
    ua,
    method: req.method || 'GET',
    path: (req.uri || '').split('?')[0],
    status: d.status,
    hasPaymentHeader,
  };
}

async function buildAttribution() {
  const lines = allNolawealthLogLines();
  const byActor = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = parseLine(line);
    if (!r) continue;
    const id = actorId(r.ip, r.ua);
    if (!byActor.has(id)) byActor.set(id, []);
    byActor.get(id).push(r);
  }

  const geoCache = loadGeoCache();
  const prelim = [...byActor.entries()].map(([id, reqs]) => {
    const sorted = [...reqs].sort((a, b) => a.ts - b.ts);
    const botName = classifyBotName(sorted[0].ua);
    return { id, requests: reqs.length, sample_ip: sorted[0].ip, asserted_name: botName || (BROWSER_UA_RE.test(sorted[0].ua) ? 'browser-shaped (no self-asserted name)' : sorted[0].ua.slice(0, 60) || 'unknown'), reqs: sorted };
  });
  await enrichTopActors(prelim, geoCache);

  const actors = prelim.map(a => {
    const origin = geoCache[a.sample_ip] || { country: 'unknown', org: 'not enriched (below top-' + TOP_N_TO_ENRICH + ' cutoff)' };
    const originClass = classifyOrigin(origin.org);
    const behavior = classifyBehavior(a.reqs);
    const stage = highestFunnelStage(a.reqs);
    const routes = [...new Set(a.reqs.map(r => `${r.method} ${r.path}`))].slice(0, 8);
    const first = new Date(a.reqs[0].ts).toISOString();
    const last = new Date(a.reqs[a.reqs.length - 1].ts).toISOString();
    return {
      actor_id: a.id,
      asserted_name: a.asserted_name,
      observed_network: { country: origin.country, org: origin.org, infrastructure_class: originClass.class, confidence: originClass.confidence },
      requests: a.requests,
      first_seen: first,
      last_seen: last,
      routes,
      journey_highest_stage: stage,
      behavioral_classification: behavior.classification,
      classification_confidence: behavior.confidence,
      classification_evidence: behavior.why,
      operator_identity: 'unknown — asserted name is self-reported and unverified; no signed agent identity, ERC-8004 link, or wallet payment observed',
    };
  }).sort((a, b) => b.requests - a.requests);

  return { generated_at: new Date().toISOString(), self_ip_excluded: SELF_IP, total_actors: actors.length, actors };
}

function formatActorReport(a) {
  const L = [];
  L.push(`ACTOR: ${a.actor_id}`);
  L.push(`Asserted name: ${a.asserted_name}`);
  L.push(`Observed network: ${a.observed_network.org}, ${a.observed_network.country} (${a.observed_network.infrastructure_class})`);
  L.push(`First seen: ${a.first_seen}`);
  L.push(`Last seen: ${a.last_seen}`);
  L.push(`Requests: ${a.requests}`);
  L.push(`Routes: ${a.routes.join(', ')}`);
  L.push(`Journey highest stage: ${a.journey_highest_stage}`);
  L.push(`Behavioral classification: ${a.behavioral_classification}`);
  L.push(`Classification confidence: ${(a.classification_confidence * 100).toFixed(0)}%`);
  L.push(`Evidence: ${a.classification_evidence}`);
  L.push(`Operator identity: ${a.operator_identity}`);
  return L.join('\n');
}

if (require.main === module) {
  buildAttribution().then(result => {
    if (process.argv.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`◆ ACTOR ATTRIBUTION — ${result.total_actors} distinct actors, generated ${result.generated_at}\n`);
    result.actors.slice(0, 25).forEach(a => { console.log(formatActorReport(a)); console.log(''); });
  });
}

module.exports = { buildAttribution, formatActorReport };
