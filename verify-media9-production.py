"""Short-lived non-generating smoke test; run over SSH on the owned ECS."""
import json, secrets, subprocess, time, urllib.request, urllib.error

def sql(statement):
    run = subprocess.run(['docker','exec','-i','piknoai-relay-postgres-1','psql','-U','pikno','-d','newapi','-At','-v','ON_ERROR_STOP=1'], input=statement, text=True, capture_output=True)
    if run.returncode: raise RuntimeError('Database test operation failed')
    return run.stdout.strip()

def request(path, body=None, key=None, content_type='application/json'):
    data = None if body is None else (body.encode() if isinstance(body,str) else json.dumps(body).encode())
    headers = {'Content-Type':content_type}
    if key: headers['Authorization']='Bearer sk-'+key
    req=urllib.request.Request('http://127.0.0.1:3100'+path,data=data,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=20) as r:return r.status,json.loads(r.read())
    except urllib.error.HTTPError as e:
        try: body=json.loads(e.read())
        except ValueError: body={}
        return e.code,body

key=secrets.token_hex(24);now=int(time.time());expires=now+40
sql(f"DELETE FROM tokens WHERE name='media9-production-smoke' AND expired_time<{now};")
token_id=sql(f'''INSERT INTO tokens(user_id,key,status,name,created_time,accessed_time,expired_time,remain_quota,unlimited_quota,model_limits_enabled,model_limits,allow_ips,used_quota,"group",cross_group_retry,auto_groups)
VALUES(1,'{key}',1,'media9-production-smoke',{now},{now},{expires},1,false,true,'media-smoke-no-generation','',0,'default',false,'') RETURNING id;''').splitlines()[0]
assert token_id.isdigit()
result={}
try:
    code,body=request('/api/status');assert code==200;result['version']=body['data']['version'];assert result['version'].endswith('pikno.9')
    before=sql('SELECT quota FROM users WHERE id=1;')
    code,_=request('/v1/videos',{'model':'sanbao/sd2_480p_real','image_urls':['https://example.com/test.png']},key);result['foreign_url']=code;assert code==403
    code,_=request('/v1/images/edits','test',key,'multipart/form-data; boundary=test');result['multipart']=code;assert code==415
    code,_=request('/v1/images/generations',{'model':'gpt-image-2.5-flare','prompt':'test','n':2},key);result['invalid_quantity']=code;assert code==400
    code,_=request('/v1/media/uploads',{'content_type':'image/png','size':68},key);result['upload_ticket']=code;assert code==201
    assert sql('SELECT quota FROM users WHERE id=1;')==before;result['no_charge']=True
    result['channel_statuses']=sql('SELECT id,status FROM channels ORDER BY id;').splitlines();assert all(row.endswith('|2') for row in result['channel_statuses'])
finally:
    # Expiry is also enforced on cached tokens; wait for it before removing the row.
    time.sleep(max(0,expires-int(time.time())+2))
    try:
        code,_=request('/v1/media/uploads',{'content_type':'image/png','size':68},key);result['expired_token']=code
    finally: sql(f'DELETE FROM tokens WHERE id={token_id} AND key=\'{key}\';')
    result['temporary_token_removed']=sql(f'SELECT count(*) FROM tokens WHERE id={token_id};')=='0'
    print(json.dumps(result))
