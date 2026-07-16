'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const localMockDir = path.join(rootDir, 'local-mock');

// Ensure local-mock directories exist
if (!fs.existsSync(localMockDir)) {
  fs.mkdirSync(localMockDir, { recursive: true });
}

// Write mock files if they don't exist
const mocks = {
  'notary-key-split.json': JSON.stringify({ shareA: 'mock-share-a', publicKey: 'mock-public-key' }),
  'usage.json': '{}',
  'receipts.jsonl': '',
  'notary-payments.jsonl': '',
  'findings-feed.jsonl': '',
  'api-keys.json': JSON.stringify({
    'sk_notary_stillos_internal_001': { active: true, name: 'internal' }
  }),
  'notary-admin.key': 'dev-admin-key',
  'calibrate-mainnet.env': 'PAYTO=0xfAB07d26F7627fc4cE459ecf90d7E015F7eEcE71\nNETWORK=base',
  'evaluator-subscribers.json': '{}',
  'registration.json': '{}',
  'index.html': '<html>Mock KYA</html>'
};

for (const [filename, content] of Object.entries(mocks)) {
  const filePath = path.join(localMockDir, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}

// Normalize paths helper
function isHomePath(filePath) {
  if (typeof filePath !== 'string') return false;
  // Match both forward slashes and backslashes on Windows
  return filePath.includes('home/marcus') || filePath.includes('home\\marcus');
}

// 1. Intercept fs functions to map '/home/marcus/' to local-mock
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (filePath, options) {
  if (isHomePath(filePath)) {
    const base = path.basename(filePath);
    const mockPath = path.join(localMockDir, base);
    if (fs.existsSync(mockPath)) {
      return originalReadFileSync(mockPath, options);
    }
  }
  return originalReadFileSync.apply(this, arguments);
};

const originalWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function (filePath, content, options) {
  if (isHomePath(filePath)) {
    const base = path.basename(filePath);
    const mockPath = path.join(localMockDir, base);
    return originalWriteFileSync(mockPath, content, options);
  }
  return originalWriteFileSync.apply(this, arguments);
};

const originalAppendFileSync = fs.appendFileSync;
fs.appendFileSync = function (filePath, content, options) {
  if (isHomePath(filePath)) {
    const base = path.basename(filePath);
    const mockPath = path.join(localMockDir, base);
    return originalAppendFileSync(mockPath, content, options);
  }
  return originalAppendFileSync.apply(this, arguments);
};

const originalExistsSync = fs.existsSync;
fs.existsSync = function (filePath) {
  if (isHomePath(filePath)) {
    const base = path.basename(filePath);
    const mockPath = path.join(localMockDir, base);
    if (originalExistsSync(mockPath)) return true;
  }
  return originalExistsSync.apply(this, arguments);
};

const originalWatch = fs.watch;
fs.watch = function (filePath, options, listener) {
  if (isHomePath(filePath)) {
    const base = path.basename(filePath);
    const mockPath = path.join(localMockDir, base);
    return originalWatch(mockPath, options, listener);
  }
  return originalWatch.apply(this, arguments);
};

// 2. Intercept require to redirect home paths and supply mocks
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  // Redirect express paths
  if (id.includes('/node_modules/express') || id.includes('\\node_modules\\express')) {
    return originalRequire.call(this, 'express');
  }

  // Redirect x402-express to a mock middleware
  if (id.includes('/node_modules/x402-express') || id.includes('\\node_modules\\x402-express') || id === '@x402/express') {
    return {
      paymentMiddleware: function (payTo, endpoints) {
        return function (req, res, next) {
          // Bypasses the payment gateway locally so you can easily test the endpoints
          req.headers['x-payment'] = 'mock-payment';
          next();
        };
      }
    };
  }

  // Redirect custom production modules to mock implementations
  if (id.includes('notary_actor_classifier.cjs')) {
    return { classify: () => ({ confidence: 1, classification: 'developer' }) };
  }
  if (id.includes('notary_bond.cjs')) {
    return { bondRef: () => 'mock-bond-ref', getSignedStatus: () => Promise.resolve('ACTIVE') };
  }
  if (id.includes('payment_notifier.cjs')) {
    return { onPaymentEvent: () => {} };
  }
  if (id.includes('partner_revshare.cjs')) {
    return { recordCall: () => {} };
  }
  if (id.includes('edge_gate.cjs')) {
    return { gradeStrategy: () => ({ grade: 'REAL_EDGE' }) };
  }
  if (id.includes('comms.cjs')) {
    return {};
  }
  if (id.includes('receipt_page.cjs')) {
    return { renderReceiptPage: () => '<html>Mock Receipt</html>' };
  }
  if (id.includes('proof_endpoint.cjs')) {
    return { reputationFreeLimitBonus: () => 0 };
  }

  // Optional mock lookups
  if (id.includes('ofac_screen.cjs')) {
    return { screen: () => ({ match: false, hits: [] }) };
  }
  if (id.includes('federal_register_lookup.cjs')) {
    return { search: () => ({ rules: [] }) };
  }
  if (id.includes('usaspending_lookup.cjs')) {
    return { search: () => ({ awards: [] }) };
  }
  if (id.includes('insider_conviction_lookup.cjs')) {
    return { top: () => ({ conviction: 85, clusters: [{ date: '2026-07-15', buyer: 'Director', shares: 1000 }] }) };
  }
  if (id.includes('smart_money_lookup.cjs')) {
    return { top: () => ({ composite: 90, signals: [{ type: '13D', filer: 'Activist Funds' }] }) };
  }
  if (id.includes('distress_score_lookup.cjs')) {
    return { score: () => Promise.resolve({ z_score: 3.5, flag: 'SAFE' }) };
  }
  if (id.includes('agent_clearance.cjs')) {
    return { clear: () => Promise.resolve({ verdict: 'CLEAR', ofac: {}, wallet_signals: {} }) };
  }

  return originalRequire.apply(this, arguments);
};

console.log('[Dev Server Sandbox] Localhost environment prepared.');
console.log('[Dev Server Sandbox] Interceptors active. Launching server...\n');

// Import the server to start it
const { server } = require('../core/notary_service_marcus.cjs');
const PORT = process.env.NOTARY_MARCUS_PORT || 8466;
const HOST = '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`[Dev Server Sandbox] Listening on http://${HOST}:${PORT}`);
});
