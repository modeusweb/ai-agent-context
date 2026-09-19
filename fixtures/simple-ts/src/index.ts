import { formatUserName } from './utils/format-user-name.ts';
import { User } from './models/user.ts';

export function greet(user: User): string {
  return `Hello ${formatUserName(user)}!`;
}

export const VERSION = '1.0.0';
