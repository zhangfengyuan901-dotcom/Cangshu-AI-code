"""Offline contract tests: no paid generation requests."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from studio import Brief, Jobs, create_studio, configured_keys


class StudioTests(unittest.IsolatedAsyncioTestCase):
    def test_shared_settings_reload_migrate_and_clear(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root)/'config.json'
            with patch.dict(os.environ, {'HAMSTER_CONFIG_PATH':str(config)}):
                config.write_text(json.dumps({'llmApiKey':'test-key','creativeEndpointId':'ep-legacy-test'}))
                self.assertEqual(configured_keys()['LLM_ENDPOINT_ID'],'ep-legacy-test')
                config.write_text(json.dumps({'llmApiKey':'test-key','llmEndpointId':'ep-next-test'}))
                self.assertEqual(configured_keys()['LLM_ENDPOINT_ID'],'ep-next-test')
                config.write_text(json.dumps({'llmEndpointId':'','creativeEndpointId':'ep-legacy-test'}))
                self.assertEqual(configured_keys()['LLM_ENDPOINT_ID'],'')

    def test_workbench_navigation_on_all_three_pages(self):
        with tempfile.TemporaryDirectory() as root:
            with TestClient(create_studio(Path(root)/'jobs', Path(root)/'out')) as client:
                for path in ('/chat/', '/', '/creative/'):
                    response = client.get(path)
                    self.assertEqual(response.status_code,200)
                    self.assertIn('aria-label="工作台功能"',response.text)
                    self.assertIn(f'href="{path}" aria-current="page"',response.text)
                    for target in ('/chat/','/','/creative/'):
                        self.assertIn(f'href="{target}"',response.text)
                self.assertEqual(client.get('/workbench.css').status_code,200)

    async def test_evaluation_tool_uses_shared_endpoint(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from app.eval.tools import geval
        client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(output_text='{"evaluation":{}}'))))
        with patch.dict(os.environ, {'LLM_ENDPOINT_ID':'ep-shared-eval','MODEL_AGENT_API_KEY':'test-key'}), patch.object(geval,'AsyncOpenAI',return_value=client), patch.object(geval,'repair_evaluate_input',AsyncMock(return_value=[{'role':'user','content':[]}])):
            await geval.evaluate_media([])
        self.assertEqual(client.responses.create.call_args.kwargs['model'],'ep-shared-eval')

    async def test_image_generation_uses_image25_and_auto_quality(self):
        from unittest.mock import AsyncMock
        from app.image.tools import image_generate_gather as adapter
        for configured,expected in [('gpt-image2-2K','image_2_5_flare'),('image_2_5_sunburst','image_2_5_sunburst')]:
            mock=AsyncMock(return_value={})
            with patch.object(adapter,'generate',mock),patch.object(adapter,'result_url',return_value='https://example.com/out.png'),patch.dict(os.environ,{'SANBAO_IMAGE_MODEL':configured,'SANBAO_IMAGE_QUALITY':'high'}):
                await adapter._generate_one({'prompt':'test','size':'9:16','image':['https://example.com/ref.png']})
            payload=mock.call_args.args[1]
            self.assertEqual(payload['model'],expected)
            self.assertEqual(payload['quality'],'auto')
            self.assertEqual(payload['aspect_ratio'],'9:16')
            self.assertEqual(payload['images'],['https://example.com/ref.png'])

    async def test_role_references_and_video_payload(self):
        from pydantic import ValidationError
        from unittest.mock import AsyncMock
        from app.video.tools import video_generate_by_code as adapter
        refs=[dict(role='talent',kind='image',url='https://example.com/talent.png'),dict(role='product',kind='image',url='https://example.com/product.png'),dict(role='scene',kind='video',url='https://example.com/scene.mp4')]
        brief=Brief(product='开衫',selling_points='亲肤',references=refs)
        self.assertIn('达人image参考',brief.prompt())
        with self.assertRaises(ValidationError): Brief(product='开衫',selling_points='亲肤',references=refs,video_model='sd25_30img_special')
        with self.assertRaises(ValidationError): Brief(product='开衫',selling_points='亲肤',references=[refs[0],refs[0]])
        mock=AsyncMock(return_value={})
        with patch.object(adapter,'generate',mock),patch.object(adapter,'result_url',return_value='https://example.com/out.mp4'),patch.dict(os.environ,{'SANBAO_VIDEO_MODEL':'sd2_limited_line3'}):
            await adapter._generate_one({'prompt':'分镜 --rt 9:16 --rs 720p --dur 5','first_frame':'https://example.com/frame.png','reference_images':[r['url'] for r in refs[:2]],'reference_videos':[refs[2]['url']],'reference_roles':refs},100)
        payload=mock.call_args.args[1]
        self.assertEqual(len(payload['images']),3)
        self.assertEqual(payload['videos'][0]['url'],refs[2]['url'])
        self.assertIn('@图片2作为人物形象参考',payload['prompt'])
        self.assertIn('@视频1仅参考动作',payload['prompt'])

    async def test_only_four_video_routes_and_matching_quality(self):
        from pydantic import ValidationError
        for route, quality in [('hailuo_h3_2k_line2','2k'), ('wan30_720p_real','720p'), ('sd2_limited_line3','720p'), ('sd25_30img_special','720p')]:
            brief = Brief(product='开衫', selling_points='亲肤', video_model=route, resolution=quality)
            self.assertEqual(brief.video_model, route)
        with self.assertRaises(ValidationError):
            Brief(product='开衫', selling_points='亲肤', video_model='sd2_9img_full')
        with self.assertRaises(ValidationError):
            Brief(product='开衫', selling_points='亲肤', video_model='hailuo_h3_2k_line2', resolution='720p')

    async def test_actual_runner_callbacks_without_paid_models(self):
        # Exercise the real sequential runner and our callbacks while replacing
        # only model responses. No external tools are invoked.
        with patch.dict(os.environ, {'MODEL_AGENT_API_KEY':'test-key', 'SANBAO_API_KEY':'test-key'}):
            from app.model import ArkLlm
            from google.adk.models import LlmResponse
            from google.genai import types
            seen = []
            async def offline_response(self, llm_request, stream=False):
                seen.append((self.model, self._additional_args['model']))
                yield LlmResponse(content=types.Content(role='model', parts=[types.Part(text='离线验证：阶段内容')]))
            with tempfile.TemporaryDirectory() as root, patch.object(ArkLlm, 'generate_content_async', offline_response):
                jobs = Jobs(Path(root)/'jobs', Path(root)/'out')
                for endpoint in ('ep-shared-first','ep-shared-second'):
                    seen.clear()
                    with patch('studio.configured_keys',return_value={'MODEL_AGENT_API_KEY':'test-key','SANBAO_API_KEY':'test-key','LLM_ENDPOINT_ID':endpoint}):
                        item = jobs.create(Brief(product='开衫', selling_points='亲肤'))
                        await jobs.tasks[item['id']]
                    self.assertEqual(item['status'], 'failed')
                    self.assertIn('未生成', item['error'])
                    self.assertTrue(all('离线验证' in stage['text'] for stage in item['stages']))
                    self.assertEqual(len(seen),7)
                    self.assertTrue(all(model.endswith('/'+endpoint) and arg==model for model,arg in seen))

    async def test_missing_video_is_not_success(self):
        async def no_output(item, brief):
            pass
        with tempfile.TemporaryDirectory() as root:
            jobs = Jobs(Path(root) / "jobs", Path(root) / "out", no_output)
            item = jobs.create(Brief(product="开衫", selling_points="亲肤"))
            await jobs.tasks[item["id"]]
            self.assertEqual(item["status"], "failed")
            self.assertIn("未生成", item["error"])

    async def test_verified_result_and_persistence(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "out"
            output.mkdir()
            async def fake_output(item, brief):
                (output / "result.mp4").write_bytes(b"test fixture")
                item["result"] = {"name": "result.mp4", "url": "/result"}
            jobs = Jobs(Path(root) / "jobs", output, fake_output)
            item = jobs.create(Brief(product="开衫", selling_points="亲肤"))
            await jobs.tasks[item["id"]]
            self.assertEqual(item["status"], "success")
            restored = Jobs(Path(root) / "jobs", output)
            self.assertEqual(restored.get(item["id"])["status"], "success")
            item["status"] = "running"
            jobs.save(item)
            restored = Jobs(Path(root) / "jobs", output)
            self.assertEqual(restored.get(item["id"])["status"], "interrupted")

    def test_http_validation_cancel_and_busy(self):
        async def waiting(item, brief):
            await asyncio.sleep(60)
        with tempfile.TemporaryDirectory() as root, patch('studio.configured_keys', return_value={
            'SANBAO_API_KEY': 'test-media', 'MODEL_AGENT_API_KEY': 'test-llm', 'LLM_ENDPOINT_ID': ''
        }):
            app = create_studio(Path(root) / "jobs", Path(root) / "out", waiting)
            with TestClient(app) as client:
                self.assertEqual(client.get('/').status_code, 200)
                self.assertIn('javascript',client.get('/shared/asset-library.mjs').headers['content-type'])
                self.assertEqual(client.get('/shared/config.json').status_code,404)
                self.assertEqual(client.get('/studio-api/health').json()['app'], 'hamster-smart-video')
                brief = {"product": "开衫", "selling_points": "亲肤"}
                self.assertEqual(client.post('/studio-api/jobs', json={**brief, 'seconds': 7}).status_code, 422)
                self.assertEqual(client.post('/studio-api/jobs', json=brief, headers={'Origin': 'https://example.com'}).status_code, 403)
                created = client.post('/studio-api/jobs', json=brief)
                self.assertEqual(created.status_code, 202)
                job_id = created.json()['id']
                self.assertEqual(client.post('/studio-api/jobs', json=brief).status_code, 409)
                self.assertEqual(client.get(f'/studio-api/jobs/{job_id}/result').status_code, 404)
                self.assertEqual(client.post(f'/studio-api/jobs/{job_id}/cancel').json()['status'], 'cancelled')
                self.assertEqual(client.get('/studio-api/jobs').json()[0]['id'], job_id)
                self.assertEqual(client.post('/studio-api/upload', content=b'bad image', headers={'content-type':'image/png'}).status_code, 400)

    def test_missing_credentials_rejected(self):
        with tempfile.TemporaryDirectory() as root, patch('studio.configured_keys', return_value={
            'SANBAO_API_KEY': '', 'MODEL_AGENT_API_KEY': ''
        }):
            with TestClient(create_studio(Path(root)/'jobs', Path(root)/'out')) as client:
                response = client.post('/studio-api/jobs', json={'product':'开衫','selling_points':'亲肤'})
                self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
