#!/usr/bin/env node
/**
 * Fixture generator.
 *
 * Creates the fixture repositories used by the integration tests under
 * `fixtures/`. The generator is deterministic and idempotent: re-running it
 * rewrites exactly the same bytes, which keeps the fixtures reviewable in git.
 * No nested git repositories are created here — the tests initialise git in a
 * temporary copy so repository history stays out of the package.
 *
 * Usage: node tools/generate-fixtures.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturesRoot = path.join(root, 'fixtures');

/** @type {Record<string, Record<string, string>>} */
const FIXTURES = {};

/* ------------------------------------------------------------------ simple-ts */

FIXTURES['simple-ts'] = {
  'package.json': JSON.stringify(
    {
      name: 'simple-ts',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'dist/index.js',
      scripts: { build: 'tsc -p tsconfig.json', test: 'node --test dist/**/*.test.js' },
      dependencies: { zod: '^3.23.0' },
      devDependencies: { typescript: '^5.9.0' },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        outDir: 'dist',
        baseUrl: '.',
        paths: { '@app/*': ['src/*'] },
      },
      include: ['src'],
    },
    null,
    2,
  ),
  'README.md': `# simple-ts

A small single package TypeScript repository used as an integration fixture.

## Getting started

\`\`\`bash
npm install
npm test
\`\`\`
`,
  'src/index.ts': `import { formatUserName } from './utils/format-user-name.ts';
import { User } from './models/user.ts';

export function greet(user: User): string {
  return \`Hello \${formatUserName(user)}!\`;
}

export const VERSION = '1.0.0';
`,
  'src/utils/format-user-name.ts': `import type { User } from '../models/user.ts';

export function formatUserName(user: User): string {
  return user.firstName + ' ' + user.lastName;
}

export function sortUsers(users: User[]): User[] {
  return [...users].sort((a, b) => a.lastName.localeCompare(b.lastName));
}
`,
  'src/models/user.ts': `export interface User {
  id: string;
  firstName: string;
  lastName: string;
}

export class InvalidUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUserError';
  }
}

export function assertUser(user: User): void {
  if (user.id.length === 0) throw new InvalidUserError('user id is required');
}
`,
  'test/index.test.ts': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greet } from '../src/index.ts';

test('greets a user', () => {
  assert.equal(greet({ id: '1', firstName: 'Ada', lastName: 'Lovelace' }), 'Hello Ada Lovelace!');
});
`,
};

/* --------------------------------------------------------------- layered-app */

FIXTURES['layered-app'] = {
  'package.json': JSON.stringify(
    {
      name: 'layered-app',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: { start: 'node dist/api/server.js', build: 'tsc -p tsconfig.json', test: 'vitest run' },
      dependencies: { express: '^4.19.0', pg: '^8.11.0', stripe: '^16.0.0', zod: '^3.23.0' },
      devDependencies: { typescript: '^5.9.0', vitest: '^2.0.0' },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist' },
      include: ['src'],
    },
    null,
    2,
  ),
  'package-lock.json': JSON.stringify({ name: 'layered-app', lockfileVersion: 3, requires: true, packages: {} }, null, 2),
  'README.md': `# layered-app

Layered application fixture: domain, application, infrastructure, adapters and API.

## Architecture decisions

