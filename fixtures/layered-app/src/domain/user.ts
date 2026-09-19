export interface User {
  id: string;
  email: string;
}

export class UserNotFoundError extends Error {
  constructor(id: string) {
    super(`user ${id} not found`);
    this.name = 'UserNotFoundError';
  }
}
