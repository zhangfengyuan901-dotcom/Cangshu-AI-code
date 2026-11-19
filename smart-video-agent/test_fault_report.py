import os
import unittest
from unittest.mock import AsyncMock, patch
from fault_report import report_fault


class FaultReportTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_fixed_fields_reach_local_collector(self):
        client = AsyncMock()
        with patch.dict(os.environ, {'HAMSTER_REPORT_URL': 'http://127.0.0.1:8787/api/error-report'}), patch('fault_report.httpx.AsyncClient') as factory:
            factory.return_value.__aenter__.return_value = client
            error = RuntimeError('sk-secret customer prompt https://private.example')
            error.status_code = 401
            await report_fault('chat', error)
            payload = client.post.call_args.kwargs['json']
            self.assertEqual(payload, {'module':'chat', 'code':'AUTH_FAILED', 'httpStatus':401, 'frames':[]})

    async def test_missing_or_remote_endpoint_never_sends(self):
        for endpoint in ('', 'https://outside.example/api/error-report', 'http://127.0.0.1/other'):
            with patch.dict(os.environ, {'HAMSTER_REPORT_URL':endpoint}), patch('fault_report.httpx.AsyncClient') as factory:
                await report_fault('chat', RuntimeError('private'))
                factory.assert_not_called()

    async def test_collector_down_does_not_escape(self):
        with patch.dict(os.environ, {'HAMSTER_REPORT_URL':'http://127.0.0.1:8787/api/error-report'}), patch('fault_report.httpx.AsyncClient', side_effect=OSError('offline')):
            await report_fault('creative', RuntimeError('private'))
