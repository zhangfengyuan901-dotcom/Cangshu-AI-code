"""Offline tests: wallet generation must never reach a provider or repeat submission."""
import unittest
from unittest.mock import AsyncMock, patch
from app import sanbao


class WalletGenerationTests(unittest.IsolatedAsyncioTestCase):
    async def test_pikno_uses_local_journal_without_old_wallet_or_provider(self):
        calls = []
        async def request(session, method, url, **kwargs):
            calls.append((method, url, kwargs))
            if url.endswith('/api/models'):
                return {'data': [{'id': 'main-video-candidate', 'billing_mode': 'relay'}]}
            return {'task': {'key': 'fixture', 'status': 'succeeded', 'result': {'local_url': '/api/tasks/fixture/file'}}}
        with patch.dict('os.environ', {'HAMSTER_PIKNO_MODE': '1', 'HAMSTER_WALLET_MODE': '0', 'HAMSTER_WALLET_API': 'http://127.0.0.1:12345'}), patch.object(sanbao, '_json', request), patch.object(sanbao, '_headers', side_effect=AssertionError('no direct provider key')):
            result = await sanbao.generate('videos', {'model': 'main-video-candidate', 'prompt': 'test'})
        self.assertEqual(result['download_url'], 'http://127.0.0.1:12345/api/tasks/fixture/file')
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(url.startswith('http://127.0.0.1:12345/api/') for _, url, _ in calls))
    async def test_video_uses_local_wallet_and_polls_original_task(self):
        calls = []
        async def request(session, method, url, **kwargs):
            calls.append((method, url, kwargs))
            if url.endswith('/api/models'):
                return {'data': [{'id': 'main-video-720', 'price_version': 3}]}
            if method == 'POST':
                return {'task': {'key': 'fixture', 'status': 'queued'}}
            return {'tasks': [{'key': 'fixture', 'status': 'succeeded', 'result': {'download_url': 'https://result.example/ok.mp4'}}]}
        with patch.dict('os.environ', {'HAMSTER_WALLET_MODE': '1', 'HAMSTER_WALLET_API': 'http://127.0.0.1:12345'}), patch.object(sanbao, '_json', request), patch.object(sanbao.asyncio, 'sleep', AsyncMock()):
            result = await sanbao.generate('videos', {'model': 'sd_2_5_once_720p', 'prompt': 'test'})
        self.assertEqual(result['download_url'], 'https://result.example/ok.mp4')
        self.assertTrue(all(url.startswith('http://127.0.0.1:12345/api/') for _, url, _ in calls))
        posts = [k for method, _, k in calls if method == 'POST']
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]['json']['model'], 'main-video-720')
        self.assertEqual(posts[0]['json']['price_version'], 3)
        self.assertEqual(set(posts[0]['headers']), {'Idempotency-Key'})

    async def test_closed_image_route_does_not_submit(self):
        request = AsyncMock(return_value={'data': []})
        with patch.dict('os.environ', {'HAMSTER_WALLET_MODE': '1', 'HAMSTER_WALLET_API': 'http://127.0.0.1:12345'}), patch.object(sanbao, '_json', request):
            with self.assertRaisesRegex(RuntimeError, '尚未开放'):
                await sanbao.generate('images', {'model': 'image_2_5_flare'})
        self.assertEqual(request.await_count, 1)

    async def test_ambiguous_submit_never_retries_or_falls_back(self):
        request = AsyncMock(side_effect=[{'data': [{'id': 'main-video-720'}]}, TimeoutError('offline')])
        with patch.dict('os.environ', {'HAMSTER_WALLET_MODE': '1', 'HAMSTER_WALLET_API': 'http://127.0.0.1:12345'}), patch.object(sanbao, '_json', request):
            with self.assertRaises(TimeoutError):
                await sanbao.generate('videos', {'model': 'sd_2_5_once_720p'})
        self.assertEqual(request.await_count, 2)

    async def test_wallet_endpoint_must_be_loopback(self):
        with patch.dict('os.environ', {'HAMSTER_WALLET_MODE': '1', 'HAMSTER_WALLET_API': 'https://foreign.example'}):
            with self.assertRaisesRegex(RuntimeError, '账户服务未就绪'):
                await sanbao.generate('videos', {})


if __name__ == '__main__':
    unittest.main()
