import Stripe from 'stripe';
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
