"""Guarded brand.16 -> brand.18 update; never rewrites or restores live money."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path('/opt/piknoai-relay/current')
BACKUP = ROOT / '.deploy-backups/client18-20261009'
PG = 'piknoai-relay-postgres-1'
APP = 'piknoai-relay-new-api-1'
IMAGE = 'pikno-new-api:v1.0.0-rc.41-brand.18'

def run(*args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('Command failed (sensitive output withheld): ' + args[0])
    return result.stdout.decode().strip()

def sql(query):
    return run('docker', 'exec', '-i', PG, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'pikno', '-d', 'newapi', '-At', data=query.encode())

def snapshot():
    queries = {
        'wallets': 'SELECT id,quota,used_quota,request_count FROM users ORDER BY id',
        'tokens': 'SELECT id,user_id,remain_quota,used_quota FROM tokens ORDER BY id',
        'channels': 'SELECT id,status,used_quota FROM channels ORDER BY id',
        'topups': 'SELECT * FROM top_ups ORDER BY id',
        'tasks': 'SELECT task_id,status,quota FROM tasks ORDER BY id',
        'settlements': 'SELECT * FROM pikno_settlements ORDER BY id',
        'ledger': 'SELECT * FROM pikno_settlement_events ORDER BY id',
        'options': 'SELECT * FROM options ORDER BY key',
    }
    return {name: sql("SELECT md5(coalesce(json_agg(t)::text,'[]')) FROM (" + query + ') t') for name, query in queries.items()}

def main():
    os.umask(0o077)
    os.chdir(ROOT)
    assert len(sys.argv) == 3, 'archive path and sha256 required'
    archive = Path(sys.argv[1]).resolve()
    assert archive.parent == Path('/opt/piknoai-relay') and archive.name == 'pikno-client18-image.tar'
    assert hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() == sys.argv[2]
    assert run('docker', 'inspect', '--format', '{{.Config.Image}}', APP) == 'pikno-new-api:v1.0.0-rc.41-brand.16'
    assert not BACKUP.exists(), 'Backup exists: inspect previous attempt before retry'
    assert sql('SELECT count(*) FROM channels WHERE status=1') == '0', 'Channels must remain closed during release'
    assert sql("SELECT count(*) FROM tasks WHERE status NOT IN ('SUCCESS','FAILURE')") == '0', 'Active tasks: defer release'
    assert sql("SELECT count(*) FROM pikno_settlements WHERE settled_outcome='' OR reserved_quota<>0") == '0', 'Unsettled managed orders: defer release'
    assert sql("SELECT count(*) FROM top_ups WHERE status='pending' AND create_time > extract(epoch from now())-600") == '0', 'Recent recharge: defer release'
    env = dict(value.split('=',1) for value in json.loads(run('docker','inspect',APP))[0]['Config']['Env'])
    assert env.get('PIKNO_SETTLEMENT_ENABLED') == 'true' and not env.get('REDIS_CONN_STRING')
    assert env.get('BATCH_UPDATE_ENABLED') == 'false' and env.get('MEMORY_CACHE_ENABLED') == 'false'
    run('docker','load','--input',str(archive))
    BACKUP.mkdir(mode=0o700, parents=True)
    for name in ['compose.yaml','compose.ecs.yaml','compose.payments.yaml','compose.tunnel.yaml','.env']:
        shutil.copy2(ROOT/name, BACKUP/name)
    with (BACKUP/'before.dump').open('wb') as output:
        subprocess.run(['docker','exec',PG,'pg_dump','-U','pikno','-d','newapi','-Fc'], stdout=output, check=True)
    run('docker','exec','-i',PG,'pg_restore','--list',data=(BACKUP/'before.dump').read_bytes())
    before = snapshot()
    (BACKUP/'before.json').write_text(json.dumps(before))
    config = ROOT/'compose.yaml'
    text = config.read_text()
    old = 'image: pikno-new-api:v1.0.0-rc.41-brand.16'
    assert text.count(old) == 1
    config.write_text(text.replace(old,'image: '+IMAGE))
    compose = ['docker','compose','-f','compose.yaml','-f','compose.ecs.yaml','-f','compose.payments.yaml','-f','compose.tunnel.yaml']
    run(*compose,'config','--quiet')
    print('BACKUP_VERIFIED_UPDATING_APP_ONLY', flush=True)
    run(*compose,'up','-d','--no-deps','--no-build','--wait','--wait-timeout','150','new-api')
    status = json.loads(run('docker','exec',APP,'wget','-q','-O','-','http://127.0.0.1:3000/api/status'))
    assert status['success'] and status['data']['version'] == 'v1.0.0-rc.41-pikno.18'
    after = snapshot()
    (BACKUP/'after.json').write_text(json.dumps(after))
    assert before == after, 'Data changed during release: investigate; never restore old financial data automatically'
    result = {'version':status['data']['version'],'existing_financial_data_unchanged':True,'options_unchanged':True,'channels_remain_closed':True}
    (BACKUP/'release-ok.json').write_text(json.dumps(result))
    print(json.dumps(result), flush=True)

if __name__ == '__main__':
    main()
