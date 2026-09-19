import type { User } from '../models/user.ts';

export function formatUserName(user: User): string {
  return user.firstName + ' ' + user.lastName;
}

export function sortUsers(users: User[]): User[] {
  return [...users].sort((a, b) => a.lastName.localeCompare(b.lastName));
}
