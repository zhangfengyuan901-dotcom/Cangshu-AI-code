"""Actual locked SDK -> local Node broker -> synthetic relay; no external network."""
import asyncio
import json
import socket
import sys
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

sys.path.insert(0, sys.argv[1])
from chat import Conversations, HTTPException

async def main():
    config = json.loads(sys.argv[2])
    expected = sys.argv[3]
    chat = NS(client_factory=None, review_history=lambda item: False,
              ensure_scope=lambda *args, **kwargs: None, keys=lambda: dict(config),
              save=lambda item: None, tasks={})
    chat.inputs = AsyncMock(return_value=[{'role': 'user', 'content': [{'type': 'input_text', 'text': 'fixture'}]}])
    chat.paid_control = AsyncMock(return_value={'price_version': 'chat-cny-9-45-actual-v2', 'limits': {'max_output_tokens': 128}})
    chat.reconcile_bill = AsyncMock(side_effect=HTTPException(404, 'synthetic absent bill'))
    answer = {'id': 'b'*32, 'role': 'assistant', 'status': 'running', 'text': '',
              'billing': {'status': 'not_submitted', 'request_id': 'c'*32, 'price_version': 'chat-cny-9-45-actual-v2'},
              'billing_scope': config['EXECUTION_SCOPE']}
    item = {'id': 'd'*32, 'status': 'running', 'messages': [answer], 'media': {}, 'chain': None}
    captured = []
    async def fault(module, error):
        captured.append({'module': module, 'status': getattr(error, 'status_code', 0), 'body': getattr(error, 'body', None)})
    connect, connect_ex = socket.socket.connect, socket.socket.connect_ex
    def guard(original):
        def call(sock, address):
            assert address[0] == '127.0.0.1', 'non-loopback connection forbidden'
            return original(sock, address)
        return call
    with patch.object(socket.socket, 'connect', guard(connect)), patch.object(socket.socket, 'connect_ex', guard(connect_ex)), patch('fault_report.report_fault', new=fault):
        await Conversations.run(chat, item, dict(config))
    assert answer['billing']['status'] == expected, answer['billing']['status']
    assert chat.reconcile_bill.await_count == (1 if expected == 'unknown' else 0)
    assert len(captured) == 1 and isinstance(captured[0]['body'], dict)
    assert not chat.tasks
    print(json.dumps({'billingStatus': answer['billing']['status'], 'billReads': chat.reconcile_bill.await_count,
                      'stage': item['stage'], 'sdkError': captured[0], 'realPaidCalls': 0}))

asyncio.run(main())
