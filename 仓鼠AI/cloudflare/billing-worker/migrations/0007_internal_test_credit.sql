ALTER TABLE customers ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0,1));
DROP TRIGGER ledger_apply;
DROP TRIGGER task_reserve;
DROP TRIGGER task_settle;
DROP TRIGGER task_release;
DROP TRIGGER recharge_credit;
DROP TRIGGER recharge_delete_guard;
CREATE TABLE ledger_new (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES customers(id),
 kind TEXT NOT NULL CHECK(kind IN ('recharge','hold','settle','release','refund','test_credit')),
 amount INTEGER NOT NULL CHECK(amount>=0), held_delta INTEGER NOT NULL, balance_delta INTEGER NOT NULL,
 reference_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
 UNIQUE(kind,reference_id)
);
INSERT INTO ledger_new SELECT * FROM ledger;
DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;
CREATE TRIGGER ledger_apply AFTER INSERT ON ledger BEGIN
 UPDATE customers SET balance=balance+NEW.balance_delta,held=held+NEW.held_delta WHERE id=NEW.user_id;
END;
CREATE TRIGGER task_reserve AFTER INSERT ON tasks BEGIN
 SELECT RAISE(ABORT,'CUSTOMER_DISABLED') WHERE (SELECT status FROM customers WHERE id=NEW.user_id)!='active';
 SELECT RAISE(ABORT,'CUSTOMER_CONCURRENCY') WHERE (SELECT COUNT(*) FROM tasks WHERE user_id=NEW.user_id AND state NOT IN ('succeeded','failed','cancelled'))>(SELECT max_concurrency FROM customers WHERE id=NEW.user_id);
 INSERT INTO ledger VALUES ('hold:'||NEW.id,NEW.user_id,'hold',NEW.reserved,NEW.reserved,0,NEW.id,'任务预冻结',NEW.created_at);
END;
CREATE TRIGGER task_settle AFTER UPDATE OF state ON tasks WHEN NEW.state='succeeded' AND OLD.state!='succeeded' BEGIN
 INSERT INTO ledger VALUES ('settle:'||NEW.id,NEW.user_id,'settle',NEW.charged,-NEW.reserved,-NEW.charged,NEW.id,'生成成功并已转存',NEW.updated_at);
 DELETE FROM key_leases WHERE task_id=NEW.id;
END;
CREATE TRIGGER task_release AFTER UPDATE OF state ON tasks WHEN NEW.state IN ('failed','cancelled') AND OLD.state NOT IN ('failed','cancelled') BEGIN
 INSERT INTO ledger VALUES ('release:'||NEW.id,NEW.user_id,'release',NEW.reserved,-NEW.reserved,0,NEW.id,'失败或取消，全额解冻',NEW.updated_at);
 DELETE FROM key_leases WHERE task_id=NEW.id;
END;
CREATE TRIGGER recharge_credit AFTER UPDATE OF state ON recharges WHEN NEW.state='approved' AND OLD.state='pending' BEGIN
 SELECT RAISE(ABORT,'PAYMENT_REFERENCE_REQUIRED') WHERE NEW.transaction_id IS NULL OR length(NEW.transaction_id)<6;
 INSERT INTO ledger VALUES ('recharge:'||NEW.id,NEW.user_id,'recharge',NEW.amount,0,NEW.amount,NEW.id,'支付宝人工核验到账',NEW.reviewed_at);
END;
CREATE TRIGGER recharge_delete_guard BEFORE DELETE ON recharges
WHEN OLD.state='approved'
 OR EXISTS(SELECT 1 FROM ledger WHERE reference_id=OLD.id)
 OR EXISTS(SELECT 1 FROM mail_outbox WHERE order_id=OLD.id)
BEGIN
 SELECT RAISE(ABORT,'CREDITED_RECHARGE_CANNOT_DELETE');
END;
CREATE TRIGGER test_credit_guard BEFORE INSERT ON ledger WHEN NEW.kind='test_credit' BEGIN
 SELECT RAISE(ABORT,'TEST_ACCOUNT_REQUIRED') WHERE NOT EXISTS(SELECT 1 FROM customers WHERE id=NEW.user_id AND is_test=1);
 SELECT RAISE(ABORT,'TEST_CREDIT_INVALID') WHERE NEW.amount!=22300000 OR NEW.balance_delta!=NEW.amount OR NEW.held_delta!=0;
 SELECT RAISE(ABORT,'TEST_CREDIT_ALREADY_ISSUED') WHERE EXISTS(SELECT 1 FROM ledger WHERE user_id=NEW.user_id AND kind='test_credit');
END;
CREATE TRIGGER test_recharge_guard BEFORE INSERT ON recharges
WHEN (SELECT is_test FROM customers WHERE id=NEW.user_id)=1 BEGIN
 SELECT RAISE(ABORT,'TEST_ACCOUNT_CANNOT_RECHARGE');
END;
