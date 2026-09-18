/**
 * Package-name → signal mapping.
 *
 * Signals are coarse, deterministic, structural observations ("this file imports
 * a database client"), not conclusions. Architecture detection combines them
 * with file names, paths and dependency shape, and always reports confidence.
 */
import { SIGNALS } from '../types.ts';

interface SignalRule {
  /** Exact package name, or a `@scope/*` prefix pattern. */
  match: string;
  signal: string;
}

const RULES: SignalRule[] = [
  { match: '@prisma/client', signal: SIGNALS.dbAccess },
  { match: 'prisma', signal: SIGNALS.dbAccess },
  { match: 'pg', signal: SIGNALS.dbAccess },
  { match: 'mysql', signal: SIGNALS.dbAccess },
  { match: 'mysql2', signal: SIGNALS.dbAccess },
  { match: 'mongoose', signal: SIGNALS.dbAccess },
  { match: 'mongodb', signal: SIGNALS.dbAccess },
  { match: 'typeorm', signal: SIGNALS.dbAccess },
  { match: 'knex', signal: SIGNALS.dbAccess },
  { match: 'drizzle-orm', signal: SIGNALS.dbAccess },
  { match: 'sequelize', signal: SIGNALS.dbAccess },
  { match: 'better-sqlite3', signal: SIGNALS.dbAccess },
  { match: 'ioredis', signal: SIGNALS.dbAccess },
  { match: 'redis', signal: SIGNALS.dbAccess },
  { match: 'express', signal: SIGNALS.httpFramework },
  { match: 'fastify', signal: SIGNALS.httpFramework },
  { match: 'koa', signal: SIGNALS.httpFramework },
  { match: 'hono', signal: SIGNALS.httpFramework },
  { match: '@nestjs/*', signal: SIGNALS.httpFramework },
  { match: 'react', signal: SIGNALS.uiFramework },
  { match: 'react-dom', signal: SIGNALS.uiFramework },
  { match: 'vue', signal: SIGNALS.uiFramework },
  { match: 'svelte', signal: SIGNALS.uiFramework },
  { match: 'next', signal: SIGNALS.uiFramework },
  { match: 'solid-js', signal: SIGNALS.uiFramework },
  { match: '@angular/*', signal: SIGNALS.uiFramework },
  { match: 'axios', signal: SIGNALS.httpClient },
  { match: 'node-fetch', signal: SIGNALS.httpClient },
  { match: 'undici', signal: SIGNALS.httpClient },
  { match: 'graphql', signal: SIGNALS.graphql },
  { match: '@apollo/*', signal: SIGNALS.graphql },
  { match: 'zod', signal: SIGNALS.validation },
  { match: 'yup', signal: SIGNALS.validation },
  { match: 'joi', signal: SIGNALS.validation },
  { match: 'ajv', signal: SIGNALS.validation },
  { match: 'class-validator', signal: SIGNALS.validation },
  { match: 'stripe', signal: SIGNALS.externalSdk },
  { match: 'twilio', signal: SIGNALS.externalSdk },
  { match: '@sendgrid/*', signal: SIGNALS.externalSdk },
  { match: 'openai', signal: SIGNALS.externalSdk },
  { match: '@anthropic-ai/*', signal: SIGNALS.externalSdk },
  { match: '@aws-sdk/*', signal: SIGNALS.externalSdk },
  { match: 'bull', signal: SIGNALS.queue },
  { match: 'bullmq', signal: SIGNALS.queue },
  { match: 'kafkajs', signal: SIGNALS.queue },
  { match: 'amqplib', signal: SIGNALS.queue },
  { match: 'nats', signal: SIGNALS.queue },
  { match: 'worker_threads', signal: SIGNALS.worker },
  { match: 'node:worker_threads', signal: SIGNALS.worker },
  { match: 'vitest', signal: SIGNALS.testFramework },
  { match: 'jest', signal: SIGNALS.testFramework },
  { match: 'mocha', signal: SIGNALS.testFramework },
  { match: 'ava', signal: SIGNALS.testFramework },
  { match: '@playwright/test', signal: SIGNALS.testFramework },
  { match: 'cypress', signal: SIGNALS.testFramework },
  { match: 'dotenv', signal: SIGNALS.configLibrary },
  { match: 'convict', signal: SIGNALS.configLibrary },
  { match: 'winston', signal: SIGNALS.loggingLibrary },
  { match: 'pino', signal: SIGNALS.loggingLibrary },
  { match: 'log4js', signal: SIGNALS.loggingLibrary },
  { match: 'bunyan', signal: SIGNALS.loggingLibrary },
  { match: 'commander', signal: SIGNALS.cliFramework },
  { match: 'yargs', signal: SIGNALS.cliFramework },
  { match: 'cac', signal: SIGNALS.cliFramework },
  { match: 'meow', signal: SIGNALS.cliFramework },
  { match: '@oclif/*', signal: SIGNALS.cliFramework },
];

/** Extracts the package name from an import specifier (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.length === 0) return null;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? null;
}

/** Signals implied by importing `specifier`. */
export function signalsForSpecifier(specifier: string): string[] {
  const packageName = packageNameFromSpecifier(specifier);
  if (packageName === null) return [];
  const signals: string[] = [];
  if (specifier.startsWith('node:') || packageName.startsWith('node:')) {
    const bare = specifier.replace(/^node:/, '');
    if (bare === 'worker_threads') signals.push(SIGNALS.worker);
    return signals;
  }
  for (const rule of RULES) {
    if (rule.match.endsWith('/*')) {
      const prefix = rule.match.slice(0, -1);
      if (packageName.startsWith(prefix)) signals.push(rule.signal);
      continue;
    }
    if (packageName === rule.match) signals.push(rule.signal);
  }
  return signals;
}