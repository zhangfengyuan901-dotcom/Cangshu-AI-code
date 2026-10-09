"""ECS-only preflight and isolated migration rehearsal. No live wallet writes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/opt/piknoai-relay/current')
BACKUP = ROOT / '.deploy-backups/settlement16-20261009'
PG = 'piknoai-relay-postgres-1'
IMAGE = 'pikno-new-api:v1.0.0-rc.41-brand.16'
ARCHIVE = Path('/opt/piknoai-relay/pikno-client16-image.tar')
EXPECTED = 'efd3d22c58cf77f0f7709fe01478fd54c36ca5b4655e5def6ed565a48839e409'

def run(*args, data=None):
    r = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode:
        raise RuntimeError('Command failed: ' + args[0] + ' / ' + args[1] + ' (sensitive output withheld)')
    return r.stdout.decode().strip()

def sql(query, pg=PG):
    return run('docker', 'exec', '-i', pg, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'pikno', '-d', 'newapi', '-At', data=query.encode())

def snapshot(pg=PG):
    return {name:sql("SELECT coalesce(json_agg(t),'[]'::json) FROM ("+query+") t", pg) for name,query in {
        'wallets':'SELECT id,quota,used_quota,request_count FROM users ORDER BY id',
        'tokens':'SELECT id,user_id,remain_quota,used_quota FROM tokens ORDER BY id',
        'channels':'SELECT id,status,used_quota FROM channels ORDER BY id',
        'topups':'SELECT * FROM top_ups ORDER BY id',
        'tasks':'SELECT task_id,status,quota FROM tasks ORDER BY id',
    }.items()}

def verify_idle():
    assert sql("SELECT count(*) FROM channels WHERE status=1") == '0', 'Enabled channels must be drained first'
    assert sql("SELECT count(*) FROM tasks WHERE status NOT IN ('SUCCESS','FAILURE')") == '0', 'Tasks in flight'

def main():
    os.umask(0o077)
    assert ROOT.is_dir()
    assert not BACKUP.exists(), 'Preflight backup already exists; inspect instead of overwriting'
    config=json.loads(run('docker','inspect','piknoai-relay-new-api-1'))[0]
    assert config['Config']['Image']=='pikno-new-api:v1.0.0-rc.41-brand.12'
    env=dict(item.split('=',1) for item in config['Config']['Env'])
    verify_idle()
    # No generations can enter with all channels disabled. Allow batch writers
    # more than two normal flush periods, then check cached and durable money.
    delay=2*int(env.get('BATCH_UPDATE_INTERVAL','5'))+2
    assert delay<=45
    time.sleep(delay)
    verify_idle()
    wallets=json.loads(snapshot()['wallets'])
    for user in wallets:
        cached=run('docker','exec','piknoai-relay-redis-1','sh','-c',
                   'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw HGET "$1" Quota','sh','user:'+str(user['id']))
        assert not cached or int(cached)==user['quota'], 'User cache differs from SQL; abort'
    print(json.dumps({'channels_closed':True,'tasks_in_flight':0,'cached_user_balances_match':True,
        'batch_enabled':env.get('BATCH_UPDATE_ENABLED'), 'redis_enabled':bool(env.get('REDIS_CONN_STRING'))}),flush=True)
    assert hashlib.file_digest(ARCHIVE.open('rb'),'sha256').hexdigest()==EXPECTED
    run('docker','load','--input',str(ARCHIVE))
    BACKUP.mkdir(mode=0o700,parents=True)
    for name in ['compose.yaml','compose.ecs.yaml','compose.payments.yaml','compose.tunnel.yaml','.env']:
        run('cp','--preserve=mode',str(ROOT/name),str(BACKUP/name))
    with (BACKUP/'newapi.dump').open('wb') as f:
        subprocess.run(['docker','exec',PG,'pg_dump','-U','pikno','-d','newapi','-Fc'],stdout=f,check=True)
    run('docker','exec','-i',PG,'pg_restore','--list',data=(BACKUP/'newapi.dump').read_bytes())
    before=snapshot()
    (BACKUP/'before.json').write_text(json.dumps(before))
    (BACKUP/'runtime-env.json').write_text(json.dumps(env))
    print('BACKUP_VERIFIED',flush=True)
    rehearse()

def rehearse():
    os.umask(0o077)
    assert (BACKUP/'newapi.dump').is_file()
    try: run('docker','network','inspect','pikno-settlement16-rehearsal')
    except RuntimeError: run('docker','network','create','--internal','pikno-settlement16-rehearsal')
    pg_image=run('docker','inspect',PG,'--format','{{.Image}}')
    run('docker','run','-d','--name','pikno-settlement16-rehearsal-pg','--network','pikno-settlement16-rehearsal',
        '--memory','384m','--cpus','0.5','-e','POSTGRES_USER=pikno','-e','POSTGRES_DB=newapi',
        '-e','POSTGRES_HOST_AUTH_METHOD=trust','--pull','never',pg_image)
    stagepg='pikno-settlement16-rehearsal-pg'
    for _ in range(30):
        try:
            run('docker','exec',stagepg,'pg_isready','-U','pikno');break
        except RuntimeError: time.sleep(1)
    run('docker','exec','-i',stagepg,'pg_restore','-U','pikno','-d','newapi','--no-owner','--exit-on-error',data=(BACKUP/'newapi.dump').read_bytes())
    # Sanitize credentials in the isolated copy. No outbound internet and no
    # public ports; still do not run copied supplier credentials in rehearsal.
    sql("UPDATE channels SET key=''; UPDATE tokens SET key='rehearsal-'||id; UPDATE users SET password='disabled',email=''; DELETE FROM options WHERE lower(key) LIKE '%smtp%' OR lower(key) LIKE '%secret%' OR lower(key) LIKE '%password%';",stagepg)
    stage_before=snapshot(stagepg)
    run('docker','run','-d','--name','pikno-settlement16-rehearsal-app','--network','pikno-settlement16-rehearsal',
        '--memory','768m','--cpus','0.5','-e','SQL_DSN=postgresql://pikno@pikno-settlement16-rehearsal-pg:5432/newapi?sslmode=disable',
        '-e','PIKNO_SETTLEMENT_ENABLED=true','-e','BATCH_UPDATE_ENABLED=false','-e','MEMORY_CACHE_ENABLED=false',
        '-e','SESSION_SECRET='+os.urandom(32).hex(), IMAGE)
    ready=False
    for _ in range(90):
        try:
            status=json.loads(run('docker','exec','pikno-settlement16-rehearsal-app','wget','-q','-O','-','http://127.0.0.1:3000/api/status'))
            if status.get('success'): ready=True;break
        except (RuntimeError,ValueError): pass
        time.sleep(1)
    assert ready, 'Rehearsal startup failed'
    assert stage_before==snapshot(stagepg), 'Migration changed existing money or orders'
    assert sql('SELECT count(*) FROM pikno_settlements',stagepg)=='0'
    (BACKUP/'preflight-ok.json').write_text(json.dumps({'rehearsal':True,'existing_money_unchanged':True,'image':IMAGE}))
    run('docker','stop','pikno-settlement16-rehearsal-app',stagepg)
    print('REHEARSAL_PASSED_EXISTING_MONEY_UNCHANGED',flush=True)

if __name__=='__main__':
    if sys.argv[1:]==['--resume-rehearsal']: rehearse()
    else: main()
