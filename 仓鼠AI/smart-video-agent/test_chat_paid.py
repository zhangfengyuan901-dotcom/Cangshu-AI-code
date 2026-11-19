"""Offline paid-chat contract tests. All service/model boundaries are synthetic."""
import asyncio
import copy
import hashlib
import json
import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from chat import Conversations, HTTPException, MessageRequest, confirmation_context, install_chat
from studio import configured_keys


VERSION = 'chat-cny-9-45-actual-v2'
CONFIG = {
    'MODEL_AGENT_API_KEY': 'hamster-cloud-session',
    'MODEL_AGENT_API_BASE': 'http://127.0.0.1:12345/api/inference/api/v3',
    'LLM_ENDPOINT_ID': 'hamster-auto',
    'PIKNO_LLM_V2': True,
    'EXECUTION_SCOPE': 'a' * 64,
    'CONFIG_REVISION': 12,
}


def terms():
    return {
        'metered': True, 'billing_mode': 'actual_usage_v1',
        'billing': {'allow_debt': True, 'one_inflight_per_user': True}, 'price_version': VERSION,
        'pricing': {'currency': 'CNY', 'input_cny_per_million': 9, 'output_cny_per_million': 45},
        'limits': {'max_output_tokens': 2000},
        'capabilities': {'text': True, 'files': False, 'image': False, 'video': False, 'pdf': False},
    }


def capability_wire():
    value = terms()
    return {'configured': True, **value,
            'private_key': 'never-return-fixture', 'upstream_model': 'private-fixture',
            'capabilities': {**value['capabilities'], 'private_provider': 'fixture'}}


class Stream:
    def __init__(self, text='已收到这条文字。', fail=False):
        self.text, self.fail = text, fail
        self.close = AsyncMock()

    async def __aiter__(self):
        yield NS(type='response.output_text.delta', delta=self.text)
        if self.fail:
            raise ConnectionError('synthetic-private-stream-error')
        yield NS(type='response.completed', response=NS(
            id='resp-private-fixture', status='completed', expire_at=int(time.time()) + 86400,
            output=[NS(type='message', content=[NS(type='output_text', text=self.text)])]))


class TerminalStream(Stream):
    def __init__(self, text='', status='incomplete', reason='max_output_tokens'):
        super().__init__(text)
        self.status, self.reason = status, reason

    async def __aiter__(self):
        # Unreviewed deltas and reasoning are never an answer source.
        yield NS(type='response.output_text.delta', delta='private-unreviewed-delta')
        output = [NS(type='reasoning', summary=[NS(type='summary_text', text='private-reasoning')])]
        if self.text:
            output.append(NS(type='message', content=[NS(type='output_text', text=self.text)]))
        yield NS(type='response.' + self.status, response=NS(
            id='resp-private-terminal', status=self.status,
            incomplete_details=NS(reason=self.reason), output=output,
            usage=NS(input_tokens=500, output_tokens=512, total_tokens=1012)))


def model_client():
    return NS(files=NS(create=AsyncMock(), wait_for_processing=AsyncMock()),
              responses=NS(create=AsyncMock(side_effect=lambda **kwargs: Stream())), close=AsyncMock())


class PaidChatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 5
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = dict(CONFIG)
        self.client = model_client()
        self.chat = Conversations(self.root / 'chat', lambda: dict(self.config), lambda: self.client)
        self.item = self.chat.get(self.chat.create()['id'])
        self.bill_calls = []
        self.extra_databases = []

        async def control(config, request_id=None):
            self.assertEqual(config, self.config)
            self.bill_calls.append(request_id)
            if request_id:
                status = 'unknown' if self.item['status'] in ('failed', 'cancelled', 'interrupted') else 'settled'
                return {'request_id': request_id, 'price_version': VERSION, 'status': status,
                        'reserved_quota': 1000000, 'charged_quota': 99}
            return terms()

        self.chat.paid_control = AsyncMock(side_effect=control)
        self.reporter = patch('fault_report.report_fault', new=AsyncMock())
        self.reporter.start()

    async def asyncTearDown(self):
        tasks = list(self.chat.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.chat.close_reconciliation()
        self.chat.db.close()
        for database in self.extra_databases:
            database.close()
        self.reporter.stop()
        self.temp.cleanup()

    def request(self, text='你好', attachments=None, price_version=VERSION):
        return MessageRequest(request_id=uuid.uuid4().hex,
                              parent=self.item['messages'][-1]['id'] if self.item['messages'] else '',
                              text=text, attachments=attachments or [], price_version=price_version)

    async def turn(self, request=None):
        self.chat.start(self.item, request or self.request())
        await self.chat.tasks[self.item['id']]
        await asyncio.gather(*list(self.chat.background_billing_tasks.values()))
        await asyncio.sleep(0)

    def ledger(self, status='settled'):
        async def control(config, request_id=None):
            self.bill_calls.append(request_id)
            if request_id:
                return {'request_id': request_id, 'price_version': VERSION, 'billing_mode':'actual_usage_v1',
                        'status':status, 'reserved_quota':0, 'charged_quota':27540 if status == 'settled' else 0}
            return terms()
        self.chat.paid_control = AsyncMock(side_effect=control)

    def restart(self):
        self.chat.save(self.item)
        self.chat.db.close()
        self.chat = Conversations(self.root / 'chat', lambda: dict(self.config), lambda: self.client)
        self.item = self.chat.get(self.item['id'])

    async def test_incomplete_terminal_with_real_usage_keeps_reviewed_partial_and_settled_separately(self):
        self.ledger()
        self.client.responses.create.side_effect = lambda **kwargs: TerminalStream('已生成的部分回答。')
        await self.turn()
        answer = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(self.item['status'], 'partial')
        self.assertEqual(answer['status'], 'partial')
        self.assertEqual(answer['reason'], 'max_output_tokens')
        self.assertEqual(answer['text'], '已生成的部分回答。')
        self.assertEqual(answer['billing']['status'], 'settled')
        self.assertEqual(answer['billing']['charged_quota'], 27540)
        self.assertEqual(self.bill_calls, [None, answer['billing']['request_id']])
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertNotIn('private-', json.dumps(self.chat.public(self.item)))
        self.assertIsNone(self.item['chain'])
        self.restart()
        restored = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(restored, answer)

    async def test_reasoning_only_terminal_is_not_a_fake_answer_or_unknown_bill(self):
        self.ledger()
        self.client.responses.create.side_effect = lambda **kwargs: TerminalStream()
        await self.turn()
        answer = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(answer['status'], 'failed')
        self.assertEqual(answer['reason'], 'max_output_tokens')
        self.assertEqual(answer['text'], '')
        self.assertEqual(answer['billing']['status'], 'settled')
        self.assertIn('未形成可展示', self.item['stage'])
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertNotIn('private-', json.dumps(self.chat.public(self.item)))

    async def test_terminal_reason_is_allowlisted_and_unsafe_partial_is_reviewed_before_publication(self):
        self.ledger()
        self.client.responses.create.side_effect = lambda **kwargs: TerminalStream('我是豆包。', reason='private-provider-error')
        await self.turn()
        answer = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(answer['status'], 'partial')
        self.assertEqual(answer['reason'], 'unknown')
        self.assertNotIn('我是豆包', answer['text'])
        self.assertNotIn('private-provider', json.dumps(self.item))
        self.assertEqual(answer['billing']['status'], 'settled')

    async def test_failed_terminal_or_disconnected_stream_reconciles_without_claiming_a_completed_answer(self):
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted):
                self.item = self.chat.get(self.chat.create()['id'])
                self.bill_calls.clear()
                self.ledger()
                self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True) if interrupted else TerminalStream('不要展示失败响应内容', status='failed')
                before = self.client.responses.create.await_count
                await self.turn()
                answer = self.chat.public(self.item)['messages'][-1]
                self.assertEqual(answer['status'], 'failed')
                self.assertEqual(answer['text'], '')
                self.assertEqual(answer['billing']['status'], 'settled')
                self.assertEqual(self.bill_calls, [None, answer['billing']['request_id']])
                self.assertEqual(self.client.responses.create.await_count, before + 1)

    async def test_failed_reconciliation_keeps_unknown_and_blocks_new_send_and_manual_retry(self):
        self.client.responses.create.side_effect = lambda **kwargs: TerminalStream()
        async def unavailable(config, request_id=None):
            self.bill_calls.append(request_id)
            if request_id:
                raise HTTPException(503, 'fixed safe failure')
            return terms()
        self.chat.paid_control = AsyncMock(side_effect=unavailable)
        await self.turn()
        answer = self.item['messages'][-1]
        self.assertEqual(answer['billing']['status'], 'unknown')
        for retry in (False, True):
            with self.assertRaises(HTTPException):
                self.chat.start(self.item, self.request('继续'), retry=retry)
        self.assertEqual(self.bill_calls, [None, answer['billing']['request_id']])
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_review_failure_cannot_publish_partial_but_still_reconciles_original_charge(self):
        self.ledger()
        self.client.responses.create.side_effect = lambda **kwargs: TerminalStream('private-unreviewed-terminal')
        with patch.object(self.chat, 'review', side_effect=RuntimeError('private-review-error')):
            await self.turn()
            answer = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(answer['text'], '')
        self.assertEqual(answer['status'], 'failed')
        self.assertEqual(answer['billing']['status'], 'settled')
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertNotIn('private-', json.dumps(self.item))

    async def test_cancellation_reconciles_only_original_operation_without_regeneration(self):
        started, release = asyncio.Event(), asyncio.Event()
        class WaitingStream(Stream):
            async def __aiter__(stream):
                started.set()
                await release.wait()
                yield NS(type='response.output_text.delta', delta='never display')
        self.ledger()
        self.client.responses.create.side_effect = lambda **kwargs: WaitingStream()
        self.chat.start(self.item, self.request())
        await started.wait()
        await self.chat.stop(self.item)
        answer = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(answer['status'], 'cancelled')
        self.assertEqual(answer['reason'], 'interrupted')
        self.assertEqual(answer['text'], '')
        self.assertEqual(answer['billing']['status'], 'settled')
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_reconciliation_scope_change_cannot_apply_an_old_account_receipt(self):
        async def changed(config, request_id=None):
            self.bill_calls.append(request_id)
            if request_id:
                self.config.update(EXECUTION_SCOPE='b' * 64, CONFIG_REVISION=13)
                return {'request_id':request_id, 'price_version':VERSION, 'status':'settled', 'charged_quota':27540}
            return terms()
        self.chat.paid_control = AsyncMock(side_effect=changed)
        self.client.responses.create.side_effect = lambda **kwargs: TerminalStream('不要发布旧账户内容')
        await self.turn()
        answer = self.chat.public(self.item)['messages'][-1]
        # The reviewed answer was published under the original identity before
        # the background receipt changed accounts. That late receipt is ignored.
        self.assertEqual(answer['text'], '不要发布旧账户内容')
        self.assertEqual(answer['status'], 'partial')
        self.assertEqual(answer['billing']['status'], 'unknown')
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertNotIn('charged_quota', answer['billing'])

    async def test_account_change_during_review_still_blocks_publication_before_background_work(self):
        review = self.chat.review
        def changed(text):
            result = review(text)
            self.config.update(EXECUTION_SCOPE='b' * 64, CONFIG_REVISION=13)
            return result
        with patch.object(self.chat, 'review', side_effect=changed):
            await self.turn()
        answer = self.item['messages'][-1]
        self.assertEqual(answer['text'], '')
        self.assertEqual(answer['status'], 'failed')
        self.assertEqual(answer['billing']['status'], 'unknown')
        self.assertEqual(self.chat.background_billing_tasks, {})
        self.assertEqual(self.bill_calls, [None])
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_reviewed_answer_is_persisted_before_a_single_flight_background_bill_finishes(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def delayed(config, request_id=None):
            self.bill_calls.append(request_id)
            if request_id:
                started.set()
                await release.wait()
                return {'request_id':request_id, 'price_version':VERSION, 'status':'settled', 'charged_quota':99}
            return terms()
        self.chat.paid_control = AsyncMock(side_effect=delayed)
        self.chat.start(self.item, self.request())
        run = self.chat.tasks[self.item['id']]
        await started.wait()
        await run
        answer = self.item['messages'][-1]
        self.assertEqual(answer['status'], 'completed')
        self.assertEqual(answer['text'], '已收到这条文字。')
        self.assertEqual(answer['billing']['status'], 'unknown')
        saved = json.loads(self.chat.db.execute('SELECT data FROM conversations WHERE id=?', (self.item['id'],)).fetchone()[0])
        self.assertEqual(saved['messages'][-1]['text'], answer['text'])
        self.assertEqual(saved['status'], 'completed')
        self.chat.schedule_bill_reconciliation(self.item, answer, self.config)
        self.assertEqual(len(self.chat.background_billing_tasks), 1)
        manual = asyncio.create_task(self.chat.reconcile_bill(self.item, answer))
        await asyncio.sleep(0)
        self.assertEqual(self.bill_calls, [None, answer['billing']['request_id']])
        with self.assertRaises(HTTPException):
            self.chat.start(self.item, self.request('继续'))
        release.set()
        await asyncio.gather(manual, *list(self.chat.background_billing_tasks.values()))
        self.assertEqual(answer['billing']['status'], 'settled')
        self.assertEqual(answer['status'], 'completed')
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_shutdown_cancels_a_background_bill_without_changing_the_reviewed_answer(self):
        started, cancelled = asyncio.Event(), asyncio.Event()
        async def delayed(config, request_id=None):
            if request_id:
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
            return terms()
        self.chat.paid_control = AsyncMock(side_effect=delayed)
        self.chat.start(self.item, self.request())
        run = self.chat.tasks[self.item['id']]
        await started.wait()
        await run
        await self.chat.close_reconciliation()
        self.assertTrue(cancelled.is_set())
        self.assertEqual(self.chat.background_billing_tasks, {})
        self.assertEqual(self.chat.billing_tasks, {})
        answer = self.item['messages'][-1]
        self.assertEqual(answer['status'], 'completed')
        self.assertEqual(answer['billing']['status'], 'unknown')
        self.assertEqual(answer['text'], '已收到这条文字。')
        self.chat.schedule_bill_reconciliation(self.item, answer, self.config)
        self.assertEqual(self.chat.background_billing_tasks, {})
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.restart()
        self.ledger()
        self.chat.schedule_recovery()
        await self.chat.recovery_task
        restored = self.item['messages'][-1]
        self.assertEqual(restored['billing']['status'], 'settled')
        self.assertEqual(restored['status'], 'completed')
        self.assertEqual(restored['text'], '已收到这条文字。')
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_restart_recovers_only_original_ledger_in_background_and_never_lost_answer(self):
        self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True)
        await self.turn()
        original = self.item['messages'][-1]['billing']['request_id']
        self.restart()
        self.ledger()
        self.chat.schedule_recovery()
        self.chat.schedule_recovery()
        await self.chat.recovery_task
        answer = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(answer['billing']['request_id'], original)
        self.assertEqual(answer['billing']['status'], 'settled')
        self.assertEqual(answer['status'], 'failed')
        self.assertEqual(answer['text'], '')
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertEqual(self.chat.paid_control.await_count, 1)

    async def test_restart_foreign_scope_does_not_query_or_replace_original_bill(self):
        self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True)
        await self.turn()
        original = copy.deepcopy(self.item['messages'][-1]['billing'])
        self.restart()
        self.config.update(EXECUTION_SCOPE='b' * 64, CONFIG_REVISION=13)
        self.ledger()
        self.chat.schedule_recovery()
        await self.chat.recovery_task
        self.chat.paid_control.assert_not_awaited()
        self.assertEqual(self.item['messages'][-1]['billing'], original)
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_concurrent_status_refreshes_share_one_original_request_and_terminal_is_never_demoted(self):
        self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True)
        await self.turn()
        started, release = asyncio.Event(), asyncio.Event()
        answer = self.item['messages'][-1]
        async def delayed(config, request_id=None):
            started.set()
            await release.wait()
            return {'request_id':request_id, 'price_version':VERSION, 'status':'settled', 'charged_quota':27540}
        self.chat.paid_control = AsyncMock(side_effect=delayed)
        first = asyncio.create_task(self.chat.reconcile_bill(self.item, answer))
        second = asyncio.create_task(self.chat.reconcile_bill(self.item, answer))
        await started.wait()
        self.assertEqual(self.chat.paid_control.await_count, 1)
        release.set()
        await asyncio.gather(first, second)
        self.chat.paid_control = AsyncMock(side_effect=HTTPException(503, 'unavailable'))
        await self.chat.reconcile_bill(self.item, answer)
        self.assertEqual(answer['billing']['status'], 'settled')
        self.chat.paid_control.assert_not_awaited()
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_local_config_exposes_only_opaque_identity_even_if_cloud_billing_is_unavailable(self):
        control = AsyncMock(side_effect=HTTPException(402, 'insufficient balance'))
        app = self.billing_app(control)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as browser:
            response = await browser.get('/chat-api/config')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['confirmation_context'], confirmation_context(self.config))
        self.assertNotIn(self.config['EXECUTION_SCOPE'], response.text)
        control.assert_not_awaited()

    async def test_shutdown_blocks_new_reconciliation_and_cancels_only_owned_reads(self):
        self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True)
        await self.turn()
        await self.chat.close_reconciliation()
        control = AsyncMock()
        self.chat.paid_control = control
        with self.assertRaises(HTTPException):
            await self.chat.reconcile_bill(self.item, self.item['messages'][-1])
        self.chat.schedule_recovery()
        self.assertIsNone(self.chat.recovery_task)
        control.assert_not_awaited()

    async def test_original_bill_lookup_has_a_five_second_bound_and_timeout_keeps_unknown(self):
        self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True)
        await self.turn()
        answer = self.item['messages'][-1]
        original = copy.deepcopy(answer['billing'])
        self.ledger()
        async def expired(awaitable, timeout):
            self.assertEqual(timeout, 5)
            awaitable.close()
            raise asyncio.TimeoutError()
        with patch('chat.asyncio.wait_for', side_effect=expired):
            with self.assertRaises(asyncio.TimeoutError):
                await self.chat.reconcile_bill(self.item, answer)
        self.assertEqual(answer['billing'], original)
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_startup_recovery_queries_at_most_twenty_original_operations_once(self):
        self.item['status'] = 'failed'
        self.item['messages'] = [dict(id=uuid.uuid4().hex, role='assistant', text='', attachments=[], status='failed',
            billing_scope=CONFIG['EXECUTION_SCOPE'], billing={'request_id':uuid.uuid4().hex, 'price_version':VERSION, 'status':'unknown'}) for _ in range(25)]
        self.restart()
        self.ledger()
        self.chat.schedule_recovery()
        await self.chat.recovery_task
        self.chat.schedule_recovery()
        self.assertEqual(self.chat.paid_control.await_count, 20)
        self.assertEqual(sum(message['billing']['status'] == 'settled' for message in self.item['messages']), 20)
        self.assertEqual(sum(message['billing']['status'] == 'unknown' for message in self.item['messages']), 5)
        self.client.responses.create.assert_not_awaited()

    async def test_lifespan_does_not_wait_for_recovery_and_shutdown_cancels_pending_lookup(self):
        self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True)
        await self.turn()
        app = FastAPI()
        install_chat(app, self.root / 'chat', lambda: dict(self.config))
        recovered = app.state.chat
        self.extra_databases.append(recovered.db)
        entered, release = asyncio.Event(), asyncio.Event()
        async def delayed(config, request_id=None):
            entered.set()
            await release.wait()
        recovered.paid_control = AsyncMock(side_effect=delayed)
        async with app.router.lifespan_context(app):
            self.assertFalse(entered.is_set(), 'startup must return before the remote state lookup')
            await entered.wait()
            self.assertFalse(recovered.recovery_task.done())
        self.assertTrue(recovered.recovery_task.done())
        self.assertTrue(recovered.reconciliation_closed)
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_partial_history_is_reviewed_and_replayed_with_an_explicit_partial_label(self):
        self.ledger()
        self.client.responses.create.side_effect = lambda **kwargs: TerminalStream('这是已审查的部分回答。')
        await self.turn()
        self.client.responses.create.side_effect = lambda **kwargs: Stream()
        await self.turn(self.request('继续'))
        sent = self.client.responses.create.call_args.kwargs['input']
        self.assertEqual(sent[1], {'role':'assistant', 'content':'[上一轮仅生成了部分回答]\n这是已审查的部分回答。'})
        self.assertEqual(self.client.responses.create.await_count, 2)
        partial = self.item['messages'][1]
        partial['text'] = '我是豆包。'
        reviewed = self.chat.public(self.item)['messages'][1]
        self.assertEqual(reviewed['status'], 'partial')
        self.assertNotIn('我是豆包', reviewed['text'])

    async def test_empty_or_unreviewable_partial_history_never_fabricates_or_leaks_an_answer(self):
        self.ledger()
        self.client.responses.create.side_effect = lambda **kwargs: TerminalStream('已保存部分内容')
        await self.turn()
        original = copy.deepcopy(self.item['messages'][-1]['billing'])
        with patch.object(self.chat, 'review', side_effect=RuntimeError('private-review')):
            reviewed = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(reviewed['status'], 'failed')
        self.assertEqual(reviewed['text'], '')
        self.assertEqual(reviewed['billing'], original)
        self.item['status'] = 'partial'
        self.item['messages'][-1].update(status='partial', text='')
        empty = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(empty['status'], 'failed')
        self.assertEqual(empty['text'], '')
        self.assertEqual(empty['reason'], 'no_answer')

    async def test_concurrent_old_status_response_cannot_overwrite_a_new_terminal_receipt(self):
        self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True)
        await self.turn()
        answer = self.item['messages'][-1]
        started, release = asyncio.Event(), asyncio.Event()
        async def delayed(config, request_id=None):
            started.set()
            await release.wait()
            return {'request_id':request_id, 'price_version':VERSION, 'status':'unknown'}
        self.chat.paid_control = AsyncMock(side_effect=delayed)
        checking = asyncio.create_task(self.chat.reconcile_bill(self.item, answer))
        await started.wait()
        answer['billing'] = {**answer['billing'], 'status':'settled', 'charged_quota':27540}
        release.set()
        await checking
        self.assertEqual(answer['billing']['status'], 'settled')
        self.assertEqual(answer['billing']['charged_quota'], 27540)
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_free_capabilities_route_never_calls_paid_model_or_files(self):
        app = FastAPI()
        install_chat(app, self.root / 'route-chat', lambda: dict(self.config))
        exposed = app.state.chat
        exposed.paid_control = AsyncMock(return_value=terms())
        try:
            with patch('volcenginesdkarkruntime.AsyncArk', side_effect=AssertionError('free route must not construct a model')):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as browser:
                    response = await browser.get('/chat-api/capabilities')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {**terms(), 'confirmation_context': confirmation_context(self.config)})
            self.assertNotIn(self.config['EXECUTION_SCOPE'], response.text)
            exposed.paid_control.assert_awaited_once_with(self.config)
            self.client.responses.create.assert_not_awaited()
            self.client.files.create.assert_not_awaited()
        finally:
            exposed.db.close()

    async def test_missing_price_confirmation_rejects_before_any_model_or_control_request(self):
        with self.assertRaises(HTTPException) as caught:
            self.chat.start(self.item, self.request(price_version=''))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.item['messages'], [])
        self.chat.paid_control.assert_not_awaited()
        self.client.responses.create.assert_not_awaited()

    async def test_price_confirmation_context_blocks_account_or_revision_change_before_any_message_is_saved(self):
        original = dict(self.config)
        accepted = confirmation_context(original)
        for change in ({'EXECUTION_SCOPE':'b' * 64}, {'CONFIG_REVISION':13}):
            with self.subTest(change=change):
                self.config = {**original, **change}
                request = self.request().model_copy(update={'confirmation_context': accepted})
                before = copy.deepcopy(self.item)
                with self.assertRaises(HTTPException) as caught:
                    self.chat.start(self.item, request)
                self.assertEqual(caught.exception.status_code, 409)
                self.assertEqual(self.item, before)
                persisted = json.loads(self.chat.db.execute('SELECT data FROM conversations WHERE id=?', (self.item['id'],)).fetchone()[0])
                self.assertEqual(persisted['messages'], [])
                self.assertEqual(self.chat.tasks, {})
                self.chat.paid_control.assert_not_awaited()
                self.client.responses.create.assert_not_awaited()

    async def test_matching_confirmation_context_dispatches_once_and_is_not_forwarded_to_the_model(self):
        request = self.request().model_copy(update={'confirmation_context': confirmation_context(self.config)})
        await self.turn(request)
        self.assertEqual(self.item['status'], 'completed')
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.chat.start(self.item, request)
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertNotIn('confirmation_context', self.client.responses.create.call_args.kwargs)
        self.assertNotIn('confirmation_context', json.dumps(self.item))

    async def test_capability_context_cannot_come_from_a_late_old_account_response(self):
        async def changed(config, request_id=None):
            self.config.update(EXECUTION_SCOPE='b' * 64, CONFIG_REVISION=13)
            return terms()
        control = AsyncMock(side_effect=changed)
        app = self.billing_app(control)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as browser:
            response = await browser.get('/chat-api/capabilities')
        self.assertEqual(response.status_code, 409)
        self.assertNotIn('confirmation_context', response.json())
        self.client.responses.create.assert_not_awaited()

    async def test_malformed_explicit_confirmation_context_is_rejected_without_disclosing_request(self):
        app = self.billing_app(AsyncMock(return_value=terms()))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as browser:
            for value in ('', None, 'A' * 64, 'a' * 63, 'private-context-not-valid'):
                payload = self.request().model_dump()
                payload['confirmation_context'] = value
                response = await browser.post('/chat-api/sessions/' + self.item['id'] + '/messages', json=payload)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn('private-context', response.text)
        self.assertEqual(self.item['messages'], [])
        self.client.responses.create.assert_not_awaited()

    async def test_new_attachment_is_rejected_when_server_does_not_enable_files(self):
        with self.assertRaises(HTTPException) as caught:
            await self.chat.upload(self.item, b'synthetic document', 'fixture.txt')
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.item['media'], {})
        self.client.files.create.assert_not_awaited()
        self.client.responses.create.assert_not_awaited()

    async def test_historical_attachments_are_not_uploaded_when_server_does_not_enable_files(self):
        self.config['PIKNO_LLM_V2'] = False
        media = await self.chat.upload(self.item, b'synthetic document', 'fixture.txt')
        self.config['PIKNO_LLM_V2'] = True
        self.item['messages'] = [dict(id=uuid.uuid4().hex, role='user', text='旧附件', attachments=[media['id']], status='completed')]
        await self.turn(self.request('继续'))
        self.assertEqual(self.item['status'], 'failed')
        self.assertIn('未开放附件', self.item['stage'])
        self.assertEqual(self.item['messages'][-1]['billing']['status'], 'not_submitted')
        self.assertTrue(self.chat.path(self.item, self.item['media'][media['id']]).exists())
        self.client.files.create.assert_not_awaited()
        self.client.responses.create.assert_not_awaited()

    async def test_changed_price_never_constructs_or_submits_a_paid_model_request(self):
        self.chat.paid_control = AsyncMock(return_value={**terms(), 'price_version': 'chat-cny-new-v2'})
        await self.turn()
        self.assertEqual(self.item['status'], 'failed')
        self.assertIn('价格已变化', self.item['stage'])
        self.assertEqual(self.item['messages'][-1]['billing']['status'], 'not_submitted')
        self.client.responses.create.assert_not_awaited()
        self.assertEqual(self.chat.paid_control.await_count, 1)

    async def test_paid_sdk_headers_capture_original_operation_price_and_account_revision(self):
        self.chat.client_factory = None
        request = self.request()
        with patch('volcenginesdkarkruntime.AsyncArk', return_value=self.client) as constructor:
            await self.turn(request)
        self.assertEqual(self.item['status'], 'completed')
        args = constructor.call_args.kwargs
        self.assertEqual(args['base_url'], CONFIG['MODEL_AGENT_API_BASE'])
        self.assertEqual(args['max_retries'], 0)
        headers = args['http_client'].headers
        operation = hashlib.sha256(request.request_id.encode()).hexdigest()[:32]
        self.assertEqual(headers['X-PIKNO-Request-Id'], operation)
        self.assertEqual(headers['X-PIKNO-Price-Version'], VERSION)
        self.assertEqual(headers['X-Hamster-Execution-Scope'], CONFIG['EXECUTION_SCOPE'])
        self.assertEqual(headers['X-Hamster-Config-Revision'], str(CONFIG['CONFIG_REVISION']))
        self.assertEqual(self.item['messages'][-1]['billing']['request_id'], operation)
        self.assertEqual(self.bill_calls, [None, operation])

    async def test_paid_turns_replay_local_text_without_stored_remote_chain(self):
        await self.turn(self.request('第一条'))
        await self.turn(self.request('第二条'))
        calls = self.client.responses.create.call_args_list
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertNotIn('store', call.kwargs)
            self.assertTrue(call.kwargs['stream'])
            self.assertNotIn('previous_response_id', call.kwargs)
            self.assertNotIn('expire_at', call.kwargs)
            self.assertEqual(call.kwargs['max_output_tokens'], 2000)
        self.assertEqual([message['role'] for message in calls[1].kwargs['input']], ['user', 'assistant', 'user'])
        self.assertEqual(calls[1].kwargs['input'][0]['content'][-1]['text'], '第一条')
        self.assertEqual(calls[1].kwargs['input'][2]['content'][-1]['text'], '第二条')
        self.assertIsNone(self.item['chain'])
        self.assertNotIn('response_id', self.item['messages'][-1])
        self.client.files.create.assert_not_awaited()

    async def test_response_submission_error_becomes_unknown_and_cannot_be_retried(self):
        self.client.responses.create.side_effect = ConnectionError('synthetic-private-error')
        await self.turn()
        answer = self.item['messages'][-1]
        original = copy.deepcopy(answer['billing'])
        self.assertEqual(answer['status'], 'failed')
        self.assertEqual(original['status'], 'unknown')
        self.assertEqual(answer['text'], '')
        with self.assertRaises(HTTPException) as caught:
            self.chat.start(self.item, self.request(''), retry=True)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(answer['billing'], original)
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertEqual(self.bill_calls, [None, original['request_id']])
        self.assertNotIn('synthetic-private', json.dumps(self.chat.public(self.item)))

    async def test_reserved_bill_refresh_preserves_original_operation_and_blocks_manual_retry(self):
        self.client.responses.create.side_effect = ConnectionError('synthetic-private-error')
        await self.turn()
        original = copy.deepcopy(self.item['messages'][-1]['billing'])
        control = AsyncMock(return_value={**original, 'status': 'reserved', 'reserved_quota': 1000000})
        app = self.billing_app(control)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as browser:
            response = await browser.post('/chat-api/sessions/' + self.item['id'] + '/billing/' + original['request_id'], json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['messages'][-1]['billing']['status'], 'reserved')
        preserved = copy.deepcopy(self.item['messages'][-1]['billing'])
        with self.assertRaises(HTTPException) as caught:
            self.chat.start(self.item, self.request(''), retry=True)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.item['messages'][-1]['billing'], preserved)
        self.assertEqual(preserved['request_id'], original['request_id'])
        self.assertEqual(self.client.responses.create.await_count, 1)
        control.assert_awaited_once_with(self.config, original['request_id'])

    async def test_retry_of_an_empty_paid_conversation_is_a_safe_rejection(self):
        with self.assertRaises(HTTPException) as caught:
            self.chat.start(self.item, self.request(''), retry=True)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.item['messages'], [])
        self.chat.paid_control.assert_not_awaited()
        self.client.responses.create.assert_not_awaited()

    async def test_explicit_not_submitted_error_allows_only_a_new_user_confirmed_retry(self):
        rejection = RuntimeError('synthetic-private-rejection')
        rejection.body = {'error': 'safe rejection', 'code': 'llm_not_submitted',
                          'submission_state': 'not_submitted'}
        rejection.status_code = 400
        self.client.responses.create.side_effect = rejection
        await self.turn()
        original = copy.deepcopy(self.item['messages'][-1]['billing'])
        self.assertEqual(self.item['status'], 'failed')
        self.assertEqual(original['status'], 'not_submitted')
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertEqual(self.bill_calls, [None])

        self.client.responses.create.side_effect = lambda **kwargs: Stream()
        self.chat.start(self.item, self.request(''), retry=True)
        await self.chat.tasks[self.item['id']]
        await asyncio.gather(*list(self.chat.background_billing_tasks.values()))
        await asyncio.sleep(0)
        self.assertEqual(self.item['status'], 'completed')
        self.assertEqual(self.client.responses.create.await_count, 2)
        self.assertNotEqual(self.item['messages'][-1]['billing']['request_id'], original['request_id'])
        self.assertEqual(self.item['messages'][-1]['billing']['status'], 'settled')

    async def test_proven_rejection_has_its_own_state_and_requires_manual_price_confirmed_retry(self):
        rejection = RuntimeError('synthetic-private-rejection')
        rejection.body = {'error': 'safe rejection', 'code': 'llm_rejected_before_execution',
                          'submission_state': 'rejected_before_execution'}
        rejection.status_code = 503
        self.client.responses.create.side_effect = rejection
        await self.turn()
        original = copy.deepcopy(self.item['messages'][-1]['billing'])
        self.assertEqual(original['status'], 'rejected_before_execution')
        self.assertEqual(self.item['status'], 'failed')
        self.assertIn('未执行，未扣费', self.item['stage'])
        self.assertNotIn('未预占', self.item['stage'])
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertEqual(self.bill_calls, [None])
        with self.assertRaises(HTTPException):
            self.chat.start(self.item, self.request('', price_version=''), retry=True)
        self.assertEqual(self.item['messages'][-1]['billing'], original)
        self.client.responses.create.side_effect = lambda **kwargs: Stream()
        self.chat.start(self.item, self.request(''), retry=True)
        await self.chat.tasks[self.item['id']]
        await asyncio.gather(*list(self.chat.background_billing_tasks.values()))
        await asyncio.sleep(0)
        self.assertEqual(self.client.responses.create.await_count, 2)
        self.assertNotEqual(self.item['messages'][-1]['billing']['request_id'], original['request_id'])
        self.assertEqual(self.item['messages'][-1]['billing']['status'], 'settled')

    async def test_incomplete_or_mixed_rejection_evidence_remains_unknown_and_cannot_retry(self):
        for body in [
            {'code': 'llm_rejected_before_execution', 'submission_state': 'unknown'},
            {'code': 'llm_rejected_before_execution', 'submission_state': 'not_submitted'},
            {'code': 'llm_unknown', 'submission_state': 'rejected_before_execution'},
            {'code': 'llm_rejected_before_execution', 'error': {'submission_state': 'rejected_before_execution'}},
            {'error': {'code': 'llm_rejected_before_execution'}, 'submission_state': 'rejected_before_execution'},
        ]:
            with self.subTest(body=body):
                self.item = self.chat.get(self.chat.create()['id'])
                rejection = RuntimeError('synthetic-private-rejection')
                rejection.body, rejection.status_code = body, 502
                self.client.responses.create.side_effect = rejection
                before = self.client.responses.create.await_count
                await self.turn()
                self.assertEqual(self.item['messages'][-1]['billing']['status'], 'unknown')
                self.assertNotIn('未执行，未扣费', self.item['stage'])
                with self.assertRaises(HTTPException):
                    self.chat.start(self.item, self.request(''), retry=True)
                self.assertEqual(self.client.responses.create.await_count, before + 1)

    async def test_created_or_delta_event_cannot_be_overridden_by_later_rejection_evidence(self):
        for event_type in ('response.created', 'response.output_text.delta', 'response.in_progress'):
            with self.subTest(event_type=event_type):
                self.item = self.chat.get(self.chat.create()['id'])
                rejection = RuntimeError('synthetic-private-rejection')
                rejection.body = {'code': 'llm_rejected_before_execution', 'submission_state': 'rejected_before_execution'}
                rejection.status_code = 503
                class ConflictingStream(Stream):
                    async def __aiter__(stream):
                        yield NS(type=event_type, response=NS(id='private-created-id'), delta='')
                        raise rejection
                self.client.responses.create.side_effect = lambda **kwargs: ConflictingStream()
                before = self.client.responses.create.await_count
                await self.turn()
                self.assertEqual(self.item['messages'][-1]['billing']['status'], 'unknown')
                self.assertEqual(self.item['messages'][-1]['text'], '')
                self.assertEqual(self.client.responses.create.await_count, before + 1)
                with self.assertRaises(HTTPException):
                    self.chat.start(self.item, self.request(''), retry=True)

    async def test_late_rejection_after_account_switch_keeps_original_operation_unknown(self):
        original_request = self.request()
        original_operation = hashlib.sha256(original_request.request_id.encode()).hexdigest()[:32]

        async def changed(**kwargs):
            self.config.update(EXECUTION_SCOPE='b' * 64, CONFIG_REVISION=13)
            rejection = RuntimeError('synthetic-private-rejection')
            rejection.body = {'code': 'llm_rejected_before_execution', 'submission_state': 'rejected_before_execution'}
            rejection.status_code = 503
            raise rejection

        self.client.responses.create.side_effect = changed
        await self.turn(original_request)
        answer = self.chat.public(self.item)['messages'][-1]
        self.assertEqual(answer['text'], '')
        self.assertEqual(answer['billing']['request_id'], original_operation)
        self.assertEqual(answer['billing']['status'], 'unknown')
        self.assertIn('账户配置已变化', self.item['stage'])
        self.assertNotIn('未执行，未扣费', self.item['stage'])
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_stream_interruption_preserves_one_operation_and_never_auto_resubmits(self):
        self.client.responses.create.side_effect = lambda **kwargs: Stream(fail=True)
        await self.turn()
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertEqual(self.item['messages'][-1]['billing']['status'], 'unknown')
        self.assertEqual(self.item['messages'][-1]['text'], '')
        self.assertEqual(self.item['status'], 'failed')

    async def test_scope_switch_before_run_cannot_adopt_new_account_or_bill(self):
        self.chat.start(self.item, self.request())
        self.config.update(EXECUTION_SCOPE='b' * 64, CONFIG_REVISION=13)
        await self.chat.tasks[self.item['id']]
        self.client.responses.create.assert_not_awaited()
        self.chat.paid_control.assert_not_awaited()
        self.assertEqual(self.item['messages'][-1]['billing']['status'], 'not_submitted')
        self.assertIn('账户配置已变化', self.item['stage'])

    async def test_completed_output_fetches_actual_ledger_charge_and_exports_only_safe_bill_fields(self):
        async def control(config, request_id=None):
            self.bill_calls.append(request_id)
            if request_id:
                return {'request_id': request_id, 'price_version': VERSION, 'status': 'settled',
                        'reserved_quota': 1000000, 'charged_quota': 270,
                        'upstream_cost': 180, 'private_key': 'never-return-fixture', 'endpoint': 'private-fixture'}
            return terms()
        self.chat.paid_control = AsyncMock(side_effect=control)
        await self.turn()
        result = self.chat.public(self.item)
        bill = result['messages'][-1]['billing']
        self.assertEqual(set(bill), {'request_id', 'price_version', 'status', 'reserved_quota', 'charged_quota'})
        self.assertEqual(bill['status'], 'settled')
        self.assertEqual(bill['charged_quota'], 270)
        self.assertEqual(bill['reserved_quota'], 1000000)
        self.assertEqual(self.bill_calls, [None, bill['request_id']])
        for private in ('upstream_cost', 'private_key', 'endpoint', 'private-fixture', 'never-return'):
            self.assertNotIn(private, json.dumps(result))

    async def test_completed_output_with_unavailable_bill_is_not_reported_as_free_or_retried(self):
        async def control(config, request_id=None):
            if request_id:
                raise HTTPException(503, '账单待核对')
            return terms()
        self.chat.paid_control = AsyncMock(side_effect=control)
        await self.turn()
        bill = self.chat.public(self.item)['messages'][-1]['billing']
        self.assertEqual(self.item['status'], 'completed')
        self.assertEqual(bill['status'], 'unknown')
        self.assertNotIn('charged_quota', bill)
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_account_change_during_background_billing_cannot_replace_an_already_reviewed_answer(self):
        captured = []
        observed_during_bill_read = []

        async def control(config, request_id=None):
            if request_id:
                captured.append(request_id)
                observed_during_bill_read.append(self.chat.public(self.item)['messages'][-1])
                self.config.update(EXECUTION_SCOPE='b' * 64, CONFIG_REVISION=13)
                raise HTTPException(409, '账户已变化')
            return terms()

        self.chat.paid_control = AsyncMock(side_effect=control)
        request = self.request()
        original_operation = hashlib.sha256(request.request_id.encode()).hexdigest()[:32]
        await self.turn(request)
        answer = self.item['messages'][-1]
        self.assertEqual(captured, [original_operation])
        self.assertEqual(observed_during_bill_read[0]['text'], '已收到这条文字。')
        self.assertEqual(observed_during_bill_read[0]['status'], 'completed')
        self.assertEqual(self.item['status'], 'completed')
        self.assertEqual(answer['status'], 'completed')
        self.assertEqual(answer['text'], '已收到这条文字。')
        self.assertEqual(answer['billing']['request_id'], original_operation)
        self.assertEqual(answer['billing']['status'], 'unknown')
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertEqual(self.chat.paid_control.await_count, 2)
        self.assertNotIn('response_id', answer)
        self.assertIsNone(self.item['chain'])
        self.assertEqual(self.item['stage'], '回答已审查并保存到本地')
        self.assertEqual(self.item['execution_scope'], CONFIG['EXECUTION_SCOPE'])
        self.assertEqual(self.chat.public(self.item)['messages'][-1]['text'], '已收到这条文字。')

    async def test_actual_paid_control_uses_only_free_loopback_get_and_safe_response_fields(self):
        seen = []
        async def handler(request):
            seen.append(request)
            value = capability_wire() if request.url.path.endswith('/status') else {
                'request_id': 'd' * 32, 'price_version': VERSION, 'status': 'settled',
                'reserved_quota': 1000000, 'charged_quota': 271,
                'private_key': 'never-return-fixture', 'upstream_cost': 180}
            return httpx.Response(200, json=value)
        real_client = httpx.AsyncClient
        def local_client(**options):
            return real_client(transport=httpx.MockTransport(handler), **options)
        with patch('chat.httpx.AsyncClient', side_effect=local_client):
            safe_terms = await Conversations.paid_control(self.chat, self.config)
            safe_bill = await Conversations.paid_control(self.chat, self.config, 'd' * 32)
        self.assertEqual(safe_terms, terms())
        self.assertEqual(safe_bill['charged_quota'], 271)
        self.assertEqual([request.method for request in seen], ['GET', 'GET'])
        self.assertEqual([request.url.path for request in seen], ['/api/inference/status', '/api/inference/requests/' + 'd' * 32])
        for request in seen:
            self.assertEqual(request.url.host, '127.0.0.1')
            self.assertEqual(request.headers['X-Hamster-Execution-Scope'], self.config['EXECUTION_SCOPE'])
            self.assertEqual(request.headers['X-Hamster-Config-Revision'], str(self.config['CONFIG_REVISION']))
            self.assertNotIn('authorization', request.headers)
        self.assertNotIn('private', json.dumps(safe_terms) + json.dumps(safe_bill))
        self.client.responses.create.assert_not_awaited()

    async def test_actual_paid_control_rejects_stale_or_incomplete_billing_contract(self):
        real_client = httpx.AsyncClient
        for change in ({'billing_mode': None}, {'billing_mode': 'prepaid'}, {'billing': None},
                       {'billing': 'invalid'}, {'billing': {'allow_debt': False, 'one_inflight_per_user': True}},
                       {'billing': {'allow_debt': True, 'one_inflight_per_user': False}}):
            wire = {**capability_wire(), **change}
            def local_client(**options):
                return real_client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=wire)), **options)
            with self.subTest(change=change), patch('chat.httpx.AsyncClient', side_effect=local_client):
                with self.assertRaises(HTTPException) as caught:
                    await Conversations.paid_control(self.chat, self.config)
                self.assertEqual(caught.exception.status_code, 503)
        self.client.responses.create.assert_not_awaited()

    async def test_admission_flag_is_strictly_validated_by_the_actual_loopback_receipt_reader(self):
        real_client = httpx.AsyncClient
        base = {'request_id':'d' * 32, 'price_version':VERSION, 'status':'unknown',
                'billing_mode':'actual_usage_v1', 'admission_blocking':False}
        for change in ({}, {'admission_blocking':True}, {'admission_blocking':'false'},
                       {'admission_blocking':0}, {'admission_blocking':None},
                       {'billing_mode':'legacy'}, {'price_version':'chat-legacy-v1'},
                       {'status':'reserved'}, {'status':'dispatched'}):
            wire = {**base, **change}
            def local_client(**options):
                return real_client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=wire)), **options)
            with self.subTest(change=change), patch('chat.httpx.AsyncClient', side_effect=local_client):
                bill = await Conversations.paid_control(self.chat, self.config, base['request_id'])
            if not change:
                self.assertIs(bill['admission_blocking'], False)
            elif change == {'admission_blocking':True}:
                self.assertIs(bill['admission_blocking'], True)
            else:
                self.assertNotIn('admission_blocking', bill)
        self.client.responses.create.assert_not_awaited()

    async def test_server_nonblocking_unknown_allows_only_a_new_explicit_message_and_preserves_old_audit(self):
        self.client.responses.create.side_effect = ConnectionError('synthetic-private-error')
        await self.turn()
        answer = self.item['messages'][-1]
        original = copy.deepcopy(answer['billing'])
        receipt = {**original, 'billing_mode':'actual_usage_v1', 'admission_blocking':False}
        self.chat.paid_control = AsyncMock(return_value=receipt)
        await self.chat.reconcile_bill(self.item, answer)
        self.assertIs(self.chat.public(self.item)['messages'][-1]['billing']['admission_blocking'], False)
        self.assertEqual(answer['billing']['status'], 'unknown')
        with self.assertRaises(HTTPException):
            self.chat.start(self.item, self.request(''), retry=True)
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.ledger()
        self.client.responses.create.side_effect = lambda **kwargs: Stream()
        await self.turn(self.request('新的问题'))
        self.assertEqual(self.client.responses.create.await_count, 2)
        self.assertEqual(self.item['messages'][-1]['status'], 'completed')
        self.assertEqual(answer['billing'], receipt)
        self.assertNotEqual(answer['billing']['request_id'], self.item['messages'][-1]['billing']['request_id'])

    async def test_nonblocking_receipt_does_not_survive_a_scope_or_revision_change_without_revalidation(self):
        self.client.responses.create.side_effect = ConnectionError('synthetic-private-error')
        await self.turn()
        answer = self.item['messages'][-1]
        receipt = {**answer['billing'], 'billing_mode':'actual_usage_v1', 'admission_blocking':False}
        self.chat.paid_control = AsyncMock(return_value=receipt)
        await self.chat.reconcile_bill(self.item, answer)
        self.config['CONFIG_REVISION'] += 1
        self.assertNotIn('admission_blocking', self.chat.public(self.item)['messages'][-1]['billing'])
        with self.assertRaises(HTTPException):
            self.chat.start(self.item, self.request('继续'))
        await self.chat.reconcile_bill(self.item, answer)
        self.assertIs(self.chat.public(self.item)['messages'][-1]['billing']['admission_blocking'], False)
        self.config['EXECUTION_SCOPE'] = 'b' * 64
        self.assertNotIn('admission_blocking', self.chat.public(self.item)['messages'][-1]['billing'])
        with self.assertRaises(HTTPException):
            await self.chat.reconcile_bill(self.item, answer)
        with self.assertRaises(HTTPException):
            self.chat.start(self.item, self.request('继续'))
        self.assertEqual(answer['billing']['status'], 'unknown')
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_malformed_or_legacy_nonblocking_flags_cannot_unlock_generation_locally(self):
        self.client.responses.create.side_effect = ConnectionError('synthetic-private-error')
        await self.turn()
        answer = self.item['messages'][-1]
        base = {**answer['billing'], 'billing_mode':'actual_usage_v1', 'admission_blocking':False}
        answer['billing_admission_revision'] = self.config['CONFIG_REVISION']
        for change in ({'admission_blocking':'false'}, {'admission_blocking':0}, {'admission_blocking':None},
                       {'admission_blocking':True}, {'billing_mode':'legacy'}, {'price_version':'chat-legacy-v1'},
                       {'status':'reserved'}, {'status':'dispatched'}, {'status':'submitted'}):
            answer['billing'] = {**base, **change}
            with self.subTest(change=change), self.assertRaises(HTTPException):
                self.chat.start(self.item, self.request('继续'))
            self.assertIsNot(self.chat.public(self.item)['messages'][-1]['billing'].get('admission_blocking'), False)
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_final_actual_bill_is_not_capped_and_debt_blocks_followup_dispatch(self):
        async def control(config, request_id=None):
            if request_id:
                return {'request_id': request_id, 'price_version': VERSION, 'billing_mode': 'actual_usage_v1',
                        'status': 'settled', 'reserved_quota': 0, 'charged_quota': 25000000}
            if self.client.responses.create.await_count:
                raise HTTPException(402, '对话额度不足，请到 PIKNO 检查。')
            return terms()
        self.chat.paid_control = AsyncMock(side_effect=control)
        await self.turn()
        original = copy.deepcopy(self.chat.public(self.item)['messages'][-1]['billing'])
        self.assertEqual(original['billing_mode'], 'actual_usage_v1')
        self.assertEqual(original['charged_quota'], 25000000)
        self.assertEqual(original['reserved_quota'], 0)
        await self.turn(self.request('继续'))
        self.assertEqual(self.item['status'], 'failed')
        self.assertEqual(self.item['messages'][-1]['billing']['status'], 'not_submitted')
        self.assertEqual(self.client.responses.create.await_count, 1)
        self.assertEqual(self.chat.public(self.item)['messages'][-3]['billing'], original)

    async def test_actual_paid_control_rejects_foreign_base_or_bad_bill_identity_before_followup(self):
        for base in ('https://remote.invalid/api/inference/api/v3', 'http://127.0.0.1:12345/other',
                     'http://user:password@127.0.0.1:12345/api/inference/api/v3'):
            with patch('chat.httpx.AsyncClient', side_effect=AssertionError('invalid base must not send requests')):
                with self.assertRaises(HTTPException):
                    await Conversations.paid_control(self.chat, {**self.config, 'MODEL_AGENT_API_BASE': base})
        real_client = httpx.AsyncClient
        def local_client(**options):
            return real_client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
                'request_id': 'e' * 32, 'price_version': VERSION, 'status': 'settled', 'charged_quota': 1})), **options)
        with patch('chat.httpx.AsyncClient', side_effect=local_client):
            with self.assertRaises(HTTPException) as caught:
                await Conversations.paid_control(self.chat, self.config, 'd' * 32)
        self.assertEqual(caught.exception.status_code, 503)

    async def test_real_sdk_serialization_preserves_operation_headers_without_client_storage_controls(self):
        self.chat.client_factory = None
        seen = []
        async def handler(request):
            seen.append(request)
            events = [
                {'type': 'response.output_text.delta', 'delta': '已收到这条文字。'},
                {'type': 'response.completed', 'response': {
                    'id': 'resp-private-fixture', 'object': 'response', 'status': 'completed',
                    'created_at': int(time.time()), 'model': 'pikno-chat-standard',
                    'output': [{'id': 'msg-private-fixture', 'type': 'message', 'role': 'assistant',
                                'status': 'completed', 'content': [{'type': 'output_text', 'text': '已收到这条文字。', 'annotations': []}]}]}},
            ]
            content = ''.join('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n' for event in events) + 'data: [DONE]\n\n'
            return httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, content=content.encode())
        real_client = httpx.AsyncClient
        class LocalClient(real_client):
            def __init__(self, **options):
                super().__init__(transport=httpx.MockTransport(handler), **options)
        request = self.request()
        with patch('chat.httpx.AsyncClient', new=LocalClient):
            await self.turn(request)
        self.assertEqual(self.item['status'], 'completed')
        self.assertEqual(len(seen), 1)
        wire = json.loads(seen[0].content)
        self.assertEqual(seen[0].url.path, '/api/inference/api/v3/responses')
        self.assertEqual(seen[0].headers['X-PIKNO-Request-Id'], hashlib.sha256(request.request_id.encode()).hexdigest()[:32])
        self.assertEqual(seen[0].headers['X-PIKNO-Price-Version'], VERSION)
        self.assertEqual(seen[0].headers['X-Hamster-Execution-Scope'], CONFIG['EXECUTION_SCOPE'])
        self.assertEqual(wire['input'][0]['content'][0]['type'], 'input_text')
        self.assertEqual(wire['max_output_tokens'], 2000)
        # The pinned SDK may serialize omitted optional fields as JSON null.
        for field in ('store', 'expire_at', 'previous_response_id', 'tools'):
            self.assertIsNone(wire.get(field))

    def billing_app(self, control):
        app = FastAPI()
        install_chat(app, self.root / ('route-' + uuid.uuid4().hex), lambda: dict(self.config))
        exposed = app.state.chat
        exposed.items[self.item['id']] = self.item
        exposed.paid_control = control
        self.extra_databases.append(exposed.db)
        return app

    async def test_explicit_bill_refresh_only_checks_original_operation_without_generating_again(self):
        self.client.responses.create.side_effect = ConnectionError('synthetic-private-error')
        await self.turn()
        original = self.item['messages'][-1]['billing']['request_id']
        control = AsyncMock(return_value={'request_id': original, 'price_version': VERSION,
                                         'status': 'settled', 'reserved_quota': 1000000, 'charged_quota': 99})
        app = self.billing_app(control)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as browser:
            response = await browser.post('/chat-api/sessions/' + self.item['id'] + '/billing/' + original, json={})
            missing = await browser.post('/chat-api/sessions/' + self.item['id'] + '/billing/' + 'f' * 32, json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['messages'][-1]['billing']['charged_quota'], 99)
        self.assertEqual(response.json()['messages'][-1]['billing']['status'], 'settled')
        self.assertEqual(missing.status_code, 404)
        control.assert_awaited_once_with(self.config, original)
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_bill_refresh_refuses_changed_price_and_preserves_original_unknown_bill(self):
        self.client.responses.create.side_effect = ConnectionError('synthetic-private-error')
        await self.turn()
        original = copy.deepcopy(self.item['messages'][-1]['billing'])
        control = AsyncMock(return_value={**original, 'price_version': 'chat-new-v2', 'status': 'settled', 'charged_quota': 999})
        app = self.billing_app(control)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as browser:
            response = await browser.post('/chat-api/sessions/' + self.item['id'] + '/billing/' + original['request_id'], json={})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.item['messages'][-1]['billing'], original)
        self.assertEqual(self.client.responses.create.await_count, 1)

    async def test_old_account_bill_is_not_refreshed_under_a_new_account_scope(self):
        self.client.responses.create.side_effect = ConnectionError('synthetic-private-error')
        await self.turn()
        original = copy.deepcopy(self.item['messages'][-1]['billing'])
        self.config.update(EXECUTION_SCOPE='b' * 64, CONFIG_REVISION=13)
        control = AsyncMock(return_value={**original, 'status': 'settled', 'charged_quota': 999})
        app = self.billing_app(control)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as browser:
            response = await browser.post('/chat-api/sessions/' + self.item['id'] + '/billing/' + original['request_id'], json={})
        self.assertIn(response.status_code, (403, 409))
        control.assert_not_awaited()
        self.assertEqual(self.item['messages'][-1]['billing'], original)

    async def test_restart_changes_unfinished_dispatched_bill_to_unknown_and_blocks_retry(self):
        for status in ('reserved', 'dispatching', 'dispatched', 'submitted', 'unknown'):
            with self.subTest(status=status):
                self.item['status'] = 'running'
                self.item['messages'] = [
                    dict(id=uuid.uuid4().hex, role='user', text='fixture', attachments=[], status='completed'),
                    dict(id=uuid.uuid4().hex, role='assistant', text='', attachments=[], status='running',
                         billing={'request_id': 'd' * 32, 'price_version': VERSION, 'status': status}),
                ]
                self.chat.save(self.item)
                self.chat.db.close()
                self.chat = Conversations(self.root / 'chat', lambda: dict(self.config), lambda: self.client)
                self.item = self.chat.get(self.item['id'])
                self.assertEqual(self.item['status'], 'interrupted')
                self.assertEqual(self.item['messages'][-1]['billing']['status'], 'unknown')
                self.assertEqual(self.item['messages'][-1]['billing']['request_id'], 'd' * 32)
                self.assertIn('正在核对原请求状态', self.item['stage'])
                with self.assertRaises(HTTPException) as caught:
                    self.chat.start(self.item, self.request(''), retry=True)
                self.assertEqual(caught.exception.status_code, 409)
                self.client.responses.create.assert_not_awaited()

    def test_bill_display_hides_metadata_and_retains_safe_original_status_check(self):
        source = (Path(__file__).parent / 'chat-ui' / 'chat.js').read_text(encoding='utf-8')
        self.assertNotIn('对话账单：', source)
        self.assertNotIn('实际费用', source)
        self.assertNotIn('请求编号', source)
        self.assertNotIn('dataset.bill', source)
        self.assertIn('正在核对请求状态，请勿重复发送。', source)
        self.assertIn('核对状态', source)
        self.assertIn('parts.operation=msg.billing?.request_id', source)
        self.assertIn('reconcileBills({manual:true,requestId:parts.operation})', source)


