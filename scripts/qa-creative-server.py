"""Offline browser QA. Replaces paid inference only, uses real local endpoints."""
import asyncio
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'smart-video-agent'))
import studio
from creative import Creative, Script, Draft
from test_creative import SCRIPT
import uvicorn

studio.configured_keys=lambda:{'MODEL_AGENT_API_KEY':'offline-fixture','SANBAO_API_KEY':''}
os.environ['HAMSTER_ASSET_API']='http://127.0.0.1:8788/api/assets'

async def ask(self,item,text,schema,**kwargs):
    await asyncio.sleep(.3)
    if os.getenv('HAMSTER_QA_MODALITY_ERRORS') == '1':
        item['step']='inference'
        error=RuntimeError('private raw provider message')
        error.status_code=400
        error.body={'code':'InvalidParameter','param':'input.content','message':'content type is not supported'}
        error.request_id='20260915OfflineTrace123'
        raise error
    if schema is Script:
        script=copy.deepcopy(SCRIPT)
        script['shots'][0]['end']=item['video']['duration']
        script['shots'][0].update(start=3,end=999,characters=['C404'],scene='S404',dialogue_source='音轨')
        item['analysis_text']=json.dumps(script,ensure_ascii=False)+'\n<script>window.untrustedExecuted=true</script>'
        self.save(item)
        return Script.model_validate(script)
    return Draft(shots=[{'start':0,'end':10,'content':'在@图片2的场景中，@图片1自然转身，抬手示意，镜头缓慢推近，字幕“你好”。'}])

Creative.ask=ask
async def upload_object(self,data,mime,name,ttl=None):
    return 'https://media.example/'+name
Creative.upload_object=upload_object
qa_temp=tempfile.TemporaryDirectory(prefix='creative-qa-',dir=ROOT/'output'/'playwright')
directory=Path(qa_temp.name)
app=studio.create_studio(directory=directory/'studio',output=directory/'results'/'智能成片')
uvicorn.run(app,host='127.0.0.1',port=8004)
