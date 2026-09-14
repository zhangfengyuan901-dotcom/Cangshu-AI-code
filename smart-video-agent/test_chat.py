"""Offline tests: real persistence/API, mocked paid model boundary."""
import asyncio
import io
import json
import logging
import tempfile
import time
import unittest
import uuid
import zipfile
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from PIL import Image
from chat import Conversations, MessageRequest, document_text
from chat_policy import CHAT_PRIVATE, SAFE_REPLY, install_private_logging, review_output
from studio import create_studio


class Stream:
    def __init__(self, text='你好，已理解素材。', delay=0, fail=False):
        self.text, self.delay, self.fail = text, delay, fail
        self.close = AsyncMock()

    async def __aiter__(self):
        for word in [self.text[:3], self.text[3:]]:
            await asyncio.sleep(self.delay)
            yield NS(type='response.output_text.delta', delta=word)
        if self.fail:
            raise ConnectionError('provider-secret-payload')
        yield NS(type='response.completed', response=NS(id='resp-' + uuid.uuid4().hex, status='completed', expire_at=int(time.time()) + 86400,
              output=[NS(type='message', content=[NS(type='output_text', text=self.text)])]))


def fake_client():
    return NS(files=NS(create=AsyncMock(side_effect=lambda **k: NS(id='file-' + uuid.uuid4().hex)),
              wait_for_processing=AsyncMock(return_value=NS(status='active')), delete=AsyncMock()),
              responses=NS(create=AsyncMock(side_effect=lambda **k: Stream())), close=AsyncMock())


class ChatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.client = fake_client()
        self.chat = Conversations(self.root/'chat', lambda:{'MODEL_AGENT_API_KEY':'secret-test'}, lambda:self.client)
        self.item = self.chat.get(self.chat.create()['id'])

    async def asyncTearDown(self):
        for task in list(self.chat.tasks.values()): task.cancel()
        await asyncio.gather(*list(self.chat.tasks.values()), return_exceptions=True)
        self.chat.db.close()
        self.tmp.cleanup()

    def request(self, text='你好', attachments=None):
        return MessageRequest(request_id=uuid.uuid4().hex, parent=self.item['messages'][-1]['id'] if self.item['messages'] else '', text=text, attachments=attachments or [])

    async def turn(self, request=None):
        self.chat.start(self.item, request or self.request())
        await self.chat.tasks[self.item['id']]
        await asyncio.sleep(0)

    async def test_chained_turns_no_whole_history_and_private_metadata(self):
        await self.turn()
        first = self.item['chain']['id']
        await self.turn(self.request('再具体一点'))
        calls = self.client.responses.create.call_args_list
        self.assertNotIn('previous_response_id', calls[0].kwargs)
        self.assertEqual(calls[1].kwargs['previous_response_id'], first)
        self.assertEqual(len(calls[1].kwargs['input']), 1)
        self.assertTrue(calls[1].kwargs['store'])
        self.assertTrue(calls[1].kwargs['stream'])
        self.assertIn('仓鼠AI智能体', calls[1].kwargs['instructions'])
        public = json.dumps(self.chat.public(self.item))
        for secret in ('resp-', 'file-', 'fingerprint', 'secret-test'):
            self.assertNotIn(secret, public)

    async def test_shared_endpoint_changes_without_restart_and_resets_remote_chain(self):
        config = {'MODEL_AGENT_API_KEY':'secret-test', 'LLM_ENDPOINT_ID':'ep-shared-first'}
        self.chat.keys = lambda: dict(config)
        await self.turn()
        self.assertEqual(self.client.responses.create.call_args.kwargs['model'], 'ep-shared-first')
        config['LLM_ENDPOINT_ID'] = 'ep-shared-second'
        await self.turn(self.request('继续'))
        request = self.client.responses.create.call_args.kwargs
        self.assertEqual(request['model'], 'ep-shared-second')
        self.assertNotIn('previous_response_id', request)
        self.assertEqual(len(request['input']), 3)
        self.assertNotIn('ep-shared-second', json.dumps(self.chat.public(self.item)))

    async def test_expired_context_replays_messages_and_refreshes_files(self):
        media = await self.chat.upload(self.item, b'%PDF-1.7\nfixture', '说明.pdf')
        await self.turn(self.request('概括', [media['id']]))
        self.item['chain']['expire_at'] = 0
        self.item['media'][media['id']]['remote']['file']['expire_at'] = 0
        await self.turn(self.request('上面有哪些重点'))
        request = self.client.responses.create.call_args.kwargs
        self.assertNotIn('previous_response_id', request)
        self.assertEqual([x['role'] for x in request['input']], ['user','assistant','user'])
        self.assertEqual(self.client.files.create.call_count, 2)
        self.assertTrue(any(x['type'] == 'input_file' for x in request['input'][0]['content']))
        self.assertIn('重建', self.item['notice'])

    async def test_stale_previous_id_only_retries_definitive_rejection(self):
        await self.turn()
        error = httpx.HTTPStatusError('not used', request=httpx.Request('POST','https://example.com'), response=httpx.Response(404))
        error.status_code, error.body = 404, {'error':{'param':'previous_response_id'}}
        self.client.responses.create.side_effect = [error, Stream()]
        await self.turn(self.request('继续'))
        self.assertEqual(self.item['status'], 'completed')
        self.assertNotIn('previous_response_id', self.client.responses.create.call_args.kwargs)
        self.client.responses.create.side_effect = ConnectionError('secret')
        await self.turn(self.request('再继续'))
        self.assertEqual(self.item['status'], 'failed')
        self.assertNotIn('secret', self.item['stage'])

    async def test_dedup_concurrency_parent_and_cross_session_file_rejection(self):
        self.client.responses.create.side_effect = lambda **k: Stream(delay=.1)
        request = self.request()
        self.chat.start(self.item, request)
        self.chat.start(self.item, request)
        self.assertEqual(len(self.item['messages']), 2)
        with self.assertRaises(HTTPException): self.chat.start(self.item, self.request('next'))
        await self.chat.tasks[self.item['id']]
        await asyncio.sleep(0)
        with self.assertRaises(HTTPException): self.chat.start(self.item, MessageRequest(request_id=uuid.uuid4().hex, text='stale', parent=''))
        other = self.chat.get(self.chat.create()['id'])
        file = await self.chat.upload(other, b'hello', 'a.txt')
        with self.assertRaises(HTTPException): self.chat.start(self.item, self.request('跨会话', [file['id']]))

    async def test_stop_discards_unreviewed_partial_and_explicit_retry_no_duplicate_user(self):
        self.client.responses.create.side_effect = lambda **k: Stream(delay=.08)
        self.chat.start(self.item, self.request())
        await asyncio.sleep(.12)
        await self.chat.stop(self.item)
        self.assertEqual(self.item['status'], 'cancelled')
        self.assertEqual(self.item['messages'][-1]['text'], '')
        await asyncio.sleep(0)
        self.client.responses.create.side_effect = lambda **k: Stream()
        self.chat.start(self.item, self.request(), retry=True)
        await self.chat.tasks[self.item['id']]
        self.assertEqual(len(self.item['messages']), 2)
        self.assertEqual(self.item['status'], 'completed')

    async def test_restart_retains_messages_files_and_interrupt_state(self):
        media = await self.chat.upload(self.item, b'local document', '原文.txt')
        await self.turn(self.request('概括', [media['id']]))
        self.item.update(status='running'); self.item['messages'][-1]['status'] = 'running'; self.chat.save(self.item)
        reopened = Conversations(self.root/'chat', lambda:{})
        try:
            restored = reopened.get(self.item['id'])
            self.assertEqual(restored['status'], 'interrupted')
            self.assertTrue(reopened.path(restored, restored['media'][media['id']]).exists())
            self.assertEqual(len(restored['messages']), 2)
        finally: reopened.db.close()

    async def test_document_validation_and_no_inference_on_upload(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as z:
            z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>商品说明</w:t></w:r></w:p></w:document>')
        file = await self.chat.upload(self.item, output.getvalue(), '../说明.docx')
        self.assertEqual(self.item['media'][file['id']]['text'], '商品说明')
        self.client.responses.create.assert_not_called()
        self.client.files.create.assert_not_called()
        for data, name in [(b'bad', 'a.png'), (b'bad', 'a.pdf'), (b'bad','a.docx'), (b'bad','a.exe'), (b'\x00','a.txt'), (b'x'*40001,'a.txt')]:
            with self.assertRaises(HTTPException): await self.chat.upload(self.item, data, name)

    async def test_image_video_only_shapes_and_remote_reuse(self):
        buf = io.BytesIO(); Image.new('RGB', (8,8)).save(buf, format='PNG')
        image = await self.chat.upload(self.item, buf.getvalue(), '图片.png')
        video = await self.chat.upload(self.item, b'\0\0\0\x18ftypisom' + b'0'*24, '视频.mp4')
        def inspect(path):
            return {'has_audio':True,'duration':1.0}
        with patch('creative.inspect_video', side_effect=inspect):
            await self.turn(self.request('看看', [image['id'],video['id']]))
        content = self.client.responses.create.call_args.kwargs['input'][0]['content']
        self.assertTrue({'input_image','input_video'} <= {x['type'] for x in content})
        self.assertNotIn('input_audio',{x['type'] for x in content})
        await self.turn(self.request('再次看图', [image['id']]))
        self.assertEqual(self.client.files.create.call_count, 2)

    async def test_partial_disconnect_not_completed_and_context_isolation(self):
        self.client.responses.create.side_effect = lambda **k: Stream(fail=True)
        await self.turn()
        self.assertEqual(self.item['status'], 'failed')
        self.assertEqual(self.item['messages'][-1]['text'], '')
        self.assertIsNone(self.item['chain'])
        self.assertEqual(self.client.responses.create.call_count, 1)

    async def test_no_delta_published_or_saved_then_blocked_chain_rebuilt(self):
        await self.turn()
        original_chain = self.item['chain']['id']
        delta_received, finish = asyncio.Event(), asyncio.Event()
        class HeldStream(Stream):
            async def __aiter__(stream):
                for piece in ('我是', '豆', '包，后台模型是 doubao-private-model'):
                    yield NS(type='response.output_text.delta', delta=piece)
                delta_received.set()
                await finish.wait()
                async for event in super(HeldStream, stream).__aiter__():
                    yield event
        self.client.responses.create.side_effect = lambda **k: HeldStream('我是豆包，后台模型是 doubao-private-model')
        self.chat.start(self.item, self.request('继续'))
        await asyncio.wait_for(delta_received.wait(), 5)
        for snapshot in (self.chat.public(self.item), json.loads(self.chat.db.execute('SELECT data FROM conversations WHERE id=?', (self.item['id'],)).fetchone()[0])):
            self.assertEqual(snapshot['messages'][-1]['text'], '')
            self.assertNotIn('doubao-private-model', json.dumps(snapshot))
        finish.set()
        await self.chat.tasks[self.item['id']]
        await asyncio.sleep(0)
        self.assertEqual(self.item['messages'][-1]['text'], SAFE_REPLY)
        self.assertIsNone(self.item['chain'])
        self.assertNotIn('response_id', self.item['messages'][-1])
        self.assertNotIn('doubao-private-model', self.chat.db.execute('SELECT data FROM conversations WHERE id=?', (self.item['id'],)).fetchone()[0])
        self.client.responses.create.side_effect = lambda **k: Stream('可以，下面是脚本。')
        await self.turn(self.request('写脚本'))
        payload = self.client.responses.create.call_args.kwargs
        self.assertNotIn('previous_response_id', payload)
        self.assertIn(SAFE_REPLY, json.dumps(payload, ensure_ascii=False))
        self.assertNotIn(original_chain, json.dumps(payload))
        self.assertNotIn('doubao-private-model', json.dumps(payload))

    async def test_history_gate_and_public_allowlist(self):
        await self.turn()
        answer = self.item['messages'][-1]
        answer.update(text='我是豆包', raw_response='private', usage={'model':'private'}, request_id='private')
        answer.pop('review_version')
        self.chat.save(self.item)
        public = self.chat.public(self.item)
        self.assertEqual(public['messages'][-1]['text'], SAFE_REPLY)
        self.assertEqual(set(public['messages'][-1]), {'id','role','text','attachments','status'})
        self.assertIsNone(self.item['chain'])
        self.assertNotIn('我是豆包', self.chat.db.execute('SELECT data FROM conversations WHERE id=?', (self.item['id'],)).fetchone()[0])
        answer.update(text='未审查的旧分片', status='running')
        self.item['status'] = 'running'
        self.chat.save(self.item)
        reopened = Conversations(self.root/'chat', lambda:{})
        try:
            self.assertEqual(reopened.public(reopened.get(self.item['id']))['messages'][-1]['text'], '')
        finally:
            reopened.db.close()

    async def test_sdk_failure_and_cleanup_never_persist_payload(self):
        self.client.responses.create.side_effect = HTTPException(400, 'secret-test https://ark.cn-beijing.volces.com')
        self.client.close.side_effect = RuntimeError('secret-test cleanup provider')
        await self.turn()
        self.assertEqual(self.item['status'], 'failed')
        self.assertNotIn('secret-test', json.dumps(self.chat.public(self.item)))
        self.assertNotIn('volces', json.dumps(self.chat.public(self.item)))


    async def test_installed_sdk_decodes_real_sse_and_sends_chain(self):
        from volcenginesdkarkruntime import AsyncArk
        captured = []
        def handler(request):
            captured.append(json.loads(request.content))
            result = dict(id='resp-real-sdk', created_at=int(time.time()), model='internal-model', object='response',
                status='completed', tools=[], expire_at=int(time.time())+86400,
                output=[{'type':'message','id':'msg-real','role':'assistant','status':'completed',
                         'content':[{'type':'output_text','text':'SDK 流式解码成功','annotations':[]}]}])
            events = [dict(type='response.created', response={**result,'status':'in_progress','output':[]}),
                      dict(type='response.output_text.delta', delta='SDK 流式解码成功', content_index=0, output_index=0, item_id='msg-real'),
                      dict(type='response.completed', response=result)]
            content = ''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events)
            return httpx.Response(200, headers={'content-type':'text/event-stream'}, content=content)
        self.chat.client_factory = lambda: AsyncArk(api_key='offline-only', base_url='https://offline.test/api/v3',
            max_retries=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        await self.turn()
        await self.turn(self.request('继续'))
        self.assertEqual(self.item['status'], 'completed')
        self.assertEqual(self.item['messages'][-1]['text'], 'SDK 流式解码成功')
        self.assertEqual(captured[1]['previous_response_id'], 'resp-real-sdk')
        self.assertTrue(captured[1]['store'])
        self.assertTrue(captured[1]['stream'])


class PolicyTests(unittest.TestCase):
    def test_logging_is_redacted_only_inside_chat_context(self):
        install_private_logging()
        logger = logging.getLogger('offline.sdk')
        token = CHAT_PRIVATE.set(True)
        try:
            with self.assertLogs(logger, level='DEBUG') as captured:
                try:
                    raise RuntimeError('secret raw SDK body')
                except RuntimeError:
                    logger.exception('payload=%s', {'api_key':'private-secret'})
            output = str(captured.output)
            for secret in ('private-secret', 'raw SDK', 'offline.sdk', 'Traceback'):
                self.assertNotIn(secret, output)
            self.assertIn('CHAT_INTERNAL_EVENT', output)
        finally:
            CHAT_PRIVATE.reset(token)
        with self.assertLogs(logger, level='INFO') as captured:
            logger.info('other workflow unchanged')
        self.assertIn('other workflow unchanged', str(captured.output))

    def test_identity_config_prompt_and_obfuscation(self):
        from chat import INSTRUCTIONS
        forbidden = ['我是豆包', '我由字节跳动开发', '我的底层模型是豆包', '我基于豆包大模型',
                     '仓鼠AI由字节跳动提供', '我的底层使用豆包',
                     'I am Doubao', 'Powered by OpenAI', '我是Ｄｏｕｂａｏ', '我是豆\u200b包',
                     '我是 **豆 包**', 'MODEL_AGENT_API_KEY=anything',
                     '后台地址 https://ark.cn-beijing.volces.com/api/v3',
                     '密钥 abc-private-secret', '模型 my-private-model-123', INSTRUCTIONS]
        for text in forbidden:
            with self.subTest(text=text[:40]):
                result, code = review_output(text, ('abc-private-secret','my-private-model-123'), INSTRUCTIONS)
                self.assertEqual(result, SAFE_REPLY)
                self.assertNotEqual(code, 'passed')

    def test_public_comparisons_and_brand_reply_are_not_blocked(self):
        for text in ['豆包和ChatGPT都是公开的AI产品，可比较素材处理能力。',
                     '我是仓鼠AI智能体。豆包与ChatGPT的功能可以从以下方面比较。',
                     '我是仓鼠AI智能体，可以介绍豆包的公开功能。',
                     '设置 seed 参数，ARK 是一个普通字符串。', SAFE_REPLY,
                     'I am happy to compare Doubao and ChatGPT.',
                     '人物穿白色衬衫，镜头逐渐拉近，情绪由紧张转为轻松。']:
            self.assertEqual(review_output(text), (text, 'passed'))


class ChatRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_errors_do_not_echo_inputs_or_sdk_details(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = create_studio(directory=Path(tmp)/'studio', output=Path(tmp)/'out')
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:8000') as client:
                    ident = (await client.post('/chat-api/sessions')).json()['id']
                    path = '/chat-api/sessions/' + ident
                    result = await client.post(path + '/messages', json={'request_id':'private-key-invalid', 'model':'private-model'})
                    self.assertEqual(result.status_code, 422)
                    self.assertNotIn('private', result.text)
                    self.assertEqual(result.json()['code'], 'CHAT_INVALID_REQUEST')
                    self.assertEqual(result.headers['cache-control'], 'no-store')
                    with patch.object(app.state.chat, 'get', side_effect=HTTPException(400, 'provider-key-raw')):
                        result = await client.get(path)
                        self.assertEqual(result.status_code, 400)
                        self.assertNotIn('provider-key-raw', result.text)
                    with patch.object(app.state.chat, 'get', side_effect=RuntimeError('provider-sdk-traceback')):
                        result = await client.get(path)
                        self.assertEqual(result.status_code, 500)
                        self.assertNotIn('provider', result.text)
                    # The wrapper is scoped to chat, not the other application APIs.
                    self.assertEqual((await client.get('/studio-api/health')).status_code, 200)
            finally:
                app.state.chat.db.close()

    async def test_local_api_security_rename_delete_and_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = create_studio(directory=Path(tmp)/'studio', output=Path(tmp)/'out')
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:8000') as client:
                    self.assertEqual((await client.get('/chat/')).status_code, 200)
                    self.assertEqual((await client.get('/creative/')).status_code, 200)
                    self.assertEqual((await client.post('/chat-api/sessions', headers={'Origin':'https://evil.test'})).status_code, 403)
                    self.assertEqual((await client.get('/chat-api/sessions', headers={'Host':'evil.test'})).status_code, 403)
                    item = (await client.post('/chat-api/sessions')).json()
                    path = '/chat-api/sessions/' + item['id']
                    self.assertEqual((await client.patch(path, json={'title':'新品脚本'})).json()['title'], '新品脚本')
                    self.assertEqual((await client.get(path + '/media/../other')).status_code, 404)
                    self.assertEqual((await client.delete(path)).status_code, 200)
                    self.assertEqual((await client.get(path)).status_code, 404)
                    self.assertEqual((await client.get('/chat-api/sessions')).json(), [])
            finally: app.state.chat.db.close()


if __name__ == '__main__': unittest.main()
