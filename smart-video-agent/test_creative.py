import asyncio
import copy
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError
from creative import Creative, Script, Draft, Adapt, inspect_video, failure_details
from studio import create_studio

SCRIPT = dict(summary='模特展示服装', characters=[dict(id='C1',name='模特',appearance='白色外套')], relationships=[],
              scenes=[dict(id='S1',description='室内')], shots=[dict(start=0,end=1,characters=['C1'],scene='S1',action='转身',emotion='愉快',camera='全景',dialogue='',dialogue_source='无对白',plot='展示服装')],uncertainties=['时间点需要核对'])


class CreativeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.c=Creative(self.root/'data',self.root/'output',lambda:{'MODEL_AGENT_API_KEY':'test-only'})
        buffer=io.BytesIO();Image.new('RGB',(8,8)).save(buffer,format='PNG')
        self.image=await self.c.store_media(buffer.getvalue(),'image/png','模特.png')
        self.video=await self.c.store_media(b'\0\0\0\x18ftypisom'+b'0'*24,'video/mp4','原片.mp4')
        self.item=dict(id='a'*32,source=self.video['id'],name='原片.mp4',script=SCRIPT,video={'duration':1,'has_audio':False},status='success',result=None)

    async def asyncTearDown(self):
        for task in self.c.tasks.values():task.cancel()
        await asyncio.gather(*self.c.tasks.values(),return_exceptions=True)
        self.temp.cleanup()

    def test_script_rejects_unknown_ids_and_overlaps(self):
        for field,value in [('scene','S9'),('characters',['C99']),('end',0)]:
            bad=copy.deepcopy(SCRIPT);bad['shots'][0][field]=value
            with self.assertRaises(ValidationError):Script.model_validate(bad)
        bad=copy.deepcopy(SCRIPT);bad['shots']*=2
        with self.assertRaises(ValidationError):Script.model_validate(bad)

    async def test_legacy_audio_flag_never_adds_audio_input(self):
        self.item['include_audio']=True
        self.c.ask=AsyncMock(return_value=Script.model_validate(SCRIPT))
        with patch('creative.inspect_video',return_value={'duration':1,'has_audio':True}):
            await self.c.analyze(self.item)
        args=self.c.ask.call_args.kwargs['files']
        self.assertEqual([x[0] for x in args],['video'])
        bad=copy.deepcopy(SCRIPT);bad['shots'][0]['dialogue_source']='音轨'
        self.c.ask.return_value=Script.model_validate(bad)
        with patch('creative.inspect_video',return_value={'duration':1,'has_audio':False}):
            with self.assertRaises(ValueError):await self.c.analyze(self.item)

    async def test_adaptation_images_tags_timeline_and_local_export(self):
        self.c.ask=AsyncMock(return_value=Draft(direction='@图片1作为人物参考',shots=[{'start':0,'end':10,'content':'@图片1转身，@视频1参考动作'}]))
        brief=Adapt(script=Script.model_validate(SCRIPT),bindings=[{'target':'C1','media':self.image['id']}])
        await self.c.adapt(self.item,brief)
        self.assertEqual(self.c.ask.call_args.kwargs['images'][0][0],'@图片1')
        self.assertIn('@视频1',self.item['result']['prompt'])
        self.assertTrue((self.c.output/self.item['result']['file']).is_file())
        self.c.ask.return_value=Draft(direction='@图片9不存在',shots=[{'start':0,'end':10,'content':'走动'}])
        with self.assertRaises(ValueError):await self.c.adapt(self.item,brief)
        self.assertIsNone(self.item['result'])
        brief.reference_motion=False
        self.c.ask.return_value=Draft(direction='@图片1作为人物参考',shots=[{'start':0,'end':10,'content':'走动'}])
        await self.c.adapt(self.item,brief)
        self.assertNotIn('@视频1',self.item['result']['prompt'])

    async def test_visual_mode_is_explicit_and_does_not_claim_audio(self):
        self.item['include_audio']=False
        self.c.ask=AsyncMock(return_value=Script.model_validate(SCRIPT))
        with patch('creative.inspect_video',return_value={'duration':1,'has_audio':True}):
            await self.c.analyze(self.item)
        self.assertEqual([x[0] for x in self.c.ask.call_args.kwargs['files']],['video'])
        self.assertFalse(self.item['audio_analyzed'])
        self.assertTrue(self.item['video']['has_audio'])
        self.assertIn('未提供独立音轨',self.c.ask.call_args.args[1])
        self.assertIn('未识别音轨',self.item['script']['uncertainties'][0])
        bad=copy.deepcopy(SCRIPT);bad['shots'][0]['dialogue_source']='音轨'
        self.c.ask=AsyncMock(return_value=Script.model_validate(bad))
        with patch('creative.inspect_video',return_value={'duration':1,'has_audio':True}):
            with self.assertRaises(ValueError): await self.c.analyze(self.item)

    async def test_real_sdk_request_shape_and_remote_cleanup(self):
        client=NS(files=NS(create=AsyncMock(return_value=NS(id='file-test')),wait_for_processing=AsyncMock(return_value=NS(status='active')),delete=AsyncMock()),
                  responses=NS(create=AsyncMock(return_value=NS(status='completed',usage=None,output=[NS(type='message',content=[NS(type='output_text',text=json.dumps(SCRIPT))])]))),close=AsyncMock())
        with patch('volcenginesdkarkruntime.AsyncArk',return_value=client):
            result=await self.c.ask(self.item,'analyze',Script,files=[('video',self.c.media(self.video['id'])[1])],images=[('@图片1',*self.c.media(self.image['id']))])
        self.assertEqual(result.summary,SCRIPT['summary'])
        payload=client.responses.create.call_args.kwargs
        self.assertFalse(payload['store'])
        self.assertEqual(payload['model'],'doubao-seed-2-0-lite-260428')
        self.assertEqual(payload['input'][0]['content'][0],{'type':'input_video','file_id':'file-test'})
        self.assertTrue(payload['input'][0]['content'][2]['image_url'].startswith('data:image/png;base64,'))
        client.files.delete.assert_awaited_once_with('file-test')

    async def test_failure_redacts_secrets_and_cancel_recovers(self):
        async def fail():raise RuntimeError('test-only RunningHub private-url')
        self.c.start(self.item,fail);await self.c.tasks[self.item['id']]
        self.assertEqual(self.item['status'],'failed')
        self.assertNotIn('test-only',self.item['error'])
        self.c.start(self.item,lambda:asyncio.sleep(60));await asyncio.sleep(0)
        task=self.c.tasks[self.item['id']];task.cancel();await task
        self.assertEqual(self.item['status'],'cancelled')
        self.item['status']='running';self.c.save(self.item)
        restored=Creative(self.c.directory,self.c.output,self.c.keys)
        self.assertEqual(restored.get(self.item['id'])['status'],'interrupted')
        self.assertEqual(len(restored.items),1)

    async def test_endpoint_override_and_model_not_open_persist_safe_details(self):
        self.c.keys=lambda:{'MODEL_AGENT_API_KEY':'test-only','LLM_ENDPOINT_ID':'ep-test-endpoint'}
        error=RuntimeError('private credentials and raw provider payload')
        error.status_code=404
        error.body={'error':{'code':'ModelNotOpen','message':'account 123 private provider model'}}
        error.request_id='20260915opaqueRequest123'
        client=NS(files=NS(delete=AsyncMock()),responses=NS(create=AsyncMock(side_effect=error)),close=AsyncMock())
        with patch('volcenginesdkarkruntime.AsyncArk',return_value=client):
            self.c.start(self.item,lambda:self.c.ask(self.item,'analyze',Script))
            await self.c.tasks[self.item['id']]
        self.assertEqual(client.responses.create.call_args.kwargs['model'],'ep-test-endpoint')
        failure=self.item['failure']
        self.assertEqual(failure['code'],'MODEL_NOT_ENABLED')
        self.assertEqual(failure['step'],'请求智能分析')
        self.assertEqual(failure['http_status'],404)
        self.assertEqual(failure['request_id'],'20260915opaqueRequest123')
        stored=(self.c.directory/(self.item['id']+'.json')).read_text(encoding='utf-8')
        for secret in ('test-only','private','provider','account 123','ep-test-endpoint'):
            self.assertNotIn(secret,stored)
        recovered=Creative(self.c.directory,self.c.output,self.c.keys)
        self.assertEqual(recovered.get(self.item['id'])['failure'],failure)

    def test_error_categories_and_untrusted_diagnostic_fields(self):
        for status,code,expected in [(404,'ModelNotOpen','MODEL_NOT_ENABLED'),(401,None,'AUTH_FAILED'),
                                    (403,None,'PERMISSION_DENIED'),(404,None,'RESOURCE_NOT_FOUND'),
                                    (429,None,'RATE_OR_QUOTA_LIMIT'),(500,None,'SERVICE_UNAVAILABLE')]:
            error=RuntimeError('secret')
            error.status_code=status;error.body={'code':code};error.request_id='secret https://private'
            result=failure_details(error,'upload_video')
            self.assertEqual(result['code'],expected)
            self.assertEqual(result['request_id'],'')
            self.assertNotIn('secret',json.dumps(result))
        error=RuntimeError()
        error.body={'code':'InvalidParameter','param':'input.content','message':'content type is not supported'}
        error.status_code=400
        self.assertEqual(failure_details(error,'inference')['code'],'CONTENT_TYPE_UNSUPPORTED')

    async def test_immediate_cancel_does_not_leave_running_job(self):
        operation=AsyncMock()
        self.c.start(self.item,operation)
        task=self.c.tasks[self.item['id']];task.cancel()
        await asyncio.gather(task,return_exceptions=True)
        self.assertEqual(self.item['status'],'cancelled')
        operation.assert_not_awaited()


