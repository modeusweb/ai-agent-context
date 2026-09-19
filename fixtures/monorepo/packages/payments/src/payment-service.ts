import type { StripeAdapter } from './stripe-adapter.ts';
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
  if (user === null) throw new Error(`user ${userId} not found`);
  const chargeId = await (adapter as StripeAdapter).createCharge(amountCents);
  void chargeId;
  return { id: chargeId, userId, amountCents, status: 'captured' };
}

export async function refundPayment(payment: Payment): Promise<Payment> {
  await (adapter as StripeAdapter).refundCharge(payment.id);
  return { ...payment, status: 'refunded' };
}