Decisions live in \`docs/adr\`.
`,
  'docs/adr/0001-use-postgresql.md': `# 0001 Use PostgreSQL for transactional data

Status: accepted

Payments and users must be stored transactionally, therefore PostgreSQL is the
primary datastore. The repository layer owns all SQL access.
`,
  'docs/adr/0002-idempotent-payments.md': `# 0002 Payment operations must be idempotent

Status: accepted

Every payment command carries an idempotency key. The payment service stores the
key before calling the provider so retries never charge twice.
`,
  'src/domain/user.ts': `export interface User {
  id: string;
  email: string;
}

export class UserNotFoundError extends Error {
  constructor(id: string) {
    super(\`user \${id} not found\`);
    this.name = 'UserNotFoundError';
  }
}
`,
  'src/domain/payment.ts': `export interface Payment {
  id: string;
  userId: string;
  amountCents: number;
  idempotencyKey: string;
  status: 'pending' | 'captured' | 'failed';
}

export class PaymentMustBeIdempotentError extends Error {
  constructor() {
    super('payment must be idempotent');
    this.name = 'PaymentMustBeIdempotentError';
  }
}
`,
  'src/infrastructure/postgres-user-repository.ts': `import { Pool } from 'pg';
import type { User } from '../domain/user.ts';

export class PostgresUserRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<User | null> {
    const result = await this.pool.query('select id, email from users where id = $1', [id]);
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id as string, email: row.email as string };
  }

  async save(user: User): Promise<void> {
    await this.pool.query('insert into users (id, email) values ($1, $2)', [user.id, user.email]);
  }
}
`,
  'src/infrastructure/postgres-payment-repository.ts': `import { Pool } from 'pg';
import type { Payment } from '../domain/payment.ts';

export class PostgresPaymentRepository {
  constructor(private readonly pool: Pool) {}

  async save(payment: Payment): Promise<void> {
    await this.pool.query(
      'insert into payments (id, user_id, amount_cents, idempotency_key, status) values ($1, $2, $3, $4, $5)',
      [payment.id, payment.userId, payment.amountCents, payment.idempotencyKey, payment.status],
    );
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const result = await this.pool.query('select * from payments where idempotency_key = $1', [key]);
    return result.rows[0] === undefined ? null : (result.rows[0] as Payment);
  }
}
`,
  'src/adapters/stripe-adapter.ts': `import Stripe from 'stripe';
import type { Payment } from '../domain/payment.ts';

export class StripeAdapter {
  private readonly client: Stripe;

  constructor(apiKey: string) {
    this.client = new Stripe(apiKey);
  }

  async createCharge(payment: Payment): Promise<string> {
    const charge = await this.client.charges.create({
      amount: payment.amountCents,
      currency: 'usd',
      source: payment.userId,
    });
    return charge.id;
  }
}
`,
  'src/events/event-bus.ts': `import { EventEmitter } from 'node:events';

export class EventBus {
  private readonly emitter = new EventEmitter();

  publish(event: string, payload: unknown): void {
    this.emitter.emit(event, payload);
  }

  subscribe(event: string, handler: (payload: unknown) => void): void {
    this.emitter.on(event, handler);
  }
}
`,
  'src/application/payment-service.ts': `import { PaymentMustBeIdempotentError, type Payment } from '../domain/payment.ts';
import type { PostgresPaymentRepository } from '../infrastructure/postgres-payment-repository.ts';
import type { StripeAdapter } from '../adapters/stripe-adapter.ts';
import type { EventBus } from '../events/event-bus.ts';

export class PaymentService {
  constructor(
    private readonly payments: PostgresPaymentRepository,
    private readonly stripe: StripeAdapter,
    private readonly events: EventBus,
  ) {}

  async createPayment(payment: Payment): Promise<Payment> {
    if (payment.idempotencyKey.length === 0) throw new PaymentMustBeIdempotentError();
    const existing = await this.payments.findByIdempotencyKey(payment.idempotencyKey);
    if (existing !== null) return existing;

    await this.payments.save({ ...payment, status: 'pending' });
    const chargeId = await this.stripe.createCharge(payment);
    await this.payments.save({ ...payment, status: 'captured' });
    this.events.publish('payment.captured', { paymentId: payment.id, chargeId });
    return { ...payment, status: 'captured' };
  }
}
`,
  'src/application/checkout-service.ts': `import type { Payment } from '../domain/payment.ts';
import type { PaymentService } from './payment-service.ts';
import type { PostgresUserRepository } from '../infrastructure/postgres-user-repository.ts';

export class CheckoutService {
  constructor(private readonly payments: PaymentService, private readonly users: PostgresUserRepository) {}

  async checkout(userId: string, amountCents: number, idempotencyKey: string): Promise<Payment> {
    const user = await this.users.findById(userId);
    if (user === null) throw new Error('user not found');
    return this.payments.createPayment({
      id: \`pay_\${idempotencyKey}\`,
      userId: user.id,
      amountCents,
      idempotencyKey,
      status: 'pending',
    });
  }
}
`,
  'src/api/routes.ts': `import { Router } from 'express';
import type { CheckoutService } from '../application/checkout-service.ts';

export function createRoutes(checkout: CheckoutService): Router {
  const router = Router();

  router.post('/payments', async (request, response) => {
    const payment = await checkout.checkout(request.body.userId, request.body.amountCents, request.body.idempotencyKey);
    response.json(payment);
  });

  router.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  return router;
}
`,
  'src/api/server.ts': `import { Pool } from 'pg';
import express from 'express';
import { createRoutes } from './routes.ts';
import { CheckoutService } from '../application/checkout-service.ts';
import { PaymentService } from '../application/payment-service.ts';
import { PostgresUserRepository } from '../infrastructure/postgres-user-repository.ts';
import { PostgresPaymentRepository } from '../infrastructure/postgres-payment-repository.ts';
import { StripeAdapter } from '../adapters/stripe-adapter.ts';
import { EventBus } from '../events/event-bus.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

const users = new PostgresUserRepository(pool);
const payments = new PostgresPaymentRepository(pool);
const stripe = new StripeAdapter(process.env.STRIPE_KEY ?? '');
const events = new EventBus();
const checkout = new CheckoutService(new PaymentService(payments, stripe, events), users);

app.use(express.json());
app.use('/api', createRoutes(checkout));

app.listen(3000, () => {
  events.publish('server.started', { port: 3000 });
});
`,
  'test/payment-service.test.ts': `import { describe, expect, it } from 'vitest';
import { PaymentMustBeIdempotentError } from '../src/domain/payment.ts';

describe('payment invariants', () => {
  it('rejects payments without an idempotency key', () => {
    expect(() => {
      throw new PaymentMustBeIdempotentError();
    }).toThrow(PaymentMustBeIdempotentError);
  });
});
`,
  '.env': 'DATABASE_URL=postgres://app:secret@localhost:5432/app\nSTRIPE_KEY=sk-51Hxw5K8tZ0Qk3hS9pRmZbJ2\n',
};

