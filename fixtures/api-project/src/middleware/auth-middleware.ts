import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/token-service.ts';

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  const header = request.header('authorization');
  const token = header === undefined ? undefined : header.replace(/^Bearer /, '');
  if (token === undefined || !verifyToken(token)) {
    response.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
