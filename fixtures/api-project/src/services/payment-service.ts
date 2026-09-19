import { z } from 'zod';
import type { Payment, PostgresPaymentRepository } from '../repositories/payment-repository.ts';
import type Redis from 'ioredis';

const captureSchema = z.object({ userId: z.string().min(1), amountCents: z.number().positive() });

export class PaymentService {
  constructor(
    private readonly repository: PostgresPaymentRepository,
    private readonly cache: Redis,
  ) {}

  async capture(userId: string, amountCents: number): Promise<Payment> {
    const input = captureSchema.parse({ userId, amountCents });
    const payment = await this.repository.save({
      id: crypto.randomUUID(),
      userId: input.userId,
      amountCents: input.amountCents,
    });
    await this.cache.set(`payment:${payment.id}`, JSON.stringify(payment), 'EX', 3600);
    return payment;
  }

  async get(id: string): Promise<Payment | null> {
    const cached = await this.cache.get(`payment:${id}`);
    if (cached !== null) return JSON.parse(cached) as Payment;
    return this.repository.find(id);
  }
}
