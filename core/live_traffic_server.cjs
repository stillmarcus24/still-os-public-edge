#!/usr/bin/env node
'use strict';
// Real-time external-traffic feed for nolawealthfinancial.com.
// Tails the live Caddy access log, classifies each hit (internal / bot / browser-shaped),
// enriches external IPs with org/ASN/country (ip-api.com, cached, rate-limited), and
// streams events over SSE to the tailnet-only dashboard. Deterministic log-tailing +
// classification — no LLM calls, same class of persistent infra as the notary/x402 services.

const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');
const path = require('path');
const { buildAttribution } = require('./actor_attribution.cjs');

const BIND_IP = process.env.LIVE_TRAFFIC_BIND_IP || '100.111.225.126';
const PORT = 8901;
const LOG_FILE = '/var/log/caddy/nolawealth-access.log';
const LOG_DIR = '/var/log/caddy';
const NOTARY_RECEIPTS = '/home/marcus/still-os-consciousness/state/proof-notary/receipts.jsonl';
const MOLT_LEDGER = '/home/marcus/state/interactions/ledger.jsonl';
const STATIC_DIR = '/home/marcus/reports';
const SELF_IP = '49.13.49.149';
const KILL_FILE = '/home/marcus/still-os-consciousness/state/live-traffic/live-traffic-kill.json';

if (fs.existsSync(KILL_FILE)) {
  console.log('live-traffic-server: kill file present, refusing to start —', KILL_FILE);
  process.exit(0);
}
setInterval(() => {
  if (fs.existsSync(KILL_FILE)) {
    console.log('live-traffic-server: kill file appeared, shutting down');
    process.exit(0);
  }
}, 30000);

const BOT_UAS = [
  ['Agent402', 'Agent402'], ['CarbonMonitor', 'CarbonMonitor'], ['TLM-Audit-Scanner', 'TLM-Audit-Scanner'],
  ['mako-pulse-prober', 'mako-pulse-prober'], ['ClaudeBot', 'ClaudeBot'], ['DataForSeoBot', 'DataForSeoBot'],
  ['402explorer', '402explorer'], ['x402station', 'x402station'], ['x402-observer', 'x402-observer'],
  ['agent-tools.cloud', 'agent-tools.cloud'], ['l9scan', 'l9scan'], ['GuzzleHttp', 'GuzzleHttp'],
  ['axios', 'axios'], ['python-requests', 'python-requests'], ['Python-urllib', 'Python-urllib'],
  ['curl/', 'curl'], ['HeadlessChrome', 'HeadlessChrome'],
];

function classify(ip, ua) {
  if (ip === SELF_IP) return { cls: 'internal', botName: null };
  for (const [needle, name] of BOT_UAS) if (ua.includes(needle)) return { cls: 'bot', botName: name };
  return { cls: 'browser', botName: null };
}

// ---- daily rollup: real computation from source files, replaces hand-pasted arrays ----
// Cached briefly (60s) since it reads/decompresses every rotated log on each cold call.
let dailyCache = null;
let dailyCacheAt = 0;
const DAILY_TTL_MS = 60000;

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
    } catch { /* skip unreadable/rotating-mid-read file */ }
  }
  return lines;
}

