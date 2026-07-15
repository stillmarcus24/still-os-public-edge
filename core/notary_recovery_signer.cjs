'use strict';
const crypto = require('crypto');

function loadPrivateKey() {
  return {
    privateKey: 'mock-private-key-data',
    notary_fp: 'mock-fingerprint',
    publicKeyPem: 'mock-public-key-pem'
  };
}

function commit({ agent, claim, privateKey, notary_fp, actor_evidence }) {
  const claimText = typeof claim === 'string' ? claim : JSON.stringify(claim);
  const hash = crypto.createHash('sha256').update(claimText).digest('hex');
  return {
    receipt_hash: hash,
    signature: Buffer.from('mock-sig-' + hash).toString('base64'),
    verify: `http://127.0.0.1:8466/verify?hash=${hash}`,
    ts: new Date().toISOString(),
    agent: agent || 'anon',
    claim_sha256: hash,
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    notary_fp: notary_fp || 'mock-fingerprint',
    attestation_type: 'mock',
    authoritative: true,
    proves: 'mock-proof'
  };
}

async function processClaimVerdict(agent, claim, resolver, partner_receipt_hash, opts) {
  const claimHash = crypto.createHash('sha256').update(claim).digest('hex');
  const verdictHash = crypto.createHash('sha256').update(claim + '-verdict').digest('hex');
  return {
    claimReceipt: {
      receipt_hash: claimHash,
      verify: `http://127.0.0.1:8466/verify?hash=${claimHash}`
    },
    verdictObj: {
      status: 'VERIFIED',
      resolver: resolver || 'mock-resolver',
      resolved_at: new Date().toISOString()
    },
    verdictReceipt: {
      receipt_hash: verdictHash,
      verify: `http://127.0.0.1:8466/verify?hash=${verdictHash}`,
      signature: Buffer.from('mock-verdict-sig-' + verdictHash).toString('base64')
    }
  };
}

module.exports = {
  loadPrivateKey,
  commit,
  processClaimVerdict
};
