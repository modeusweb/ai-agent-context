import Stripe from 'stripe';

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
