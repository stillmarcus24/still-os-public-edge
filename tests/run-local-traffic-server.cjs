'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const rootDir = path.join(__dirname, '..');
const localMockDir = path.join(rootDir, 'local-mock');

// Ensure local-mock directories exist
if (!fs.existsSync(localMockDir)) {
  fs.mkdirSync(localMockDir, { recursive: true });
}

// Generate mock receipts data
const mockReceipts = [
  { ts: new Date(Date.now() - 3600000 * 5).toISOString(), agent: 'agent_76d34a922e', claim: JSON.stringify({ ticker: 'AAPL', z_score: 1.45, flag: 'GREY_ZONE' }), receipt_hash: '0x76d34a922eabcdef1234567890abcdef', verify: 'https://nolawealthfinancial.com/notary/verify?hash=0x76d34a922eabcdef1234567890abcdef' },
  { ts: new Date(Date.now() - 3600000 * 4).toISOString(), agent: 'agent_4868e4adf5', claim: JSON.stringify({ ticker: 'TSLA', z_score: 3.12, flag: 'SAFE' }), receipt_hash: '0x4868e4adf5abcdef1234567890abcdef', verify: 'https://nolawealthfinancial.com/notary/verify?hash=0x4868e4adf5abcdef1234567890abcdef' },
  { ts: new Date(Date.now() - 3600000 * 3).toISOString(), agent: 'agent_1bffaa4457', claim: JSON.stringify({ entity: 'ACME CORP', match: false, hits: [] }), receipt_hash: '0x1bffaa4457abcdef1234567890abcdef', verify: 'https://nolawealthfinancial.com/notary/verify?hash=0x1bffaa4457abcdef1234567890abcdef' },
  { ts: new Date(Date.now() - 3600000 * 2).toISOString(), agent: 'agent_8dd6dd9ca9', claim: JSON.stringify({ ticker: 'NVDA', z_score: 4.89, flag: 'SAFE' }), receipt_hash: '0x8dd6dd9ca9abcdef1234567890abcdef', verify: 'https://nolawealthfinancial.com/notary/verify?hash=0x8dd6dd9ca9abcdef1234567890abcdef' },
  { ts: new Date(Date.now() - 3600000 * 1).toISOString(), agent: 'agent_76d34a922e', claim: JSON.stringify({ ticker: 'BABA', z_score: 0.85, flag: 'DISTRESS' }), receipt_hash: '0x76d34a922ebbbbbb1234567890abcdef', verify: 'https://nolawealthfinancial.com/notary/verify?hash=0x76d34a922ebbbbbb1234567890abcdef' },
  { ts: new Date(Date.now() - 3600000 * 0.5).toISOString(), agent: 'INTERNAL_SYSTEM', actor_class: 'INTERNAL_SYSTEM', claim: 'internal health check', receipt_hash: '0xinternalhealthcheckabcdef1234567890' }
];

const receiptsContent = mockReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(path.join(localMockDir, 'receipts.jsonl'), receiptsContent);

// Generate initial mock log file
const mockLogs = [
  { ts: Date.now() / 1000 - 60, request: { remote_ip: '192.168.1.10', uri: '/', method: 'GET', headers: { 'User-Agent': ['Mozilla/5.0 Chrome/120.0'] } }, status: 200 },
  { ts: Date.now() / 1000 - 50, request: { remote_ip: '192.168.1.11', uri: '/openapi.json', method: 'GET', headers: { 'User-Agent': ['Agent402'] } }, status: 200 },
  { ts: Date.now() / 1000 - 40, request: { remote_ip: '192.168.1.12', uri: '/notary/distress-score', method: 'POST', headers: { 'User-Agent': ['mako-pulse-prober'] } }, status: 402 },
  { ts: Date.now() / 1000 - 30, request: { remote_ip: '192.168.1.12', uri: '/notary/distress-score', method: 'POST', headers: { 'User-Agent': ['mako-pulse-prober'], 'Payment-Signature': ['mock-sig'] } }, status: 200 },
  { ts: Date.now() / 1000 - 20, request: { remote_ip: '192.168.1.13', uri: '/notary/verify?hash=0x76d34a922e', method: 'GET', headers: { 'User-Agent': ['Mozilla/5.0 Safari/605'] } }, status: 200 }
];

const logsContent = mockLogs.map(l => JSON.stringify(l)).join('\n') + '\n';
fs.writeFileSync(path.join(localMockDir, 'nolawealth-access.log'), logsContent);

