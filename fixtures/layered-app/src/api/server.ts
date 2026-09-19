import { Pool } from 'pg';
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
