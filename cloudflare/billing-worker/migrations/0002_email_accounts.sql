ALTER TABLE customers ADD COLUMN email_verified_at INTEGER;
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
ALTER TABLE recharges ADD COLUMN payment_reference TEXT;
ALTER TABLE recharges ADD COLUMN payment_reported INTEGER NOT NULL DEFAULT 1 CHECK(payment_reported IN (0,1));
CREATE UNIQUE INDEX recharge_reference ON recharges(payment_reference);
CREATE UNIQUE INDEX recharge_unpaid ON recharges(user_id) WHERE state='pending' AND payment_reported=0;
CREATE TABLE email_challenges (
 id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, code_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 consumed_at INTEGER
);
CREATE INDEX challenge_email ON email_challenges(email,created_at);
CREATE TABLE auth_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE mail_outbox (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES recharges(id),
 recipient TEXT NOT NULL, amount INTEGER NOT NULL, payment_reference TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','retry','needs_review')),
 attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
 first_attempt INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 lease_id TEXT, payload TEXT, provider_id TEXT, last_error TEXT NOT NULL DEFAULT '', sent_at INTEGER
);
CREATE INDEX mail_pending ON mail_outbox(state,next_attempt);
CREATE TRIGGER recharge_payment_guard BEFORE UPDATE OF state ON recharges
WHEN NEW.state='approved' AND OLD.payment_reported<>1
BEGIN
 SELECT RAISE(ABORT,'PAYMENT_NOT_REPORTED');
END;
CREATE TRIGGER recharge_email AFTER UPDATE OF state ON recharges
WHEN NEW.state='approved' AND OLD.state='pending'
BEGIN
 INSERT INTO mail_outbox(id,order_id,recipient,amount,payment_reference,created_at)
 VALUES ('recharge:'||NEW.id,NEW.id,NEW.email_snapshot,NEW.amount,COALESCE(NEW.payment_reference,NEW.id),NEW.reviewed_at);
END;

