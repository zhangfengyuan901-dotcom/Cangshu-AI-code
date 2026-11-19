"""Explicit opt-in live probe. Key is read from process environment, never saved."""
import asyncio
import json
import logging
import os
import re
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'smart-video-agent'))
from creative import MODEL, Creative, Script, inspect_video
import creative
from volcenginesdkarkruntime import AsyncArk


async def main():
    logging.disable(logging.CRITICAL)
    key = os.environ['HAMSTER_LIVE_TEST_KEY']
    original_failure = creative.failure_details
    def capture_failure(exc, step):
        body = getattr(exc, 'body', {})
        error = body.get('error', body) if isinstance(body, dict) else {}
        message = str(error.get('message', ''))[:1500].replace(key, '[REDACTED]')
        message = re.sub(r'account\s+\d+', 'account [REDACTED]', message)
        print(json.dumps({'upstream_code':error.get('code'), 'param':error.get('param'), 'message':message}, ensure_ascii=False))
        return original_failure(exc, step)
    creative.failure_details = capture_failure
    client = AsyncArk(api_key=key, base_url='https://ark.cn-beijing.volces.com/api/v3', max_retries=0, timeout=60)
    try:
        if len(sys.argv) > 1:
            with tempfile.TemporaryDirectory(prefix='hamster-live-creative-') as directory:
                root = Path(directory)
                service = Creative(root/'data', root/'result', lambda:{'MODEL_AGENT_API_KEY':key})
                path = Path(sys.argv[1])
                media = await service.store_media(path.read_bytes(), 'video/mp4', 'test-video.mp4')
                item = dict(id=uuid.uuid4().hex, source=media['id'], name='test-video.mp4', stage='准备拆解', script=None, result=None)
                async def operation():
                    return await service.analyze(item)
                service.start(item, operation)
                await service.tasks[item['id']]
                report = {k:item.get(k) for k in ('status','stage','failure','cleanup_warning','video','script','usage')}
                report_path = Path(__file__).resolve().parent.parent/'output'/'creative-live-report.json'
                report_path.parent.mkdir(parents=True, exist_ok=True)
                report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps({k:v for k,v in report.items() if k != 'script'}, ensure_ascii=False))
                print(json.dumps({'report':str(report_path),'shots':len((item.get('script') or {}).get('shots',[]))}, ensure_ascii=False))
            return
        result = await client.responses.create(model=os.getenv('HAMSTER_CREATIVE_MODEL',MODEL), input='只回复 OK', max_output_tokens=32, store=False,
                                               thinking={'type':'disabled'})
        print(json.dumps({'ok':True, 'status':result.status, 'usage':result.usage.model_dump() if result.usage else None}, ensure_ascii=False))
    except Exception as exc:
        body = getattr(exc, 'body', {})
        error = body.get('error', body) if isinstance(body, dict) else {}
        message = re.sub(r'account\s+\d+', 'account [REDACTED]', str(error.get('message', ''))[:1500].replace(key, '[REDACTED]'))
        print(json.dumps({'ok':False,'http':getattr(exc,'status_code',None), 'code':error.get('code'),
                          'param':error.get('param'), 'message':message}, ensure_ascii=False))
    finally:
        await client.close()


if __name__ == '__main__':
    asyncio.run(main())
