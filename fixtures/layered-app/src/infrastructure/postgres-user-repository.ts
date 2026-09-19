import { Pool } from 'pg';
import type { User } from '../domain/user.ts';

export class PostgresUserRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<User | null> {
    const result = await this.pool.query('select id, email from users where id = $1', [id]);
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id as string, email: row.email as string };
  }

  async save(user: User): Promise<void> {
    await this.pool.query('insert into users (id, email) values ($1, $2)', [user.id, user.email]);
  }
}
