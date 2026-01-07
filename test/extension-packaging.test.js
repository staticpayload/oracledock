const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

test('activation event registers the Oracle Dock view', () => {
  const manifestPath = path.join(repoRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.ok(Array.isArray(manifest.activationEvents));
  assert.ok(manifest.activationEvents.includes('onView:oracledock.sidebarView'));
});

test('vsix packaging includes node-pty native module', () => {
  const ignorePath = path.join(repoRoot, '.vscodeignore');
  const ignoreText = fs.readFileSync(ignorePath, 'utf8');

  assert.match(ignoreText, /!node_modules\/node-pty\/\*\*/);
});

test('webview has a fatal error overlay', () => {
  const sourcePath = path.join(repoRoot, 'src', 'extension.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /fatal-error/);
  assert.match(source, /showFatalError/);
});