/* ---------------------------------------------------- CLI project fixture */

FIXTURES['cli-project'] = {
  'package.json': JSON.stringify(
    {
      name: 'cli-project',
      version: '0.2.0',
      private: true,
      type: 'module',
      bin: { 'deploy-tool': 'dist/cli/main.js' },
      scripts: { start: 'node dist/cli/main.js', test: 'node --test' },
      dependencies: { commander: '^12.0.0' },
      devDependencies: { typescript: '^5.9.0' },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist' },
      include: ['src'],
    },
    null,
    2,
  ),
  'yarn.lock': '# yarn lockfile v1\n',
  'README.md': `# cli-project

Command line tool fixture: the package exposes a bin entry and parses arguments.
`,
  'src/cli/main.ts': `import { Command } from 'commander';
import { runDeploy } from './commands/deploy.ts';

const program = new Command();

program.name('deploy-tool').description('Deployment helper').version('0.2.0');

program
  .command('deploy')
  .argument('<environment>')
  .option('--dry-run', 'print the plan without applying it')
  .action(async (environment, options) => {
    await runDeploy(environment, options.dryRun === true);
  });

program.parse(process.argv);
`,
  'src/cli/commands/deploy.ts': `import { loadConfig } from '../config/loader.ts';

export async function runDeploy(environment: string, dryRun: boolean): Promise<void> {
  const config = await loadConfig(environment);
  console.log(\`deploying to \${environment} (dry run: \${dryRun})\`);
  console.log(config);
}
`,
  'src/cli/config/loader.ts': `import { readFile } from 'node:fs/promises';

export interface DeployConfig {
  environment: string;
  region: string;
}

export async function loadConfig(environment: string): Promise<DeployConfig> {
  const contents = await readFile(\`config/\${environment}.json\`, 'utf8');
  return { environment, region: JSON.parse(contents).region ?? 'us-east-1' };
}
`,
  'test/deploy.test.ts': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/cli/config/loader.ts';

test('loadConfig keeps the environment name', async () => {
  const config = await loadConfig('staging');
  assert.equal(config.environment, 'staging');
});
`,
};

/* ------------------------------------------------------------------- monorepo */

FIXTURES['monorepo'] = {
  'package.json': JSON.stringify(
    {
      name: 'acme-monorepo',
      version: '1.0.0',
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      scripts: { build: 'tsc -b packages/*/tsconfig.json', test: 'npm run test --workspaces --if-present' },
      devDependencies: { typescript: '^5.9.0' },
    },
    null,
    2,
  ),
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'pnpm-lock.yaml': 'lockfileVersion: 6.0\n',
  'README.md': `# acme-monorepo

Workspace monorepo fixture with an api package, a payments package and a users
package. The api package depends on both workspaces; payments depends on users.
`,
  'packages/api/package.json': JSON.stringify(
    {
      name: '@acme/api',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'dist/index.js',
      dependencies: { '@acme/payments': '^1.0.0', '@acme/users': '^1.0.0', express: '^4.19.0' },
    },
    null,
    2,
  ),
  'packages/api/src/index.ts': `export { createServer } from './server.ts';
export { apiRoutes } from './routes.ts';
`,
  'packages/api/src/routes.ts': `import { Router } from 'express';
import { createPayment } from '@acme/payments';
import { findUser } from '@acme/users';

export function apiRoutes(): Router {
  const router = Router();

  router.post('/checkout', async (request, response) => {
    const user = await findUser(request.body.userId);
    if (user === null) {
      response.status(404).json({ error: 'user not found' });
      return;
    }
    const payment = await createPayment(user.id, request.body.amountCents);
    response.json(payment);
  });

  return router;
}
`,
  'packages/api/src/server.ts': `import express from 'express';
import { apiRoutes } from './routes.ts';

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes());
  return app;
}
`,
  'packages/payments/package.json': JSON.stringify(
    {
      name: '@acme/payments',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'dist/index.js',
      dependencies: { '@acme/users': '^1.0.0', stripe: '^16.0.0' },
    },
    null,
    2,
  ),
  'packages/payments/src/index.ts': `export { createPayment, refundPayment } from './payment-service.ts';
