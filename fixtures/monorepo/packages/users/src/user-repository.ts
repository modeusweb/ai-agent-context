import { Pool } from 'pg';
import type { User } from './user.ts';

const pool = new Pool();

export async function findUser(id: string): Promise<User | null> {
  const result = await pool.query('select id, email from users where id = $1', [id]);
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id as string, email: row.email as string };
}

export async function saveUser(user: User): Promise<void> {
  await pool.query('insert into users (id, email) values ($1, $2)', [user.id, user.email]);
}
