import { Router } from 'express';
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