function computeDailyRollup() {
  if (dailyCache && Date.now() - dailyCacheAt < DAILY_TTL_MS) return dailyCache;

  const byDaySite = {}; // date -> {bot, browser}
  for (const line of allNolawealthLogLines()) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!d.ts) continue;
    const date = new Date(d.ts * 1000).toISOString().slice(0, 10);
    const req = d.request || {};
    const ip = req.remote_ip || '';
    const ua = ((req.headers || {})['User-Agent'] || [''])[0] || '';
    const { cls } = classify(ip, ua);
    if (cls === 'internal') continue;
    byDaySite[date] = byDaySite[date] || { bot: 0, browser: 0 };
    if (cls === 'bot') byDaySite[date].bot++; else byDaySite[date].browser++;
  }

  const byDayNotary = {};
  try {
    for (const line of fs.readFileSync(NOTARY_RECEIPTS, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (!d.ts) continue;
      const date = d.ts.slice(0, 10);
      byDayNotary[date] = (byDayNotary[date] || 0) + 1;
    }
  } catch {}

  const byDayMolt = {}; // date -> {count, visitors:Set}
  try {
    for (const line of fs.readFileSync(MOLT_LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const ts = d.ts || d.timestamp || d.at;
      if (!ts) continue;
      const date = ts.slice(0, 10);
      byDayMolt[date] = byDayMolt[date] || { count: 0, visitors: new Set() };
      byDayMolt[date].count++;
      const visitor = d.visitor || d.actor || d.user;
      if (visitor) byDayMolt[date].visitors.add(visitor);
    }
  } catch {}

  const allDates = new Set([...Object.keys(byDaySite), ...Object.keys(byDayNotary), ...Object.keys(byDayMolt)]);
  const dates = [...allDates].sort();

  const result = {
    generated_at: new Date().toISOString(),
    dates,
    siteBot: dates.map(d => (byDaySite[d] || {}).bot || 0),
    siteBrowser: dates.map(d => (byDaySite[d] || {}).browser || 0),
    notary: dates.map(d => byDayNotary[d] || 0),
    moltInt: dates.map(d => (byDayMolt[d] || {}).count || 0),
    moltUniq: dates.map(d => (byDayMolt[d] || {}).visitors || new Set()).map(s => s.size),
  };
  dailyCache = result;
  dailyCacheAt = Date.now();
  return result;
}

function getNotaryStats() {
  let count = 0;
  const uniqueAgents = new Set();
  let firstTs = null;
  let lastTs = null;
  try {
    const content = fs.readFileSync(NOTARY_RECEIPTS, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      count++;
      if (d.ts) {
        if (!firstTs) firstTs = d.ts;
        lastTs = d.ts;
      }
      const agent = d.agent || d.agent_id;
      if (agent) uniqueAgents.add(agent);
    }
  } catch (e) {
    // If receipts.jsonl doesn't exist, we fall back gracefully.
  }
  return {
    receipts_total: count,
    unique_agents: uniqueAgents.size,
    first_receipt_ts: firstTs,
    last_receipt_ts: lastTs,
    since_start: totals.sinceStart,
    uptime_seconds: Math.round((Date.now() - new Date(totals.sinceStart).getTime()) / 1000)
  };
}

function getRecentReceipts(limit) {
  const list = [];
  try {
    const content = fs.readFileSync(NOTARY_RECEIPTS, 'utf8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      
      // Mask agent
      const rawAgent = d.agent || d.agent_id || 'unknown';
      let maskedAgent = rawAgent;
      if (rawAgent.length > 10) {
        maskedAgent = rawAgent.slice(0, 8) + '...' + rawAgent.slice(-4);
      }
      
      // Try to parse claim to understand what it was
      let claimSummary = 'Verified Claim';
      if (d.claim) {
        try {
          const parsed = JSON.parse(d.claim);
          if (parsed.ticker) {
            claimSummary = `Distress Score for ${parsed.ticker}`;
            if (parsed.flag) claimSummary += ` (${parsed.flag})`;
          } else if (parsed.entity) {
            claimSummary = `Sanctions Screen: ${parsed.entity}`;
          } else if (parsed.verdict) {
            claimSummary = `Verdict: ${parsed.verdict}`;
          }
        } catch {
          // If claim is not JSON, truncate it
          claimSummary = d.claim.length > 50 ? d.claim.slice(0, 47) + '...' : d.claim;
        }
      }

      list.push({
        ts: d.ts,
        agent: maskedAgent,
        claim_summary: claimSummary,
        receipt_hash: d.receipt_hash || null,
        verify_url: d.verify || d.verify_url || (d.receipt_hash ? `https://nolawealthfinancial.com/notary/verify?hash=${d.receipt_hash}` : null)
      });
      if (list.length >= limit) break;
    }
  } catch (e) {
    // Graceful fallback
  }
  return list;
}

const CONVERSION_LOG = '/home/marcus/still-os-consciousness/state/proof-notary/conversion-tracking.jsonl';
function getConversionStats() {
  const stats = {};
  const ENDPOINTS = [
    '/distress-score',
    '/regulatory-rules',
    '/federal-awards',
    '/insider-conviction',
    '/smart-money'
  ];
  
  for (const ep of ENDPOINTS) {
    stats[ep] = { free_hits: 0, paid_conversions: 0, conversion_rate: 0 };
  }

  try {
    if (fs.existsSync(CONVERSION_LOG)) {
      const content = fs.readFileSync(CONVERSION_LOG, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      
      const freeHits = [];
      const paidHits = new Map();

      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry.endpoint || !entry.signature || !entry.ts) continue;

        if (entry.type === 'free') {
          freeHits.push(entry);
        } else if (entry.type === 'paid') {
          if (!paidHits.has(entry.signature)) {
            paidHits.set(entry.signature, []);
          }
          paidHits.get(entry.signature).push(new Date(entry.ts).getTime());
        }
      }

      const WINDOW_MS = 24 * 3600 * 1000;

      for (const free of freeHits) {
        const ep = free.endpoint;
        if (!stats[ep]) {
          stats[ep] = { free_hits: 0, paid_conversions: 0, conversion_rate: 0 };
        }
        stats[ep].free_hits++;

        const freeTime = new Date(free.ts).getTime();
        const paidTimes = paidHits.get(free.signature) || [];

        const converted = paidTimes.some(paidTime => {
          return paidTime >= freeTime && (paidTime - freeTime) <= WINDOW_MS;
        });

        if (converted) {
          stats[ep].paid_conversions++;
        }
      }

      for (const ep in stats) {
        const s = stats[ep];
        s.conversion_rate = s.free_hits > 0 ? parseFloat((s.paid_conversions / s.free_hits).toFixed(4)) : 0;
      }
    }
  } catch (e) {
    // ignore
  }

  return stats;
}



