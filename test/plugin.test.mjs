import assert from 'node:assert/strict';
import test from 'node:test';

import clientErrorLogger from '../dist/index.js';
import packageJson from '../package.json' with { type: 'json' };

test('declares Vite 5 through Vite 8 compatibility', () => {
  assert.equal(packageJson.version, '0.1.4');
  assert.equal(packageJson.peerDependencies.vite, '^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0');
  assert.equal(packageJson.devDependencies.vite, '^8.3.0');
});

test('injects the default endpoint and duplicate-install guard', () => {
  const plugin = clientErrorLogger();
  const result = plugin.transformIndexHtml('<div id="root"></div>');
  const script = result.tags[0].children;

  assert.equal(result.html, '<div id="root"></div>');
  assert.match(script, /var endpoint = "\/__client-error"/);
  assert.match(script, /__CLIENT_ERROR_LOGGER_INSTALLED__/);
  assert.doesNotMatch(script, /var origWarn = console\.warn/);
});

test('injects a custom endpoint and console.warn capture when enabled', () => {
  const plugin = clientErrorLogger({
    endpoint: '/custom-client-error',
    captureConsoleWarn: true,
  });
  const result = plugin.transformIndexHtml('<div id="root"></div>');
  const script = result.tags[0].children;

  assert.match(script, /var endpoint = "\/custom-client-error"/);
  assert.match(script, /var origWarn = console\.warn/);
  assert.match(script, /type: 'console\.warn'/);
});
