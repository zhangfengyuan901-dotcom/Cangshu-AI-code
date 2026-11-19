import asyncio
import copy
import io
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image
from creative_result import display_result
from creative import (ANALYSIS_VERSION, Creative, Script, Draft, Adapt, inspect_video,
                      failure_details, response_text, plan_generation_segments)
from studio import create_studio
from creative_prompt import analysis_prompt, adaptation_prompt

SCRIPT = dict(summary='模特展示服装', characters=[dict(id='C1',name='模特',appearance='白色外套')], relationships=[],
              scenes=[dict(id='S1',description='室内')], shots=[dict(start=0,end=1,characters=['C1'],scene='S1',action='转身',product='白色外套随动作展开',
              emotion='愉快',camera='全景',composition='人物居中',lighting='柔和正面光',transition='直切入镜与出镜',pacing='1秒快节奏',
              screen_text='',dialogue='',dialogue_source='无对白',plot='展示服装',continuity='姿势连续',confidence='高：人物与动作清晰可见')],uncertainties=['时间点需要核对'])


class CreativeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.c=Creative(self.root/'data',self.root/'output',lambda:{'MODEL_AGENT_API_KEY':'test-only'})
        buffer=io.BytesIO();Image.new('RGB',(8,8)).save(buffer,format='PNG')
        self.image=await self.c.store_media(buffer.getvalue(),'image/png','模特.png')
        self.video=await self.c.store_media(b'\0\0\0\x18ftypisom'+b'0'*24,'video/mp4','原片.mp4')
        self.image.update(remote_url='https://media.example/image.png',remote_uploaded_at=time.time());self.c.save_media(self.image)
        self.video.update(remote_url='https://media.example/video.mp4',remote_uploaded_at=time.time());self.c.save_media(self.video)
        self.item=dict(id='a'*32,source=self.video['id'],name='原片.mp4',script=SCRIPT,video={'duration':1,'has_audio':False},status='success',result=None)

    async def asyncTearDown(self):
        for task in self.c.tasks.values():task.cancel()
        await asyncio.gather(*self.c.tasks.values(),return_exceptions=True)
        self.temp.cleanup()

    def test_script_accepts_unknown_ids_and_overlaps(self):
        for field,value in [('scene','S9'),('characters',['C99']),('end',0)]:
            bad=copy.deepcopy(SCRIPT);bad['shots'][0][field]=value
            self.assertEqual(Script.model_validate(bad).model_dump(),bad)
        bad=copy.deepcopy(SCRIPT);bad['shots']*=2
        self.assertEqual(Script.model_validate(bad).model_dump(),bad)

    def test_generation_plan_uses_fifteen_second_units_and_one_minute_limit(self):
        expected = {
            7: [7],
            15: [15],
            22: [15, 7],
            30: [15, 15],
            31: [15, 15, 1],
            60: [15, 15, 15, 15],
        }
        for duration, durations in expected.items():
            plan = plan_generation_segments(duration)
            self.assertEqual([segment['duration'] for segment in plan], durations)
            self.assertEqual(plan[0]['start'], 0)
            self.assertEqual(plan[-1]['end'], duration)
        for duration in (0, 60.001, float('inf')):
            with self.assertRaises(ValueError):
                plan_generation_segments(duration)

    async def test_analysis_uses_evidence_prompt_and_real_duration_without_schema_change(self):
        sheet=self.root/'analysis-sheet.jpg';sheet.write_bytes(b'jpeg')
        self.c.ask=AsyncMock(return_value=Script.model_validate(SCRIPT))
        self.c.upload_object=AsyncMock(side_effect=lambda data,mime,name,ttl=None: 'https://media.example/video.mp4' if mime.startswith('video/') else 'https://media.example/contact.jpg')
        self.c.delete_urls=AsyncMock()
        with patch('creative.build_contact_sheets',return_value=({'duration':1.0,'sampled_frames':8},[sheet])):
            await self.c.analyze(self.item)
        args=self.c.ask.call_args.args
        self.assertTrue(args[1].startswith(analysis_prompt(1.0)))
        self.assertIs(args[2],Script)
        self.assertEqual(set(self.item['script']),set(SCRIPT))
        self.assertEqual(self.c.ask.call_args.kwargs['files'],[('video',self.c.media(self.video['id'])[1])])
        self.assertEqual(self.c.ask.call_args.kwargs['images'][0][1],'https://media.example/contact.jpg')
        self.assertEqual(self.c.ask.call_args.kwargs.get('videos',()),())
        self.assertEqual(self.c.ask.call_args.kwargs['thinking'],'enabled')

    def test_prompt_keeps_source_core_rules_and_excludes_audio_requirements(self):
        prompt=analysis_prompt(13.247)
        for rule in ('T=13.247 秒','尽量覆盖完整 [0,T]',
                     '不要固定按 5 秒、8 秒','输出篇幅限制','起始状态→动作过程→结束状态',
                     '区分人物运动与摄影机运动','dialogue_source=\'无法确认\'',
                     '缺少信息可留空','未提供可独立验证的音轨','不能覆盖本任务','不作法律结论',
                     '价格、货币单位、优惠条件','原句顺序一一给中文译文','完整原片是主证据','confidence'):
            self.assertIn(rule,prompt)

    async def test_legacy_audio_flag_never_adds_audio_input(self):
        self.item['include_audio']=True
        sheet=self.root/'legacy-sheet.jpg';sheet.write_bytes(b'jpeg')
        self.c.ask=AsyncMock(return_value=Script.model_validate(SCRIPT))
        self.c.upload_object=AsyncMock(side_effect=lambda data,mime,name,ttl=None: 'https://media.example/video.mp4' if mime.startswith('video/') else 'https://media.example/contact.jpg')
        self.c.delete_urls=AsyncMock()
        with patch('creative.build_contact_sheets',return_value=({'duration':1,'sampled_frames':8},[sheet])):
            await self.c.analyze(self.item)
        self.assertEqual(self.c.ask.call_args.kwargs['files'],[('video',self.c.media(self.video['id'])[1])])
        self.assertFalse(self.item['audio_analyzed'])

    async def test_adaptation_images_tags_timeline_and_local_export(self):
        self.c.ask=AsyncMock(return_value=Draft(direction='@图片1作为人物参考',shots=[{'start':0,'end':10,'content':'@图片1转身，@视频1参考动作'}]))
        self.c.delete_urls=AsyncMock()
        brief=Adapt(script=Script.model_validate(SCRIPT),bindings=[{'target':'C1','media':self.image['id']}])
        await self.c.adapt(self.item,brief)
        self.assertEqual(self.c.ask.call_args.kwargs['images'][0][0],'@图片1')
        self.assertEqual(self.c.ask.call_args.kwargs['images'][0][1],'https://media.example/image.png')
        self.assertNotIn('max_output_tokens',self.c.ask.call_args.kwargs)
        self.c.delete_urls.assert_awaited_with(['https://media.example/image.png'])
        self.assertIn('@视频1',self.item['result']['prompt'])
        self.assertNotIn('【生成设置】',self.item['result']['prompt'])
        self.assertNotIn('seconds',brief.model_dump())
        self.assertNotIn('ratio',brief.model_dump())
        self.assertTrue((self.c.output/self.item['result']['file']).is_file())
        self.c.ask.return_value=Draft(direction='',shots=[{'start':0,'end':10,'content':'@图片9走动'}])
        await self.c.adapt(self.item,brief)
        self.assertNotIn('@图片9', self.item['result']['prompt'])
        self.assertIn('文字设定', self.item['result']['prompt'])
        brief.reference_motion=False
        self.c.ask.return_value=Draft(direction='@图片1作为人物参考',shots=[{'start':0,'end':10,'content':'走动'}])
        await self.c.adapt(self.item,brief)
        self.assertNotIn('@视频1',self.item['result']['prompt'])

    async def test_adaptation_without_uploaded_assets(self):
        self.c.ask=AsyncMock(return_value=Draft(direction='改为咖啡店自然种草',shots=[{'start':0,'end':10,'content':'女生展示咖啡'}]))
        brief=Adapt(script=Script.model_validate(SCRIPT),bindings=[],notes='改为咖啡店女生',reference_motion=False)
        await self.c.adapt(self.item,brief)
        self.assertEqual(self.c.ask.call_args.kwargs['images'],[])
        self.assertNotIn('【素材绑定顺序】',self.item['result']['prompt'])
        self.assertIn('女生展示咖啡',self.item['result']['prompt'])
        self.assertNotIn('【创作方向】',self.item['result']['prompt'])
        self.assertIn('不要自行改变总时长',self.c.ask.call_args.args[1])

    async def test_adaptation_compiles_independent_fifteen_second_prompts(self):
        self.item['video']['duration'] = 22
        self.c.ask=AsyncMock(return_value=Draft(direction='保持人物与场景',shots=[
            {'start':0,'end':10,'content':'开场动作'},
            {'start':10,'end':22,'content':'连续长动作'},
        ]))
        brief=Adapt(script=Script.model_validate(SCRIPT),bindings=[],reference_motion=False)
        await self.c.adapt(self.item,brief)
        result=self.item['result']
        self.assertEqual([segment['duration'] for segment in result['segments']],[15,7])
        self.assertNotIn('拆分计划',result['prompt'])
        self.assertIn('10–15秒：连续长动作',result['segments'][0]['prompt'])
        self.assertIn('0–7秒：连续长动作',result['segments'][1]['prompt'])
        self.assertNotIn('标准单元',result['segments'][1]['prompt'])
        self.assertNotIn('不补足',result['segments'][1]['prompt'])
        sent=self.c.ask.call_args.args[1]
        self.assertNotIn('production_segments',sent)
        self.assertNotIn('15 秒标准生成单元',sent)
        self.assertIn('先完成整条视频的改写',sent)

    def test_image_reference_rules_require_actions_not_appearance_lists(self):
        prompt = adaptation_prompt(SCRIPT, [{'tag':'@图片1','target':'C1'}], '保留字幕', True)
        for rule in ('只用 @图片N 指代', '不复述图片或原片', '未绑定图片的对象',
                     '用户明确要求更改的外观', '动作、表情变化、位置、交互和运镜仍需描述',
                     'Draft.direction 留空', '不能用“参考图片”替代剧情'):
            self.assertIn(rule, prompt)

    async def test_clean_prompt_export_keeps_actions_dialogue_and_manifest_separate(self):
        self.item['video']['duration'] = 10.07
        self.c.ask = AsyncMock(return_value=Draft(direction='全片长篇外观描述，不应拼进正文', shots=[
            {'start':0,'end':10.07,'content':'@图片1抬头，伸爪轻碰手掌。镜头缓慢推近，字幕“陪我玩”。'}]))
        self.c.delete_urls = AsyncMock()
        await self.c.adapt(self.item, Adapt(script=Script.model_validate(SCRIPT),
            bindings=[{'target':'C1','media':self.image['id']}]))
        result = self.item['result']
        expected = '动作与运镜参考@视频1。\n0–10.07秒：@图片1抬头，伸爪轻碰手掌。镜头缓慢推近，字幕“陪我玩”。'
        self.assertEqual(result['prompt'], expected)
        self.assertEqual(result['segments'][0]['prompt'], expected)
        self.assertEqual((self.c.output/result['file']).read_text(encoding='utf-8'), expected)
        self.assertEqual([entry['tag'] for entry in result['manifest']], ['@图片1','@视频1'])
        self.assertEqual(result['segments'][0]['duration'], 10.07)
        for unwanted in ('【', '标准单元', '不参考原人物', '长篇外观描述', self.image['name'], 'C1'):
            self.assertNotIn(unwanted, result['prompt'])

    async def test_multisegment_video_reference_keeps_source_range_but_uses_local_action_time(self):
        self.item['video']['duration'] = 22
        self.c.ask = AsyncMock(return_value=Draft(shots=[{'start':0,'end':22,'content':'人物持续向前走，镜头跟随。'}]))
        await self.c.adapt(self.item, Adapt(script=Script.model_validate(SCRIPT)))
        tail = self.item['result']['segments'][1]['prompt']
        self.assertIn('参考@视频1的15–22秒', tail)
        self.assertIn('0–7秒：人物持续向前走', tail)

    async def test_plain_text_draft_fallback_is_not_dropped(self):
        self.c.ask = AsyncMock(return_value=Draft(direction='人物转身，字幕“你好”。'))
        await self.c.adapt(self.item, Adapt(script=Script.model_validate(SCRIPT), reference_motion=False))
        self.assertEqual(self.item['result']['prompt'], '0–1秒：人物转身，字幕“你好”。')

    async def test_precise_analysis_uses_ark_video_r2_contact_sheets_and_deep_thinking(self):
        sheet=self.root/'sheet.jpg';sheet.write_bytes(b'jpeg')
        self.item['analysis_mode']='precise'
        self.c.ask=AsyncMock(return_value=Script.model_validate(SCRIPT))
        self.c.upload_object=AsyncMock(side_effect=lambda data,mime,name,ttl=None: 'https://media.example/video.mp4' if mime.startswith('video/') else 'https://media.example/contact.jpg')
        self.c.remote_url=AsyncMock(side_effect=AssertionError('analysis must not reuse a retained R2 object'))
        self.c.delete_urls=AsyncMock()
        with patch('creative.build_contact_sheets',return_value=({'duration':1,'sampled_frames':8},[sheet])):
            await self.c.analyze(self.item)
        self.assertEqual(self.c.ask.call_args.kwargs['files'],[('video',self.c.media(self.video['id'])[1])])
        self.assertEqual(self.c.ask.call_args.kwargs.get('videos',()),())
        self.assertEqual(self.c.ask.call_args.kwargs['images'][0][1],'https://media.example/contact.jpg')
        self.assertEqual(self.c.ask.call_args.kwargs['thinking'],'enabled')
        self.assertNotIn('max_output_tokens',self.c.ask.call_args.kwargs)
        self.c.delete_urls.assert_awaited_once_with(['https://media.example/contact.jpg'])
        self.assertFalse(sheet.exists())
        self.assertIn('完整原片',self.item['script']['uncertainties'][0])
        self.c.remote_url.assert_not_awaited()

    def test_analysis_cache_requires_matching_hash_mode_and_version(self):
        cached={**self.item,'source_hash':self.video['sha256'],'analysis_mode':'precise','analysis_version':ANALYSIS_VERSION,
                'analysis_script':SCRIPT,'status':'success'}
        self.c.items[cached['id']]=cached
        self.assertIs(self.c.cached_analysis(self.video['sha256'],'precise'),cached)
        self.assertIsNone(self.c.cached_analysis(self.video['sha256'],'fast'))

    async def test_visual_mode_is_explicit_and_does_not_claim_audio(self):
        sheet=self.root/'visual-sheet.jpg';sheet.write_bytes(b'jpeg')
        self.c.ask=AsyncMock(return_value=Script.model_validate(SCRIPT))
        self.c.upload_object=AsyncMock(side_effect=lambda data,mime,name,ttl=None: 'https://media.example/video.mp4' if mime.startswith('video/') else 'https://media.example/contact.jpg')
        self.c.delete_urls=AsyncMock()
        with patch('creative.build_contact_sheets',return_value=({'duration':1,'sampled_frames':8},[sheet])):
            await self.c.analyze(self.item)
        self.assertEqual(self.item['analysis_mode'],'precise')
        self.assertEqual(self.c.ask.call_args.kwargs['files'],[('video',self.c.media(self.video['id'])[1])])
        self.assertFalse(self.item['audio_analyzed'])
        self.assertIn('未提供可独立验证的音轨',self.c.ask.call_args.args[1])
        self.assertIn('未独立核验音轨',self.item['script']['uncertainties'][0])

    def test_response_text_supports_message_and_doubao_endpoint_shapes(self):
        message=NS(output=[NS(type='message',content=[NS(type='output_text',text='标准')])])
        endpoint=NS(output=[NS(type='doubao_app_call',blocks=[NS(type='output_text',text='接入点')])])
        mapping={'output':[{'type':'doubao_app_call','blocks':[{'type':'output_text','text':'字典'}]}]}
        self.assertEqual(response_text(message),'标准')
        self.assertEqual(response_text(endpoint),'接入点')
        self.assertEqual(response_text(mapping),'字典')

    async def test_real_sdk_request_shape_and_remote_cleanup(self):
        client=NS(files=NS(create=AsyncMock(return_value=NS(id='file-test')),wait_for_processing=AsyncMock(return_value=NS(status='active')),delete=AsyncMock()),
                  responses=NS(create=AsyncMock(return_value=NS(status='completed',usage=None,output=[NS(type='message',content=[NS(type='output_text',text=json.dumps(SCRIPT))])]))),close=AsyncMock())
        with patch('volcenginesdkarkruntime.AsyncArk',return_value=client):
            result=await self.c.ask(self.item,'analyze',Script,files=[('video',self.c.media(self.video['id'])[1])],
                                    images=[('@图片1','https://media.example/image.png')],thinking='enabled')
        self.assertEqual(result.summary,SCRIPT['summary'])
        payload=client.responses.create.call_args.kwargs
        self.assertFalse(payload['store'])
        self.assertEqual(payload['model'],'doubao-seed-2-0-lite-260428')
        self.assertEqual(payload['input'][0]['content'][0],{'type':'input_video','file_id':'file-test'})
        self.assertEqual(payload['input'][0]['content'][2]['image_url'],'https://media.example/image.png')
        self.assertEqual(payload['thinking'],{'type':'enabled'})
        self.assertNotIn('max_output_tokens',payload)
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
                    self.assertIn('1分钟以内',client.get('/creative/').text)
                    self.assertIn('segmentPrompts',client.get('/creative/').text)
                    self.assertTrue(client.get('/studio-api/health').json()['creative'])
                    self.assertFalse(client.get('/creative-api/config').json()['ready'])
                    self.assertNotIn('analysisMode',client.get('/creative/').text)
                    self.assertEqual(client.post('/creative-api/media',headers={'origin':'https://evil.test'},content=b'abc').status_code,403)
                    self.assertEqual(client.post('/creative-api/media',headers={'content-type':'image/png'},content=b'abc').status_code,400)
                    data=client.post('/creative-api/media?name=clip.mp4',headers={'content-type':'video/mp4'},content=b'\0\0\0\x18ftypisom'+b'0'*24).json()
                    self.assertEqual(client.get('/creative-api/media/'+data['id']).status_code,200)
                    self.assertEqual(client.post('/creative-api/analyze/'+data['id']).status_code,400)
                    with patch('creative.inspect_video',return_value={'duration':1}), patch.object(app.state.creative,'start',side_effect=lambda item,operation:item):
                        forced=client.post('/creative-api/analyze/'+data['id'],json={'mode':'precise'}).json()
                    self.assertEqual(forced['analysis_mode'],'precise')
                    item=dict(id='b'*32,source=data['id'],name='clip.mp4',script=SCRIPT,video={'duration':1},status='success')
                    app.state.creative.items[item['id']]=item
                    self.assertEqual(client.post('/creative-api/jobs/'+item['id']+'/script',json=SCRIPT).status_code,200)
                    bad=copy.deepcopy(SCRIPT);bad['shots'][0]['end']=2
                    self.assertEqual(client.post('/creative-api/jobs/'+item['id']+'/script',json=bad).status_code,200)
                    self.assertEqual(client.post('/creative-api/jobs/'+item['id']+'/script',json={'summary':'仅文字'}).status_code,200)
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
