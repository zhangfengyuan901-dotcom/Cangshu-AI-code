#!/bin/bash
# Fresh-target restore only; does not attach the public tunnel.
set -euo pipefail
umask 077
cd /opt/piknoai-relay
test "$(id -u)" = 0
echo 'd3a5f28e34e02aea0ed0c773c297ea7a309dc26bb49ab42d26940790b6711fef  cutover-20261003-032749.tar.gz' | sha256sum --check
test ! -e current
test -z "$(docker volume ls -q --filter name=piknoai-relay_)"
mkdir -m 0700 current
tar -xzf cutover-20261003-032749.tar.gz -C current --no-same-owner --no-same-permissions
chmod 0600 cutover-20261003-032749.tar.gz
cd current
chmod 0600 .env postgres.dump newapi-data.tar.gz
chmod 0700 private
chmod 0600 private/*
# The pinned cloudflared image runs as 65532:65532. Compose file-backed
# secrets retain host ownership on Linux, so grant only that process read access.
chown 65532:65532 private/tunnel-token.txt
chmod 0400 private/tunnel-token.txt
python3 - <<'PY'
import json, hashlib
from pathlib import Path
m=json.loads(Path('manifest.json').read_text())
assert m['kind']=='frozen-cutover-snapshot'
for f in m['files']:
    p=Path(f['file'])
    assert not p.is_absolute() and '..' not in p.parts
    b=p.read_bytes()
    assert len(b)==f['bytes'] and hashlib.sha256(b).hexdigest()==f['sha256'], str(p)
print('PIKNO_MANIFEST_VERIFIED')
PY
dc=(docker compose -f compose.yaml -f compose.ecs.yaml)
"${dc[@]}" config -q
"${dc[@]}" up -d --wait postgres redis
"${dc[@]}" exec -T postgres pg_restore -U pikno -d newapi --exit-on-error --no-owner < postgres.dump
"${dc[@]}" run --rm --no-deps -T --entrypoint tar new-api xzf - -C /data < newapi-data.tar.gz
"${dc[@]}" up -d --wait new-api
"${dc[@]}" exec -T postgres psql -U pikno -d newapi -Atc "SELECT 'users',count(*) FROM users UNION ALL SELECT 'channels',count(*) FROM channels UNION ALL SELECT 'options',count(*) FROM options UNION ALL SELECT 'logs',count(*) FROM logs UNION ALL SELECT 'tasks',count(*) FROM tasks;"
curl -fsS http://127.0.0.1:3100/api/status | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ["success"]}); print({k:d.get("data",{}).get(k) for k in ["version","setup","system_name"]}); assert d.get("success")'
"${dc[@]}" ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}'
echo PIKNO_ECS_RESTORE_OK