export { StripeAdapter } from './stripe-adapter.ts';
`,
  'packages/payments/src/payment-service.ts': `import type { StripeAdapter } from './stripe-adapter.ts';
import { findUser } from '@acme/users';

let adapter: StripeAdapter | null = null;

export function bindStripe(instance: StripeAdapter): void {
  adapter = instance;
}

export interface Payment {
  id: string;
  userId: string;
  amountCents: number;
  status: 'captured' | 'refunded';
}

export async function createPayment(userId: string, amountCents: number): Promise<Payment> {
  const user = await findUser(userId);
  if (user === null) throw new Error(\`user \${userId} not found\`);
  const chargeId = await (adapter as StripeAdapter).createCharge(amountCents);
  void chargeId;
  return { id: chargeId, userId, amountCents, status: 'captured' };
}

export async function refundPayment(payment: Payment): Promise<Payment> {
  await (adapter as StripeAdapter).refundCharge(payment.id);
  return { ...payment, status: 'refunded' };
}
`,
  'packages/payments/src/stripe-adapter.ts': `import Stripe from 'stripe';

export class StripeAdapter {
  private readonly client: Stripe;

  constructor(apiKey: string) {
    this.client = new Stripe(apiKey);
  }

  async createCharge(amountCents: number): Promise<string> {
    const charge = await this.client.charges.create({ amount: amountCents, currency: 'usd', source: 'tok_visa' });
    return charge.id;
  }

  async refundCharge(chargeId: string): Promise<void> {
    await this.client.refunds.create({ charge: chargeId });
  }
}
`,
  'packages/users/package.json': JSON.stringify(
    {
      name: '@acme/users',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'dist/index.js',
      dependencies: { pg: '^8.11.0' },
    },
    null,
    2,
  ),
  'packages/users/src/index.ts': `export { findUser, saveUser } from './user-repository.ts';
export type { User } from './user.ts';
`,
  'packages/users/src/user.ts': `export interface User {
  id: string;
  email: string;
}
`,
  'packages/users/src/user-repository.ts': `import { Pool } from 'pg';
import type { User } from './user.ts';

const pool = new Pool();

export async function findUser(id: string): Promise<User | null> {
  const result = await pool.query('select id, email from users where id = $1', [id]);
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id as string, email: row.email as string };
}

export async function saveUser(user: User): Promise<void> {
  await pool.query('insert into users (id, email) values ($1, $2)', [user.id, user.email]);
}
`,
};

/* ------------------------------------------------------------------ api-project */

FIXTURES['api-project'] = {
  'package.json': JSON.stringify(
    {
      name: 'api-project',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'dist/server.js',
      scripts: { start: 'node dist/server.js', dev: 'tsx src/server.ts', test: 'vitest run' },
      dependencies: { express: '^4.19.0', zod: '^3.23.0', ioredis: '^5.4.0' },
      devDependencies: { typescript: '^5.9.0', tsx: '^4.16.0', vitest: '^2.0.0' },
    },
    null,
    2,
  ),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        outDir: 'dist',
        baseUrl: '.',
        paths: { '@api/*': ['src/*'] },
      },
      include: ['src'],
    },
    null,
    2,
  ),
  'README.md': `# api-project

HTTP API fixture: routes, services, repositories, middleware and a cache adapter.
`,
  'src/server.ts': `import express from 'express';
import Redis from 'ioredis';
import { paymentRoutes } from './routes/payment-routes.ts';
import { requireAuth } from './middleware/auth-middleware.ts';
import { PaymentService } from './services/payment-service.ts';
import { PostgresPaymentRepository } from './repositories/payment-repository.ts';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const repository = new PostgresPaymentRepository();
const payments = new PaymentService(repository, redis);

const app = express();
app.use(express.json());
app.use('/payments', requireAuth, paymentRoutes(payments));

app.listen(4000);
`,
  'src/routes/payment-routes.ts': `import { Router } from 'express';
import type { PaymentService } from '../services/payment-service.ts';

export function paymentRoutes(payments: PaymentService): Router {
  const router = Router();

  router.post('/', async (request, response) => {
    const payment = await payments.capture(request.body.userId, request.body.amountCents);
    response.status(201).json(payment);
  });

  router.get('/:id', async (request, response) => {
    const payment = await payments.get(request.params['id']);
    if (payment === null) {
      response.status(404).json({ error: 'payment not found' });
      return;
    }
    response.json(payment);
  });

  return router;
}
`,
  'src/services/payment-service.ts': `import { z } from 'zod';
import type { Payment, PostgresPaymentRepository } from '../repositories/payment-repository.ts';
import type Redis from 'ioredis';

const captureSchema = z.object({ userId: z.string().min(1), amountCents: z.number().positive() });

export class PaymentService {
  constructor(
    private readonly repository: PostgresPaymentRepository,
    private readonly cache: Redis,
  ) {}

  async capture(userId: string, amountCents: number): Promise<Payment> {
    const input = captureSchema.parse({ userId, amountCents });
    const payment = await this.repository.save({
      id: crypto.randomUUID(),
      userId: input.userId,
      amountCents: input.amountCents,
    });
    await this.cache.set(\`payment:\${payment.id}\`, JSON.stringify(payment), 'EX', 3600);
    return payment;
  }

  async get(id: string): Promise<Payment | null> {
    const cached = await this.cache.get(\`payment:\${id}\`);
    if (cached !== null) return JSON.parse(cached) as Payment;
    return this.repository.find(id);
  }
}
`,
  'src/repositories/payment-repository.ts': `import { Pool } from 'pg';
import type { PoolClient } from 'pg';

export interface Payment {
  id: string;
  userId: string;
  amountCents: number;
}

export class PostgresPaymentRepository {
  private readonly pool = new Pool();

  async save(payment: Payment): Promise<Payment> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into payments (id, user_id, amount_cents) values ($1, $2, $3)', [
        payment.id,
        payment.userId,
        payment.amountCents,
      ]);
      await client.query('commit');
      return payment;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async find(id: string): Promise<Payment | null> {
    const result = await this.pool.query('select id, user_id, amount_cents from payments where id = $1', [id]);
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id as string, userId: row.user_id as string, amountCents: row.amount_cents as number };
  }
}
`,
  'src/middleware/auth-middleware.ts': `import type { NextFunction, Request, Response } from 'express';
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
`,
  'src/services/token-service.ts': `import { createHmac } from 'node:crypto';

const SECRET = process.env.TOKEN_SECRET ?? 'development-secret';

export function verifyToken(token: string): boolean {
  const [payload, signature] = token.split('.');
  if (payload === undefined || signature === undefined) return false;
  const expected = createHmac('sha256', SECRET).update(payload).digest('hex');
  return expected === signature;
}

export function issueToken(payload: string): string {
  return \`\${payload}.\${createHmac('sha256', SECRET).update(payload).digest('hex')}\`;
}
`,
  'test/payment-service.test.ts': `import { describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from '../src/services/token-service.ts';

describe('token service', () => {
  it('verifies tokens it issued', () => {
    const token = issueToken('user:1');
    expect(verifyToken(token)).toBe(true);
  });
});
`,
};

/* ------------------------------------------------------------------- writing */

export function writeAllFixtures() {
  const summary = {};
  for (const [name, files] of Object.entries(FIXTURES)) {
    const directory = path.join(fixturesRoot, name);
    rmSync(directory, { recursive: true, force: true });
    const written = [];
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = path.join(directory, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents.endsWith('\n') ? contents : `${contents}\n`, 'utf8');
      written.push(relativePath);
    }
    summary[name] = written;
  }
  return summary;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  const summary = writeAllFixtures();
  for (const [name, files] of Object.entries(summary)) {
    process.stdout.write(`fixtures/${name}: ${files.length} file(s)\n`);
  }
}