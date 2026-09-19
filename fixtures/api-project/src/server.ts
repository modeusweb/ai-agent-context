import express from 'express';
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
