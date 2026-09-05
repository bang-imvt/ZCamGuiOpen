'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Installed via `npm run prepare` so every checkout gets the publish-boundary
// pre-commit hook without external dependencies. Non-destructive: an existing
// local hook is left untouched.
const source = path.join(__dirname, '..', 'githooks', 'pre-commit');
const target = path.join(__dirname, '..', '.git', 'hooks', 'pre-commit');

if (fs.existsSync(target)) {
  console.log('pre-commit hook already exists; leaving it untouched');
  return;
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log('Installed pre-commit hook: blocks commits that would include publish-boundary material');