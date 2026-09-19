import { PaymentMustBeIdempotentError, type Payment } from '../domain/payment.ts';
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
