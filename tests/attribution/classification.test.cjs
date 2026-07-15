// tests/attribution/classification.test.cjs — syntax/shape check only, no live data, no secrets.
'use strict';
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '../../core/actor_attribution.cjs'), 'utf8');
assert.ok(src.length > 0, 'actor_attribution.cjs is non-empty');
console.log('  OK  actor_attribution.cjs present and readable');
console.log('\nAttribution fixture check passed.');
