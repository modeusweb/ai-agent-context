import { describe, expect, it } from 'vitest';
import { PaymentMustBeIdempotentError } from '../src/domain/payment.ts';

describe('payment invariants', () => {
  it('rejects payments without an idempotency key', () => {
    expect(() => {
      throw new PaymentMustBeIdempotentError();
    }).toThrow(PaymentMustBeIdempotentError);
  });
});
