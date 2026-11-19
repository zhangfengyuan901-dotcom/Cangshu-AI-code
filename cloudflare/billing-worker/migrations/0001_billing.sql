PRAGMA foreign_keys = ON;
CREATE TABLE customers (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0 AND held<=balance),
 max_concurrency INTEGER NOT NULL DEFAULT 100 CHECK(max_concurrency BETWEEN 1 AND 1000), created_at INTEGER NOT NULL
);
CREATE TABLE api_keys (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES customers(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 preview TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','revoked')),
 created_at INTEGER NOT NULL, last_used_at INTEGER, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE provider_accounts (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('backup','main','image')),
 name TEXT NOT NULL, max_concurrency INTEGER NOT NULL DEFAULT 100 CHECK(max_concurrency BETWEEN 1 AND 1000)
);
CREATE TABLE provider_keys (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES provider_accounts(id), provider TEXT NOT NULL,
 name TEXT NOT NULL, encrypted_secret TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, preview TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
 max_concurrency INTEGER NOT NULL DEFAULT 100 CHECK(max_concurrency BETWEEN 1 AND 100), priority INTEGER NOT NULL DEFAULT 0,
 cooldown_until INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE models (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('video','image')),
 name TEXT NOT NULL, billing TEXT NOT NULL CHECK(billing IN ('per_second','fixed')),
 cost_rate INTEGER NOT NULL CHECK(cost_rate>=0), markup_bps INTEGER NOT NULL DEFAULT 10000 CHECK(markup_bps=10000),
 fixed_sale INTEGER, spec_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)), version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES customers(id), api_key_id TEXT NOT NULL REFERENCES api_keys(id),
 request_id TEXT NOT NULL, request_hash TEXT NOT NULL, model_id TEXT NOT NULL REFERENCES models(id), provider TEXT NOT NULL, kind TEXT NOT NULL,
 payload_json TEXT NOT NULL, quote_json TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>0),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','preparing','submitting','processing','unknown','transferring','succeeded','failed','cancelled')),
 upstream_id TEXT, upstream_url TEXT, provider_key_id TEXT REFERENCES provider_keys(id), result_key TEXT,
 charged INTEGER NOT NULL DEFAULT 0 CHECK(charged>=0 AND charged<=reserved), progress REAL,
 error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(user_id,request_id), UNIQUE(provider_key_id,upstream_id)
);
CREATE INDEX tasks_work ON tasks(state,updated_at);
CREATE INDEX tasks_user ON tasks(user_id,created_at);
CREATE TABLE key_leases (task_id TEXT PRIMARY KEY REFERENCES tasks(id), key_id TEXT NOT NULL REFERENCES provider_keys(id), created_at INTEGER NOT NULL);
CREATE INDEX lease_key ON key_leases(key_id);
CREATE TABLE ledger (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES customers(id), kind TEXT NOT NULL CHECK(kind IN ('recharge','hold','settle','release','refund')),
 amount INTEGER NOT NULL CHECK(amount>=0), held_delta INTEGER NOT NULL, balance_delta INTEGER NOT NULL,
 reference_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
 UNIQUE(kind,reference_id)
);
CREATE TRIGGER ledger_apply AFTER INSERT ON ledger BEGIN
 UPDATE customers SET balance=balance+NEW.balance_delta,held=held+NEW.held_delta WHERE id=NEW.user_id;
END;
CREATE TRIGGER task_reserve AFTER INSERT ON tasks BEGIN
 SELECT RAISE(ABORT,'CUSTOMER_DISABLED') WHERE (SELECT status FROM customers WHERE id=NEW.user_id)!='active';
 SELECT RAISE(ABORT,'CUSTOMER_CONCURRENCY') WHERE (SELECT COUNT(*) FROM tasks WHERE user_id=NEW.user_id AND state NOT IN ('succeeded','failed','cancelled'))>(SELECT max_concurrency FROM customers WHERE id=NEW.user_id);
 INSERT INTO ledger VALUES ('hold:'||NEW.id,NEW.user_id,'hold',NEW.reserved,NEW.reserved,0,NEW.id,'任务预冻结',NEW.created_at);
