PRAGMA defer_foreign_keys = ON;
DROP TRIGGER task_reserve;
DROP TRIGGER lease_capacity;
DROP TRIGGER task_terminal_guard;
DROP TRIGGER task_settle;
DROP TRIGGER task_release;
DROP TRIGGER generation_done;
CREATE TABLE tasks_new (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES customers(id), api_key_id TEXT NOT NULL REFERENCES api_keys(id),
 request_id TEXT NOT NULL, request_hash TEXT NOT NULL, model_id TEXT NOT NULL REFERENCES models(id), provider TEXT NOT NULL, kind TEXT NOT NULL,
 payload_json TEXT NOT NULL, quote_json TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>=0),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','preparing','submitting','processing','unknown','transferring','succeeded','failed','cancelled')),
 upstream_id TEXT, upstream_url TEXT, provider_key_id TEXT REFERENCES provider_keys(id), result_key TEXT,
 charged INTEGER NOT NULL DEFAULT 0 CHECK(charged>=0 AND charged<=reserved), progress REAL,
 error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(user_id,request_id), UNIQUE(provider_key_id,upstream_id)
);
INSERT INTO tasks_new SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE TABLE provider_accounts_new (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('backup','main','image','tool')),
 name TEXT NOT NULL, max_concurrency INTEGER NOT NULL DEFAULT 100 CHECK(max_concurrency BETWEEN 1 AND 1000)
);
INSERT INTO provider_accounts_new SELECT * FROM provider_accounts;
DROP TABLE provider_accounts;
ALTER TABLE provider_accounts_new RENAME TO provider_accounts;
CREATE INDEX tasks_work ON tasks(state,updated_at);
CREATE INDEX tasks_user ON tasks(user_id,created_at);
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
UPDATE models SET provider='main',fixed_sale=100000,enabled=1,version=version+1 WHERE kind='image';
INSERT INTO models (id,provider,kind,name,billing,cost_rate,fixed_sale,spec_json,enabled,visible,updated_at) VALUES ('tool-digital','tool','video','数字人','fixed',0,5000000,'{"tool":"digital","free":false,"max_images":1,"max_audios":1,"max_videos":0,"max_media_files":2}',1,1,0);
INSERT INTO models (id,provider,kind,name,billing,cost_rate,fixed_sale,spec_json,enabled,visible,updated_at) VALUES ('tool-depth','tool','video','黑白深度','fixed',0,0,'{"tool":"depth","free":true,"max_images":0,"max_audios":0,"max_videos":1,"max_media_files":1}',1,1,0);
INSERT INTO provider_accounts VALUES ('default-main','main','主线路 · 图片与视频',100);
INSERT INTO provider_accounts VALUES ('default-backup','backup','官方备选线路',100);
INSERT INTO provider_accounts VALUES ('default-tool','tool','仓鼠工具服务',100);
PRAGMA defer_foreign_keys = OFF;

