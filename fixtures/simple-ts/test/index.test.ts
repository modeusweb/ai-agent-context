import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from '../src/index.ts';

test('greets a user', () => {
  assert.equal(greet({ id: '1', firstName: 'Ada', lastName: 'Lovelace' }), 'Hello Ada Lovelace!');
});