class PaidStudioConfigurationTests(unittest.TestCase):
    def test_relay_v2_flag_uses_only_loopback_opaque_context_and_no_customer_key(self):
        environment = {'HAMSTER_CONFIG_PATH': '', 'HAMSTER_PIKNO_MODE': '1',
                       'MODEL_AGENT_API_KEY': 'hamster-cloud-session',
                       'MODEL_AGENT_API_BASE': CONFIG['MODEL_AGENT_API_BASE'], 'LLM_ENDPOINT_ID': 'hamster-auto'}
        with patch.dict(os.environ, environment, clear=True), patch('studio.relay_execution_context', return_value={
                'EXECUTION_SCOPE': CONFIG['EXECUTION_SCOPE'], 'CONFIG_REVISION': CONFIG['CONFIG_REVISION']}):
            value = configured_keys()
        self.assertIs(value['PIKNO_LLM_V2'], True)
        self.assertEqual(value['EXECUTION_SCOPE'], CONFIG['EXECUTION_SCOPE'])
        self.assertEqual(value['CONFIG_REVISION'], CONFIG['CONFIG_REVISION'])
        self.assertEqual(value['MODEL_AGENT_API_KEY'], 'hamster-cloud-session')
        self.assertNotIn('sk-', json.dumps(value))


if __name__ == '__main__':
    unittest.main()
