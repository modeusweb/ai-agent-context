import type { Payment } from '../domain/payment.ts';
import type { PaymentService } from './payment-service.ts';
import type { PostgresUserRepository } from '../infrastructure/postgres-user-repository.ts';

export class CheckoutService {
  constructor(private readonly payments: PaymentService, private readonly users: PostgresUserRepository) {}

  async checkout(userId: string, amountCents: number, idempotencyKey: string): Promise<Payment> {
    const user = await this.users.findById(userId);
    if (user === null) throw new Error('user not found');
    return this.payments.createPayment({
      id: `pay_${idempotencyKey}`,
      userId: user.id,
      amountCents,
      idempotencyKey,
      status: 'pending',
    });
  }
}
