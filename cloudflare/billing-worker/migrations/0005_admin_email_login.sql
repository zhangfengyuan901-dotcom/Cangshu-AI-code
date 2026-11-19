CREATE TABLE admin_challenges (
 id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, consumed_at INTEGER
);
CREATE INDEX admin_challenges_email ON admin_challenges(email,expires_at);
CREATE TABLE admin_sessions (
 token_hash TEXT PRIMARY KEY, email TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
