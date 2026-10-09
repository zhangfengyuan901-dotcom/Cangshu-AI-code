"""Guarded one-time production cutover. Never restores a financial backup."""
import json
import os
import re
import subprocess
from preflight_settlement16 import ROOT, BACKUP, PG, IMAGE, run, sql, snapshot, verify_idle

def compose(*args):
    return run('docker','compose','-f','compose.yaml','-f','compose.ecs.yaml',
        '-f','compose.payments.yaml','-f','compose.tunnel.yaml',*args)

def main():
    os.umask(0o077)
    os.chdir(ROOT)
    assert (BACKUP/'preflight-ok.json').exists(), 'Migration rehearsal required'
    assert not (BACKUP/'cutover-before.json').exists(), 'Cutover already attempted; inspect first'
    verify_idle()
    assert sql("SELECT count(*) FROM top_ups WHERE status='pending' AND create_time > extract(epoch from now())-600")=='0', 'Recent unpaid topup; wait before restart'
    options=sql("SELECT md5(string_agg(row_to_json(o)::text,chr(10) ORDER BY key)) FROM options o")
    before=snapshot()
    (BACKUP/'cutover-before.json').write_text(json.dumps(before))
    with (BACKUP/'cutover.dump').open('wb') as out:
        subprocess.run(['docker','exec',PG,'pg_dump','-U','pikno','-d','newapi','-Fc'],stdout=out,check=True)
    config=ROOT/'compose.yaml'
    text=config.read_text()
    old='image: pikno-new-api:v1.0.0-rc.41-brand.12'
    assert text.count(old)==1
    text=text.replace(old,'image: '+IMAGE)
    for key,value in {'REDIS_CONN_STRING':'','BATCH_UPDATE_ENABLED':'false','MEMORY_CACHE_ENABLED':'false',
                      'PIKNO_SETTLEMENT_ENABLED':'true','PIKNO_SETTLEMENT_ORIGIN':'https://www.piknoai.com'}.items():
        pattern=r'^      '+key+r':.*$'
        if re.search(pattern,text,re.M):
            text,count=re.subn(pattern,'      '+key+': '+json.dumps(value),text,flags=re.M)
            assert count==1
        else:
            anchor='      NODE_NAME:'
            assert text.count(anchor)==1
            text=text.replace(anchor,'      '+key+': '+json.dumps(value)+'\n'+anchor)
    config.write_text(text)
    compose('config','--quiet')
    print('CUTOVER_START_CHANNELS_REMAIN_CLOSED',flush=True)
    compose('up','-d','--no-deps','--no-build','--wait','--wait-timeout','150','new-api')
    status=json.loads(run('docker','exec','piknoai-relay-new-api-1','wget','-q','-O','-','http://127.0.0.1:3000/api/status'))
    assert status['success'] and status['data']['version']=='v1.0.0-rc.41-pikno.16'
    after=snapshot()
    (BACKUP/'cutover-after.json').write_text(json.dumps(after))
    assert before==after, 'Existing accounting changed: investigate; never restore an old financial backup automatically'
    assert options==sql("SELECT md5(string_agg(row_to_json(o)::text,chr(10) ORDER BY key)) FROM options o"), 'Options changed'
    assert sql('SELECT count(*) FROM pikno_settlements')=='0'
    env=dict(v.split('=',1) for v in json.loads(run('docker','inspect','piknoai-relay-new-api-1'))[0]['Config']['Env'])
    assert not env.get('REDIS_CONN_STRING') and env['BATCH_UPDATE_ENABLED']=='false'
    smtp=sql("SELECT count(*) FROM options WHERE (key='SMTPServer' AND value='smtp.resend.com') OR (key IN ('SMTPToken','SMTPFrom') AND length(value)>0)")
    result={'version':status['data']['version'],'existing_money_unchanged':True,'existing_options_unchanged':True,
            'new_order_count':0,'all_channels_closed':True,'resend_options_present':smtp=='3'}
    (BACKUP/'cutover-ok.json').write_text(json.dumps(result))
    print(json.dumps(result),flush=True)

if __name__=='__main__': main()
