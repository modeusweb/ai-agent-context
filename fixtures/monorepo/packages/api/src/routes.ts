import { Router } from 'express';
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
