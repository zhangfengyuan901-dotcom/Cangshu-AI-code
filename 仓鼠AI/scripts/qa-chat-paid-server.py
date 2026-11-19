"""Offline paid-chat UI. SDK, capabilities and ledger are all synthetic."""
import sys
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock
import uvicorn

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / 'smart-video-agent'))
import studio
from test_chat import fake_client, Stream

config = {'PIKNO_LLM_V2': True, 'MODEL_AGENT_API_KEY': 'synthetic-local-placeholder',
          'EXECUTION_SCOPE': 'a' * 64, 'CONFIG_REVISION': 1}
studio.configured_keys = lambda: dict(config)
version = 'chat-cny-9-45-actual-v2'
bill_status = os.environ.get('HAMSTER_QA_BILL_STATUS', 'settled')
if bill_status not in {'settled', 'unknown', 'reserved'}:
    raise ValueError('Unsupported synthetic bill status')
terms = {'metered': True, 'billing_mode': 'actual_usage_v1',
         'billing': {'allow_debt': True, 'one_inflight_per_user': True}, 'price_version': version,
         'pricing': {'currency': 'CNY', 'input_cny_per_million': 9, 'output_cny_per_million': 45},
         'capabilities': {'text': True, 'files': False},
         'limits': {'max_output_tokens': 512, 'max_request_bytes': 2097152}}

async def control(_config, request_id=None):
    if not request_id:
        return terms
    return {'request_id': request_id, 'status': bill_status, 'billing_mode': 'actual_usage_v1', 'price_version': version,
            'reserved_quota': 0, 'charged_quota': 540}

with tempfile.TemporaryDirectory(prefix='hamster-chat-paid-ui-') as directory:
    app = studio.create_studio(directory=Path(directory) / 'chat', output=Path(directory) / 'results')
    app.state.chat.paid_control = control
    client = fake_client()
    client.responses.create = AsyncMock(side_effect=lambda **_kw: Stream('这是离线模拟回答，没有调用模型或产生真实费用。'))
    app.state.chat.client_factory = lambda: client
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('HAMSTER_QA_PORT', '11141')), access_log=False)
