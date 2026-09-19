# 0002 Payment operations must be idempotent

Status: accepted

Every payment command carries an idempotency key. The payment service stores the
key before calling the provider so retries never charge twice.
