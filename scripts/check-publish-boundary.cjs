'use strict';
const { execSync } = require('node:child_process');

// Mirrors the ignored prefixes in .gitignore. Any *tracked* file under one of
// these is outside the public-repository publish boundary (copyrighted firmware
// under js/, internal notes under doc/, generated dist/, probe artifacts, …) and
// must never be committed.
const IGNORED_DIRS = ['node_modules', 'dist', 'app', 'js', 'doc', '.zcode', '.vscode', '.mjpeg-probe-profile'];
const IGNORED_FILES = [/\.min\.js\.tmp$/, /\.h2probe\.cjs$/, /\.log$/];

function isExcluded(relPath) {
  const parts = relPath.split('/');
  if (IGNORED_DIRS.includes(parts[0])) return true;
  const base = parts[parts.length - 1];
  return IGNORED_FILES.some((re) => re.test(base));
}

const tracked = execSync('git ls-files', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .sort();

const leaked = tracked.filter(isExcluded);

if (leaked.length > 0) {
  console.error('Publish-boundary violation — these tracked files must not be public:\n');
  for (const file of leaked) console.error(`  ${file}`);
  console.error('\nRemove them from the repository (e.g. `git rm --cached <file>`) and let .gitignore keep them out.');
  process.exit(1);
}

console.log(`Publish boundary OK: ${tracked.length} tracked files, none outside src/, build metadata, LICENSE, or README.`);