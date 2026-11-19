"""Regression coverage for tolerant, non-blocking creative output handling."""
import json
import unittest
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch
from creative_result import Script, Draft, display_result
import test_creative


class DisplayTests(unittest.TestCase):
    def test_missing_fields_and_plain_text(self):
        self.assertEqual(display_result('{"summary":"只有摘要"}', Script).summary, '只有摘要')
        self.assertEqual(display_result('这是一份文字分析。', Script).summary, '这是一份文字分析。')
        self.assertEqual(display_result('文字改编', Draft).direction, '文字改编')

    def test_partial_json_and_nonstandard_field_types(self):
        value=display_result('{"summary":"分析中", "shots":[{"action":"转身"},', Script)
        self.assertEqual(value.summary,'分析中')
        self.assertEqual(value.shots[0].action,'转身')
        value=display_result(json.dumps({'shots':{'start':'00:03','end':-1,'characters':'unknown','scene':'X','dialogue_source':'音轨'},'characters':None}),Script)
        self.assertEqual(value.shots[0].start,3)
        self.assertEqual(value.shots[0].end,-1)
        self.assertEqual(value.shots[0].characters,['unknown'])
        self.assertEqual(value.shots[0].dialogue_source,'音轨')
        self.assertEqual(value.characters,[])

    def test_fences_prose_arrays_empty_and_nonfinite(self):
        for raw in ('```json\n{"summary":"a"}\n```','说明：{"summary":"a"} 后续说明'):
            self.assertEqual(display_result(raw,Script).summary,'a')
        for raw in ('{}','[]','null','{"unexpected":1}','JSON 未完成 {'):
            self.assertTrue(display_result(raw,Script).summary)
        self.assertEqual(display_result('{"shots":[{"start":"NaN","end":"Infinity"}]}',Script).shots[0].start,0)

    def test_schema_preamble_does_not_replace_the_actual_result(self):
        schema=json.dumps(Script.model_json_schema(),ensure_ascii=False)
        actual=json.dumps({'summary':'真正结果','shots':[{'start':0,'end':1,'action':'展示'}]},ensure_ascii=False)
        value=display_result('字段说明：\n'+schema+'\n分析结果：\n'+actual,Script)
        self.assertEqual(value.summary,'真正结果')
        self.assertEqual(value.shots[0].action,'展示')

    def test_no_role_time_or_source_validation(self):
        value=Script.model_validate({'shots':[{'start':12,'end':2,'scene':'not-in-table','characters':['C404'],'dialogue_source':'音轨'}, {'start':-5,'end':9999}]})
        self.assertEqual(value.shots[0].end,2)
        self.assertEqual(value.shots[1].end,9999)
        self.assertEqual(Draft.model_validate({'shots':[{'start':10,'end':-2,'content':'@图片99'}]}).shots[0].end,-2)


class ResponseTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_creative.CreativeTests.asyncSetUp
    asyncTearDown = test_creative.CreativeTests.asyncTearDown
    async def test_nonstandard_results_are_saved_and_restored_without_failure(self):
        from creative import Creative
        cases=[('completed','纯文字分析 <script>alert(1)</script>'),
               ('incomplete','{"summary":"部分分析", "shots":[{"start":30,"end":-1,"scene":"unknown","dialogue_source":"音轨"},'),
               ('completed','{"shots":[{"start":2,"end":999,"characters":["C404"]}]}')]
        for status,raw in cases:
            sheet=self.root/'response-sheet.jpg';sheet.write_bytes(b'jpeg')
            client=NS(files=NS(create=AsyncMock(return_value=NS(id='file-test')),wait_for_processing=AsyncMock(return_value=NS(status='active')),delete=AsyncMock()), responses=NS(create=AsyncMock(return_value=NS(status=status,usage=None,output=[NS(type='message',content=[NS(type='output_text',text=raw)])]))),close=AsyncMock())
            self.c.upload_object=AsyncMock(side_effect=lambda data,mime,name,ttl=None: 'https://media.example/video.mp4' if mime.startswith('video/') else 'https://media.example/contact.jpg')
            self.c.delete_urls=AsyncMock()
            with patch('volcenginesdkarkruntime.AsyncArk',return_value=client), patch('creative.build_contact_sheets',return_value=({'duration':1,'sampled_frames':8},[sheet])):
                await self.c.execute(self.item,lambda:self.c.analyze(self.item))
            self.assertEqual(self.item['status'],'success')
            self.assertEqual(self.item['analysis_text'],raw)
            self.assertEqual(self.item['response_incomplete'],status=='incomplete')
            recovered=Creative(self.c.directory,self.c.output,self.c.keys)
            self.assertEqual(recovered.get(self.item['id'])['analysis_text'],raw)
            client.files.delete.assert_awaited_once_with('file-test')

    async def test_empty_output_is_still_an_error(self):
        client=NS(files=NS(delete=AsyncMock()), responses=NS(create=AsyncMock(return_value=NS(status='completed',usage=None,output=[]))),close=AsyncMock())
        with patch('volcenginesdkarkruntime.AsyncArk',return_value=client):
            with self.assertRaises(RuntimeError): await self.c.ask(self.item,'分析',Script)

    async def test_doubao_endpoint_blocks_are_saved_and_parsed(self):
        raw=json.dumps({'summary':'接入点返回成功'},ensure_ascii=False)
        response=NS(id='resp_20260917Endpoint123',status='completed',usage=None,
                    output=[NS(type='doubao_app_call',blocks=[NS(type='output_text',text=raw)])])
        client=NS(files=NS(delete=AsyncMock()),responses=NS(create=AsyncMock(return_value=response)),close=AsyncMock())
        with patch('volcenginesdkarkruntime.AsyncArk',return_value=client):
            value=await self.c.ask(self.item,'分析',Script)
        self.assertEqual(value.summary,'接入点返回成功')
        self.assertEqual(self.item['analysis_text'],raw)
        self.assertEqual(self.item['model_response_id'],'resp_20260917Endpoint123')


if __name__=='__main__': unittest.main()
