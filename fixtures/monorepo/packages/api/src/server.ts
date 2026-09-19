import express from 'express';
import { apiRoutes } from './routes.ts';

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes());
  return app;
}