class CreativeHttpTests(unittest.TestCase):
    def test_local_ui_configuration_media_and_script(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with patch('studio.configured_keys',return_value={'MODEL_AGENT_API_KEY':'','SANBAO_API_KEY':''}):
                app=create_studio(directory=root/'studio',output=root/'results'/'智能成片')
                with TestClient(app) as client:
                    self.assertEqual(client.get('/creative/').status_code,200)
                    self.assertTrue(client.get('/studio-api/health').json()['creative'])
                    self.assertFalse(client.get('/creative-api/config').json()['ready'])
                    self.assertEqual(client.post('/creative-api/media',headers={'origin':'https://evil.test'},content=b'abc').status_code,403)
                    self.assertEqual(client.post('/creative-api/media',headers={'content-type':'image/png'},content=b'abc').status_code,400)
                    data=client.post('/creative-api/media?name=clip.mp4',headers={'content-type':'video/mp4'},content=b'\0\0\0\x18ftypisom'+b'0'*24).json()
                    self.assertEqual(client.get('/creative-api/media/'+data['id']).status_code,200)
                    self.assertEqual(client.post('/creative-api/analyze/'+data['id']).status_code,400)
                    item=dict(id='b'*32,source=data['id'],name='clip.mp4',script=SCRIPT,video={'duration':1},status='success')
                    app.state.creative.items[item['id']]=item
                    self.assertEqual(client.post('/creative-api/jobs/'+item['id']+'/script',json=SCRIPT).status_code,200)
                    bad=copy.deepcopy(SCRIPT);bad['shots'][0]['end']=2
                    self.assertEqual(client.post('/creative-api/jobs/'+item['id']+'/script',json=bad).status_code,422)
                    self.assertEqual(client.get('/creative-api/jobs/'+item['id']+'/result').status_code,404)

    def test_real_local_video_inspection(self):
        fixture=Path(__file__).resolve().parent.parent/'output'/'playwright'/'qa-video.mp4'
        if not fixture.exists():self.skipTest('local optional video fixture missing')
        with tempfile.TemporaryDirectory() as temp:
            result=inspect_video(fixture)
            self.assertGreater(result['duration'],0)
            self.assertEqual(list(Path(temp).iterdir()),[])

    def test_real_video_with_sound_does_not_extract_audio(self):
        import imageio_ffmpeg
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-y','-f','lavfi','-i','color=c=gray:s=64x64:d=1',
                            '-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac',
                            '-shortest',str(root/'audio-video.mp4')],check=True,capture_output=True,
                           creationflags=0x08000000 if __import__('os').name=='nt' else 0)
            from moviepy import VideoFileClip
            with patch('moviepy.VideoFileClip', wraps=VideoFileClip) as open_clip:
                result=inspect_video(root/'audio-video.mp4')
            self.assertFalse(open_clip.call_args.kwargs['audio'])
            self.assertGreater(result['duration'],0)
            self.assertEqual([p.name for p in root.iterdir()],['audio-video.mp4'])


if __name__=='__main__':unittest.main()
