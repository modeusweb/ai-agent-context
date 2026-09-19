import { Pool } from 'pg';
import type { PoolClient } from 'pg';

export interface Payment {
  id: string;
  userId: string;
  amountCents: number;
}

export class PostgresPaymentRepository {
  private readonly pool = new Pool();

  async save(payment: Payment): Promise<Payment> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into payments (id, user_id, amount_cents) values ($1, $2, $3)', [
        payment.id,
        payment.userId,
        payment.amountCents,
      ]);
      await client.query('commit');
      return payment;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async find(id: string): Promise<Payment | null> {
    const result = await this.pool.query('select id, user_id, amount_cents from payments where id = $1', [id]);
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id as string, userId: row.user_id as string, amountCents: row.amount_cents as number };
  }
}
