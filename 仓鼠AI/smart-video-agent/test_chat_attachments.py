"""Paid attachment contracts with synthetic files and an isolated SDK transport."""
import asyncio
import copy
import io
import json
import mimetypes
import tempfile
import time
import unittest
import uuid
from email import policy
from email.parser import BytesParser
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

from chat import Conversations, HTTPException, MessageRequest, attachment_capabilities
from test_chat_paid import CONFIG, VERSION, Stream, terms


def media_terms():
    return {**terms(), 'capabilities': {'text': True, 'files': True, 'image': True, 'video': True, 'pdf': True},
            'limits': {'max_output_tokens': 2000, 'max_file_bytes': 50 * 1024 * 1024,
                       'max_attachments': 6, 'max_history_attachments': 12}}


class PaidAttachmentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = dict(CONFIG)
        self.capability = media_terms()
        self.file_calls = []
        self.expiry = int(time.time()) + 3600
        async def create(**options):
            file = options['file']
            data = (file[1] if isinstance(file, tuple) else file).read()
            self.file_calls.append({'bytes': data, 'options': {k: v for k, v in options.items() if k != 'file'}})
            return NS(id='hf1_' + uuid.uuid4().hex, expire_at=self.expiry)
        self.client = NS(files=NS(create=AsyncMock(side_effect=create),
                                 wait_for_processing=AsyncMock(side_effect=lambda ident, **kwargs: NS(id=ident, status='active'))),
                         responses=NS(create=AsyncMock(side_effect=lambda **kwargs: Stream())), close=AsyncMock())
        self.chat = Conversations(Path(self.temp.name), lambda: dict(self.config), lambda: self.client)
        self.item = self.chat.get(self.chat.create()['id'])
        async def control(config, request_id=None):
            if request_id:
                return {'request_id': request_id, 'price_version': VERSION, 'status': 'settled',
                        'billing_mode': 'actual_usage_v1', 'reserved_quota': 0, 'charged_quota': 10}
            return copy.deepcopy(self.capability)
        self.chat.paid_control = AsyncMock(side_effect=control)
        self.reporter = patch('fault_report.report_fault', new=AsyncMock())
        self.reporter.start()

    async def asyncTearDown(self):
        tasks = list(self.chat.tasks.values())
        for task in tasks:
            if not task.done(): task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.chat.close_reconciliation()
        self.chat.db.close()
        self.reporter.stop()
        self.temp.cleanup()

    def request(self, attachments=None):
        return MessageRequest(request_id=uuid.uuid4().hex, parent=self.item['messages'][-1]['id'] if self.item['messages'] else '',
                              text='请理解素材', attachments=attachments or [], price_version=VERSION)

    async def turn(self, attachments=None):
        self.chat.start(self.item, self.request(attachments))
        await self.chat.tasks[self.item['id']]
        await asyncio.gather(*list(self.chat.background_billing_tasks.values()))
        await asyncio.sleep(0)

    def fixtures(self):
        png = io.BytesIO(); Image.new('RGB', (8, 8)).save(png, format='PNG')
        return [('image.png', png.getvalue()), ('video.mp4', b'\0\0\0\x18ftypisom' + b'video-original-bytes'),
                ('document.pdf', b'%PDF-1.7\nsynthetic-original-pdf')]

    async def test_original_image_video_pdf_files_and_context_survive_upload_poll_and_replay(self):
        fixtures = self.fixtures()
        local = [await self.chat.upload(self.item, data, name) for name, data in fixtures]
        with patch('chat.inspect_video', return_value={'duration': 1.0}):
            await self.turn([entry['id'] for entry in local])
        self.assertEqual(self.item['status'], 'completed')
        self.assertEqual([entry['bytes'] for entry in self.file_calls], [data for _, data in fixtures])
        self.assertEqual(self.file_calls[1]['options']['preprocess_configs'], {'video': {'fps': 2}})
        self.assertNotIn('preprocess_configs', self.file_calls[0]['options'])
        body = self.client.responses.create.call_args.kwargs
        self.assertEqual({part['type'] for part in body['input'][0]['content']}, {'input_text', 'input_image', 'input_video', 'input_file'})
        self.assertNotIn('previous_response_id', body)
        for media in self.item['media'].values():
            self.assertEqual(next(iter(media['remote'].values()))['expire_at'], self.expiry)
        await self.turn()
        self.assertEqual(self.client.files.create.await_count, 3)
        self.assertEqual(self.client.responses.create.await_count, 2)
        self.assertNotIn('hf1_', json.dumps(self.chat.public(self.item)))

    async def test_text_documents_keep_local_extraction_without_files_or_audio(self):
        local = await self.chat.upload(self.item, '合成文档内容'.encode(), 'notes.md')
        await self.turn([local['id']])
        self.assertEqual(self.item['status'], 'completed')
        self.client.files.create.assert_not_awaited()
        body = self.client.responses.create.call_args.kwargs
        self.assertIn('合成文档内容', json.dumps(body, ensure_ascii=False))
        self.assertNotIn('input_audio', json.dumps(body))

    async def test_old_server_bad_limits_and_per_kind_disabled_reject_before_local_save_or_model(self):
        name, data = self.fixtures()[0]
        variants = [terms(), {**media_terms(), 'limits': {'max_output_tokens': 2000}},
                    {**media_terms(), 'capabilities': {**media_terms()['capabilities'], 'image': False}},
                    {**media_terms(), 'limits': {**media_terms()['limits'], 'max_file_bytes': True}}]
        for value in variants:
            self.capability = value
            with self.assertRaises(HTTPException): await self.chat.upload(self.item, data, name)
        self.assertEqual(self.item['media'], {})
        self.client.files.create.assert_not_awaited()
        self.client.responses.create.assert_not_awaited()

    async def test_audio_and_webm_are_not_advertised_or_accepted(self):
        for name, data in [('audio.mp3', b'ID3fixture'), ('video.webm', bytes.fromhex('1a45dfa3') + b'fixture')]:
            with self.assertRaises(HTTPException) as caught: await self.chat.upload(self.item, data, name)
            self.assertEqual(caught.exception.status_code, 415)
        self.assertNotIn('audio', attachment_capabilities(self.capability))

    async def test_capability_withdrawal_after_local_upload_never_uploads_or_submits(self):
        name, data = self.fixtures()[0]
        media = await self.chat.upload(self.item, data, name)
        self.capability['capabilities']['image'] = False
        await self.turn([media['id']])
        self.client.files.create.assert_not_awaited()
        self.client.responses.create.assert_not_awaited()
        self.assertEqual(self.item['messages'][-1]['billing']['status'], 'not_submitted')
        self.assertTrue(self.chat.path(self.item, self.item['media'][media['id']]).exists())

    async def test_upload_and_poll_failure_do_not_dispatch_or_repeat_a_file(self):
        for phase in ('create', 'wait_for_processing'):
            with self.subTest(phase=phase):
                self.item = self.chat.get(self.chat.create()['id'])
                media = await self.chat.upload(self.item, b'%PDF-1.7\nfixture', 'file.pdf')
                target = getattr(self.client.files, phase)
                original = target.side_effect
                target.side_effect = ConnectionError('synthetic transport failure')
                before = self.client.files.create.await_count
                await self.turn([media['id']])
                target.side_effect = original
                self.assertEqual(self.client.files.create.await_count, before + 1)
                self.client.responses.create.assert_not_awaited()
                self.assertEqual(self.item['messages'][-1]['billing']['status'], 'not_submitted')

    async def test_scope_change_during_upload_or_poll_cannot_publish_handle_or_submit(self):
        for phase in ('create', 'wait_for_processing'):
            with self.subTest(phase=phase):
                self.item = self.chat.get(self.chat.create()['id'])
                media = await self.chat.upload(self.item, b'%PDF-1.7\nfixture', 'file.pdf')
                target = getattr(self.client.files, phase)
                original = target.side_effect
                async def changed(*args, **kwargs):
                    self.config['CONFIG_REVISION'] += 1
                    return NS(id='hf1_old', expire_at=self.expiry, status='active')
                target.side_effect = changed
                await self.turn([media['id']])
                target.side_effect = original
                self.client.responses.create.assert_not_awaited()
                self.assertEqual(self.item['media'][media['id']]['remote'], {})
                self.assertEqual(self.item['messages'][-1]['billing']['status'], 'not_submitted')

    async def test_missing_or_expired_file_receipt_never_reaches_response(self):
        for expiry in (None, int(time.time()) + 5):
            self.item = self.chat.get(self.chat.create()['id'])
            media = await self.chat.upload(self.item, b'%PDF-1.7\nfixture', 'file.pdf')
            self.expiry = expiry
            await self.turn([media['id']])
            self.client.responses.create.assert_not_awaited()
            self.assertEqual(self.item['media'][media['id']]['remote'], {})

    async def test_seven_unique_history_attachments_preserve_existing_twelve_limit(self):
        media = [await self.chat.upload(self.item, ('document' + str(i)).encode(), 'file.txt') for i in range(7)]
        await self.turn([entry['id'] for entry in media[:6]])
        await self.turn([media[6]['id']])
        self.assertEqual(self.item['status'], 'completed')
        self.assertEqual(self.client.responses.create.await_count, 2)

    async def test_locked_sdk_sends_original_multipart_and_scope_headers_for_create_and_poll(self):
        from volcenginesdkarkruntime import AsyncArk
        captured = []
        fixtures = self.fixtures()
        async def transport(request):
            body = await request.aread()
            captured.append((request, body))
            return httpx.Response(200, json={'id': 'hf1_fixture', 'object': 'file', 'purpose': 'user_data',
                'filename': 'fixture', 'created_at': int(time.time()), 'expire_at': self.expiry, 'status': 'active'})
        headers = {'X-Hamster-Execution-Scope': self.config['EXECUTION_SCOPE'],
                   'X-Hamster-Config-Revision': str(self.config['CONFIG_REVISION'])}
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport), headers=headers) as local:
            sdk = AsyncArk(api_key='synthetic-only', base_url=self.config['MODEL_AGENT_API_BASE'], max_retries=0, http_client=local)
            try:
                for name, data in fixtures:
                    media = await self.chat.upload(self.item, data, name)
                    with patch('chat.inspect_video', return_value={'duration': 1.0}):
                        await self.chat.content(self.item, {'attachments': [media['id']], 'text': 'fixture'}, sdk, 'fixture', self.config, self.capability)
            finally:
                await sdk.close()
        self.assertEqual(len(captured), 6)
        for index, (request, body) in enumerate(captured):
            for key, value in headers.items(): self.assertEqual(request.headers[key], value)
            self.assertEqual(request.url.host, '127.0.0.1')
            if index % 2:
                self.assertEqual(request.method, 'GET')
                self.assertEqual(request.url.path, '/api/inference/api/v3/files/hf1_fixture')
                continue
            self.assertEqual(request.method, 'POST')
            self.assertEqual(request.url.path, '/api/inference/api/v3/files')
            message = BytesParser(policy=policy.default).parsebytes(('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + body)
            parts = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True) for part in message.iter_parts()}
            self.assertEqual(parts['file'], fixtures[index // 2][1])
            self.assertEqual(parts['purpose'], b'user_data')
            self.assertTrue(parts['expire_at'].isdigit())
            self.assertEqual(set(parts), {'file', 'purpose', 'expire_at', 'preprocess_configs[video][fps]'} if index == 2 else {'file', 'purpose', 'expire_at'})
            if index == 2: self.assertEqual(parts['preprocess_configs[video][fps]'], b'2')

    async def test_locked_sdk_uses_verified_image_type_for_mismatched_filename_suffix(self):
        from volcenginesdkarkruntime import AsyncArk
        captured = []
        async def transport(request):
            body = await request.aread()
            if request.method == 'POST':
                message = BytesParser(policy=policy.default).parsebytes(
                    ('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + body)
                captured.append(next(part for part in message.iter_parts()
                                     if part.get_param('name', header='content-disposition') == 'file'))
            return httpx.Response(200, json={'id': 'hf1_' + 'a' * 16 + '_' + 'b' * 32,
                'object': 'file', 'purpose': 'user_data', 'filename': 'attachment',
                'created_at': int(time.time()), 'expire_at': self.expiry, 'status': 'active'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as local:
            sdk = AsyncArk(api_key='synthetic-only', base_url=self.config['MODEL_AGENT_API_BASE'], max_retries=0, http_client=local)
            try:
                for fmt, mime, canonical_suffix in [('PNG', 'image/png', '.png'), ('JPEG', 'image/jpeg', '.jpg'), ('WEBP', 'image/webp', '.webp')]:
                    image = io.BytesIO(); Image.new('RGB', (8, 8), (11, 22, 33)).save(image, format=fmt)
                    original = image.getvalue()
                    for suffix in ('.png', '.jpg', '.webp'):
                        with self.subTest(actual=fmt, named=suffix):
                            name = 'original-name' + suffix
                            entry = await self.chat.upload(self.item, original, name)
                            media = self.item['media'][entry['id']]
                            saved_path = self.chat.path(self.item, media)
                            await self.chat.content(self.item, {'attachments': [entry['id']], 'text': 'fixture'},
                                                    sdk, 'mime-' + entry['id'], self.config, self.capability)
                            part = captured[-1]
                            self.assertEqual(part.get_content_type(), mime)
                            self.assertEqual(part.get_filename(), 'attachment' + canonical_suffix)
                            self.assertEqual(part.get_payload(decode=True), original)
                            self.assertEqual(media['name'], name)
                            self.assertEqual(media['suffix'], suffix)
                            self.assertEqual(saved_path.read_bytes(), original)
                self.assertEqual(len(captured), 9)
                mimetypes.init()
                with patch.dict(mimetypes.types_map, {'.png': 'image/x-png'}):
                    self.assertEqual(mimetypes.guess_type('registry-alias.png')[0], 'image/x-png')
                    image = io.BytesIO(); Image.new('RGB', (8, 8)).save(image, format='PNG')
                    original = image.getvalue()
                    entry = await self.chat.upload(self.item, original, 'registry-alias.png')
                    await self.chat.content(self.item, {'attachments': [entry['id']], 'text': 'fixture'},
                                            sdk, 'registry-alias', self.config, self.capability)
                    self.assertEqual(captured[-1].get_content_type(), 'image/png')
                    self.assertEqual(captured[-1].get_filename(), 'attachment.png')
                    self.assertEqual(captured[-1].get_payload(decode=True), original)
                self.client.responses.create.assert_not_awaited()
            finally:
                await sdk.close()


if __name__ == '__main__':
    unittest.main()
