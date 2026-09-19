export interface User {
  id: string;
  firstName: string;
  lastName: string;
}

export class InvalidUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUserError';
  }
}

export function assertUser(user: User): void {
  if (user.id.length === 0) throw new InvalidUserError('user id is required');
}
