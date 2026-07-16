'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

// Helper to run command
function runCmd(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore', cwd: rootDir });
    return true;
  } catch (err) {
    return false;
  }
}

console.log("== syntax check ==");
let failed = false;

// 1. Check CJS files
const coreFiles = fs.readdirSync(path.join(rootDir, 'core'))
  .filter(f => f.endsWith('.cjs'))
  .map(f => path.join('core', f));

for (const file of coreFiles) {
  // Use node -c to syntax check
  const ok = runCmd(`node -c "${file}"`);
  if (ok) {
    console.log(`  OK  ${file}`);
  } else {
    console.error(`  FAIL ${file}`);
    failed = true;
  }
}

// 2. Check bash scripts (if bash is present)
let hasBash = false;
try {
  execSync('bash --version', { stdio: 'ignore' });
  hasBash = true;
} catch (e) {
  // bash not available
}

const deployDir = path.join(rootDir, 'deploy');
if (fs.existsSync(deployDir)) {
  const shFiles = fs.readdirSync(deployDir)
    .filter(f => f.endsWith('.sh'))
    .map(f => path.join('deploy', f));

  for (const file of shFiles) {
    if (hasBash) {
      const ok = runCmd(`bash -n "${file}"`);
      if (ok) {
        console.log(`  OK  ${file}`);
      } else {
        console.error(`  FAIL ${file}`);
        failed = true;
      }
    } else {
      console.log(`  SKIP (no bash) ${file}`);
    }
  }
}

if (failed) {
  process.exit(1);
}
