"""Offline browser QA. Replaces paid inference only, uses real local endpoints."""
import asyncio
import copy
import os
import sys
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
    if schema is Script:
        script=copy.deepcopy(SCRIPT)
        script['shots'][0]['end']=item['video']['duration']
        return Script.model_validate(script)
    return Draft(direction='离线测试：@图片1作为全程人物形象参考，@图片2作为场景环境参考。',shots=[{'start':0,'end':10,'content':'@图片1自然转身，展示服装；@视频1仅参考动作与镜头。'}])

Creative.ask=ask
directory=ROOT/'output'/'playwright'/'creative-qa'
app=studio.create_studio(directory=directory/'studio',output=directory/'results'/'智能成片')
uvicorn.run(app,host='127.0.0.1',port=8004)
