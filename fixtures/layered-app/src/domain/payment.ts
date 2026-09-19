export interface Payment {
  id: string;
  userId: string;
  amountCents: number;
  idempotencyKey: string;
  status: 'pending' | 'captured' | 'failed';
}

export class PaymentMustBeIdempotentError extends Error {
  constructor() {
    super('payment must be idempotent');
    this.name = 'PaymentMustBeIdempotentError';
  }
}
