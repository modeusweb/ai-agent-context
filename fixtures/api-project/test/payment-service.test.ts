import { describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from '../src/services/token-service.ts';

describe('token service', () => {
  it('verifies tokens it issued', () => {
    const token = issueToken('user:1');
    expect(verifyToken(token)).toBe(true);
  });
});
