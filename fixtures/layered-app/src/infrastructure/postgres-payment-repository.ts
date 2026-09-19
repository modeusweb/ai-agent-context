import { Pool } from 'pg';
import type { Payment } from '../domain/payment.ts';

export class PostgresPaymentRepository {
  constructor(private readonly pool: Pool) {}

  async save(payment: Payment): Promise<void> {
    await this.pool.query(
      'insert into payments (id, user_id, amount_cents, idempotency_key, status) values ($1, $2, $3, $4, $5)',
      [payment.id, payment.userId, payment.amountCents, payment.idempotencyKey, payment.status],
    );
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const result = await this.pool.query('select * from payments where idempotency_key = $1', [key]);
    return result.rows[0] === undefined ? null : (result.rows[0] as Payment);
  }
}