END;
CREATE TRIGGER lease_capacity BEFORE INSERT ON key_leases BEGIN
 SELECT RAISE(ABORT,'TASK_NOT_QUEUED') WHERE NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.task_id AND state='queued');
 SELECT RAISE(ABORT,'KEY_UNAVAILABLE') WHERE NOT EXISTS(SELECT 1 FROM provider_keys k JOIN provider_accounts a ON a.id=k.account_id JOIN tasks t ON t.id=NEW.task_id WHERE k.id=NEW.key_id AND k.provider=t.provider AND a.provider=k.provider AND k.status='active' AND k.cooldown_until<=NEW.created_at);
 SELECT RAISE(ABORT,'KEY_FULL') WHERE (SELECT COUNT(*) FROM key_leases WHERE key_id=NEW.key_id)>=(SELECT max_concurrency FROM provider_keys WHERE id=NEW.key_id);
 SELECT RAISE(ABORT,'ACCOUNT_FULL') WHERE (SELECT COUNT(*) FROM key_leases l JOIN provider_keys k ON k.id=l.key_id WHERE k.account_id=(SELECT account_id FROM provider_keys WHERE id=NEW.key_id))>=(SELECT a.max_concurrency FROM provider_accounts a JOIN provider_keys k ON k.account_id=a.id WHERE k.id=NEW.key_id);
END;
CREATE TRIGGER task_terminal_guard BEFORE UPDATE OF state ON tasks WHEN NEW.state!=OLD.state BEGIN
 SELECT RAISE(ABORT,'TASK_TERMINAL') WHERE OLD.state IN ('succeeded','failed','cancelled');
 SELECT RAISE(ABORT,'RESULT_REQUIRED') WHERE NEW.state='succeeded' AND (NEW.result_key IS NULL OR NEW.result_key='' OR OLD.state!='transferring');
 SELECT RAISE(ABORT,'ALREADY_SUBMITTED') WHERE NEW.state='cancelled' AND OLD.state!='queued';
END;
CREATE TRIGGER task_settle AFTER UPDATE OF state ON tasks WHEN NEW.state='succeeded' AND OLD.state!='succeeded' BEGIN
 INSERT INTO ledger VALUES ('settle:'||NEW.id,NEW.user_id,'settle',NEW.charged,-NEW.reserved,-NEW.charged,NEW.id,'生成成功并已转存',NEW.updated_at);
 DELETE FROM key_leases WHERE task_id=NEW.id;
END;
CREATE TRIGGER task_release AFTER UPDATE OF state ON tasks WHEN NEW.state IN ('failed','cancelled') AND OLD.state NOT IN ('failed','cancelled') BEGIN
 INSERT INTO ledger VALUES ('release:'||NEW.id,NEW.user_id,'release',NEW.reserved,-NEW.reserved,0,NEW.id,'失败或取消，全额解冻',NEW.updated_at);
 DELETE FROM key_leases WHERE task_id=NEW.id;
END;
CREATE TRIGGER generation_done AFTER UPDATE OF state ON tasks WHEN NEW.state='transferring' BEGIN
 DELETE FROM key_leases WHERE task_id=NEW.id;
END;
CREATE TABLE recharges (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES customers(id), email_snapshot TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0), request_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
 transaction_id TEXT UNIQUE, note TEXT NOT NULL DEFAULT '', reviewed_by TEXT, created_at INTEGER NOT NULL, reviewed_at INTEGER,
 UNIQUE(user_id,request_id)
);
CREATE TRIGGER recharge_terminal BEFORE UPDATE OF state ON recharges WHEN OLD.state!='pending' BEGIN SELECT RAISE(ABORT,'RECHARGE_ALREADY_REVIEWED'); END;
CREATE TRIGGER recharge_credit AFTER UPDATE OF state ON recharges WHEN NEW.state='approved' AND OLD.state='pending' BEGIN
 SELECT RAISE(ABORT,'PAYMENT_REFERENCE_REQUIRED') WHERE NEW.transaction_id IS NULL OR length(NEW.transaction_id)<6;
 INSERT INTO ledger VALUES ('recharge:'||NEW.id,NEW.user_id,'recharge',NEW.amount,0,NEW.amount,NEW.id,'支付宝人工核验到账',NEW.reviewed_at);
END;
CREATE TABLE audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO settings VALUES ('generation_enabled','false');

