import { createHmac } from 'node:crypto';

const SECRET = process.env.TOKEN_SECRET ?? 'development-secret';

export function verifyToken(token: string): boolean {
  const [payload, signature] = token.split('.');
  if (payload === undefined || signature === undefined) return false;
  const expected = createHmac('sha256', SECRET).update(payload).digest('hex');
  return expected === signature;
}

export function issueToken(payload: string): string {
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('hex')}`;
}
