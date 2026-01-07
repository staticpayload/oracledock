#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function ensureExecutable(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(filePath, mode | 0o111);
      process.stdout.write(`[oracle-dock] chmod +x ${filePath}\n`);
    }
  } catch (err) {
    process.stdout.write(`[oracle-dock] chmod failed for ${filePath}: ${err.message || err}\n`);
  }
}

function main() {
  if (process.platform === 'win32') return;

  let moduleRoot;
  try {
    moduleRoot = path.dirname(require.resolve('node-pty/package.json'));
  } catch (err) {
    process.stdout.write(`[oracle-dock] node-pty not found: ${err.message || err}\n`);
    return;
  }

  const candidates = [
    path.join(moduleRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(moduleRoot, 'build', 'Release', 'spawn-helper'),
    path.join(moduleRoot, 'build', 'Debug', 'spawn-helper')
  ];

  for (const candidate of candidates) {
    ensureExecutable(candidate);
  }
}

main();