// ---- IP enrichment: cache + throttled queue (ip-api.com free tier, ~45 req/min) ----
const geoCache = new Map();
const geoQueue = [];
let geoInFlight = false;
const httpMod = http;

function enrichIPreal(ip, cb) {
  if (ip === SELF_IP || ip === '127.0.0.1') return cb({ country: 'internal', org: 'StillOS box', as: '' });
  if (geoCache.has(ip)) return cb(geoCache.get(ip));
  geoQueue.push({ ip, cb });
  pumpGeoQueueReal();
}
function pumpGeoQueueReal() {
  if (geoInFlight || geoQueue.length === 0) return;
  geoInFlight = true;
  const { ip, cb } = geoQueue.shift();
  const req = httpMod.get(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,as`, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      let info = { country: 'unknown', org: 'unknown', as: '' };
      try {
        const j = JSON.parse(body);
        if (j.status === 'success') info = { country: j.country || 'unknown', org: j.org || j.isp || 'unknown', as: j.as || '' };
      } catch {}
      geoCache.set(ip, info);
      cb(info);
      geoInFlight = false;
      setTimeout(pumpGeoQueueReal, 1400);
    });
  });
  req.on('error', () => {
    const info = { country: 'unknown', org: 'lookup-failed', as: '' };
    geoCache.set(ip, info);
    cb(info);
    geoInFlight = false;
    setTimeout(pumpGeoQueueReal, 1400);
  });
}

// ---- state: ring buffer + running totals (resets on restart) ----
const RING_MAX = 200;
const ring = [];
const totals = { internal: 0, bot: 0, browser: 0, sinceStart: new Date().toISOString(), backfilledSince: null };
const byOrigin = new Map(); // key: country|org -> count (external only)

// Backfill today's totals from the log on boot so counters mean something on
// restart instead of starting at zero — no geo calls here (would blow the
// rate limit on a cold-start replay), just count classification.
function backfillToday() {
  let lines;
  try { lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n'); } catch { return; }
  const todayUTC = new Date().toISOString().slice(0, 10);
  let dayStartTs = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!d.ts) continue;
    const iso = new Date(d.ts * 1000).toISOString();
    if (iso.slice(0, 10) !== todayUTC) continue;
    if (dayStartTs === null) dayStartTs = iso;
    const req = d.request || {};
    const ip = req.remote_ip || '';
    const ua = ((req.headers || {})['User-Agent'] || [''])[0] || '';
    const { cls } = classify(ip, ua);
    if (cls === 'internal') totals.internal++;
    else if (cls === 'bot') totals.bot++;
    else totals.browser++;
  }
  totals.backfilledSince = dayStartTs;
}
backfillToday();

const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) res.write(line);
}

function handleLine(line) {
  let d;
  try { d = JSON.parse(line); } catch { return; }
  const req = d.request || {};
  const ip = req.remote_ip || '';
  const uri = req.uri || '';
  const status = d.status;
  const ua = ((req.headers || {})['User-Agent'] || [''])[0] || '';
  const ts = d.ts ? new Date(d.ts * 1000).toISOString() : new Date().toISOString();

  const { cls, botName } = classify(ip, ua);
  if (cls === 'internal') totals.internal++;
  else if (cls === 'bot') totals.bot++;
  else totals.browser++;

  const emit = (origin) => {
    const evt = { ts, ip, uri, status, ua, cls, botName, origin };
    ring.push(evt); if (ring.length > RING_MAX) ring.shift();
    if (cls !== 'internal') {
      const key = `${origin.country} · ${origin.org}`;
      byOrigin.set(key, (byOrigin.get(key) || 0) + 1);
    }
    broadcast({ type: 'hit', evt, totals: { ...totals } });
  };

  if (cls === 'internal') { emit({ country: 'internal', org: 'StillOS box', as: '' }); return; }
  enrichIPreal(ip, origin => emit(origin));
}

function tailLog() {
  const tail = spawn('tail', ['-n', '0', '-F', LOG_FILE]);
  let buf = '';
  tail.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach(l => { if (l.trim()) handleLine(l); });
  });
  tail.stderr.on('data', () => {});
  tail.on('exit', () => setTimeout(tailLog, 2000));
}

// ---- HTTP server: static files + SSE ----
const MIME = { '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' };

let attributionCache = null, attributionCacheAt = 0, attributionInFlight = null;
const ATTRIBUTION_TTL_MS = 5 * 60000; // geo enrichment is rate-limited; don't recompute every request

const server = http.createServer((req, res) => {
  if (req.url === '/conversion-stats.json') {
    let payload;
    try { payload = getConversionStats(); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(payload));
  }
  if (req.url === '/notary-stats.json') {

    let payload;
    try { payload = getNotaryStats(); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(payload));
  }
  if (req.url.startsWith('/receipts.json')) {
    let payload;
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const limit = Math.min(parseInt(u.searchParams.get('limit'), 10) || 20, 100);
      payload = getRecentReceipts(limit);
    }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(payload));
  }
  if (req.url === '/daily.json') {
    let payload;
    try { payload = computeDailyRollup(); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(payload));
  }
  if (req.url === '/attribution.json') {
    const respond = payload => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(payload));
    };
    if (attributionCache && Date.now() - attributionCacheAt < ATTRIBUTION_TTL_MS) return respond(attributionCache);
    if (!attributionInFlight) {
      attributionInFlight = buildAttribution()
        .then(result => { attributionCache = result; attributionCacheAt = Date.now(); attributionInFlight = null; return result; })
        .catch(e => { attributionInFlight = null; throw e; });
    }
    attributionInFlight.then(respond).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (req.url === '/live') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'init', ring, totals, byOrigin: Object.fromEntries(byOrigin) })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  let file = req.url === '/' ? '/engagement-timeline.html' : req.url.split('?')[0];
  const fp = path.join(STATIC_DIR, decodeURIComponent(file));
  if (!fp.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, BIND_IP, () => {
  console.log(`live-traffic-server: listening on http://${BIND_IP}:${PORT} (tailnet-only), tailing ${LOG_FILE}`);
  tailLog();
});
