import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/cli/config/loader.ts';

test('loadConfig keeps the environment name', async () => {
  const config = await loadConfig('staging');
  assert.equal(config.environment, 'staging');
});