// Generate initial mock conversion tracking logs
const mockConversionLogs = [
  // /distress-score conversion (converted within window)
  { ts: new Date(Date.now() - 3600000 * 2).toISOString(), type: 'free', endpoint: '/distress-score', agent: 'agent_76d34a922e', signature: 'sig_distress_1' },
  { ts: new Date(Date.now() - 3600000 * 1).toISOString(), type: 'paid', endpoint: '/distress-score', agent: 'agent_76d34a922e', signature: 'sig_distress_1' },
  
  // /distress-score non-conversion
  { ts: new Date(Date.now() - 3600000 * 3).toISOString(), type: 'free', endpoint: '/distress-score', agent: 'agent_4868e4adf5', signature: 'sig_distress_2' },
  
  // /regulatory-rules conversion
  { ts: new Date(Date.now() - 3600000 * 4).toISOString(), type: 'free', endpoint: '/regulatory-rules', agent: 'agent_1bffaa4457', signature: 'sig_reg_1' },
  { ts: new Date(Date.now() - 3600000 * 3.5).toISOString(), type: 'paid', endpoint: '/regulatory-rules', agent: 'agent_1bffaa4457', signature: 'sig_reg_1' },
  
  // /regulatory-rules non-conversion
  { ts: new Date(Date.now() - 3600000 * 5).toISOString(), type: 'free', endpoint: '/regulatory-rules', agent: 'agent_8dd6dd9ca9', signature: 'sig_reg_2' }
];
const conversionContent = mockConversionLogs.map(l => JSON.stringify(l)).join('\n') + '\n';
fs.writeFileSync(path.join(localMockDir, 'conversion-tracking.jsonl'), conversionContent);


// Helper to normalize path matching
function isHomePath(filePath) {
  if (typeof filePath !== 'string') return false;
  return filePath.includes('home/marcus') || filePath.includes('home\\marcus');
}

function isCaddyLogPath(filePath) {
  if (typeof filePath !== 'string') return false;
  return filePath.includes('caddy') || filePath.includes('nolawealth-access.log');
}

// 1. Intercept fs functions to map production paths to local-mock
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (filePath, options) {
  if (isHomePath(filePath)) {
    const base = path.basename(filePath);
    if (base === 'reports') {
      // Map to reports directory
      return originalReadFileSync(path.join(rootDir, 'reports', options), options);
    }
    const mockPath = path.join(localMockDir, base);
    if (fs.existsSync(mockPath)) {
      return originalReadFileSync(mockPath, options);
    }
  }
  if (isCaddyLogPath(filePath)) {
    const base = path.basename(filePath);
    return originalReadFileSync(path.join(localMockDir, base), options);
  }
  return originalReadFileSync.apply(this, arguments);
};

const originalReaddirSync = fs.readdirSync;
fs.readdirSync = function (dirPath) {
  if (isCaddyLogPath(dirPath)) {
    return [ 'nolawealth-access.log' ];
  }
  return originalReaddirSync.apply(this, arguments);
};

const originalExistsSync = fs.existsSync;
fs.existsSync = function (filePath) {
  if (isHomePath(filePath)) {
    const base = path.basename(filePath);
    const mockPath = path.join(localMockDir, base);
    if (originalExistsSync(mockPath)) return true;
  }
  if (isCaddyLogPath(filePath)) {
    return true;
  }
  return originalExistsSync.apply(this, arguments);
};

const originalReadFile = fs.readFile;
fs.readFile = function (filePath, callback) {
  if (isHomePath(filePath)) {
    const base = path.basename(filePath);
    // If it's STATIC_DIR, serve from local reports
    const localPath = path.join(rootDir, 'reports', base);
    if (fs.existsSync(localPath)) {
      return originalReadFile(localPath, callback);
    }
  }
  return originalReadFile.apply(this, arguments);
};

// 2. Intercept child_process spawn to mock 'tail' command
const child_process = require('child_process');
const originalSpawn = child_process.spawn;
child_process.spawn = function (command, args, options) {
  if (command === 'tail') {
    console.log('[Dev Server Sandbox] Intercepted spawn of tail command.');
    const mockProcess = new EventEmitter();
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    
    // Simulate live logs every few seconds
    let logIndex = 0;
    const interval = setInterval(() => {
      const nextLog = {
        ts: Date.now() / 1000,
        request: {
          remote_ip: `192.168.1.${10 + (logIndex % 5)}`,
          uri: logIndex % 3 === 0 ? '/notary/distress-score' : logIndex % 3 === 1 ? '/openapi.json' : '/notary/verify',
          method: logIndex % 3 === 0 ? 'POST' : 'GET',
          headers: {
            'User-Agent': [logIndex % 2 === 0 ? 'Mozilla/5.0 Chrome/120.0' : 'Agent402']
          }
        },
        status: logIndex % 4 === 0 ? 402 : 200
      };
      
      mockProcess.stdout.emit('data', Buffer.from(JSON.stringify(nextLog) + '\n'));
      logIndex++;
    }, 4000);

    mockProcess.kill = () => {
      clearInterval(interval);
    };
    return mockProcess;
  }
  return originalSpawn.apply(this, arguments);
};

// 3. Intercept require to redirect custom packages
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.includes('actor_attribution.cjs')) {
    return originalRequire.call(this, path.join(rootDir, 'core', 'actor_attribution.cjs'));
  }
  return originalRequire.apply(this, arguments);
};

// Override BIND_IP to localhost using environment variable
process.env.LIVE_TRAFFIC_BIND_IP = '127.0.0.1';

// Load the server module
require(path.join(rootDir, 'core', 'live_traffic_server.cjs'));

console.log('[Dev Server Sandbox] Localhost environment prepared.');
console.log('[Dev Server Sandbox] Listening on http://127.0.0.1:8901');

