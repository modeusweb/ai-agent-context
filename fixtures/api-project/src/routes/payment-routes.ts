import { Router } from 'express';
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
