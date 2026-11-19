ALTER TABLE recharges ADD COLUMN payment_reported_at INTEGER;
ALTER TABLE recharges ADD COLUMN received_at INTEGER;
CREATE TRIGGER recharge_delete_guard BEFORE DELETE ON recharges
WHEN OLD.state='approved'
 OR EXISTS(SELECT 1 FROM ledger WHERE reference_id=OLD.id)
 OR EXISTS(SELECT 1 FROM mail_outbox WHERE order_id=OLD.id)
BEGIN
 SELECT RAISE(ABORT,'CREDITED_RECHARGE_CANNOT_DELETE');
END;
CREATE INDEX recharge_review_queue ON recharges(payment_reported_at) WHERE state='pending' AND payment_reported=1;
INSERT INTO audit(id,actor,action,target,detail,created_at)
SELECT 'purge-rejected:'||id,'migration','recharge.deleted',id,'{"reason":"清理历史未入账驳回申请"}',CAST(strftime('%s','now') AS INTEGER)*1000
FROM recharges WHERE state='rejected'
 AND NOT EXISTS(SELECT 1 FROM ledger WHERE reference_id=recharges.id)
 AND NOT EXISTS(SELECT 1 FROM mail_outbox WHERE order_id=recharges.id);
DELETE FROM recharges WHERE state='rejected'
 AND NOT EXISTS(SELECT 1 FROM ledger WHERE reference_id=recharges.id)
 AND NOT EXISTS(SELECT 1 FROM mail_outbox WHERE order_id=recharges.id);
