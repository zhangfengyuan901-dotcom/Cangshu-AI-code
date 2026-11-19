"""Opt-in minimal live probe for Ark video input. Never prints credentials."""
import asyncio
import json
import os
import re
import sys
import tempfile
import uuid
from pathlib import Path

import httpx
from volcenginesdkarkruntime import AsyncArk


def safe_error(exc):
    body = getattr(exc, 'body', None)
    error = body.get('error', body) if isinstance(body, dict) else {}
    if not isinstance(error, dict):
        error = {}
    message = re.sub(r'https?://\S+', '[URL]', str(error.get('message', '')))[:500]
    return {
        'http': getattr(exc, 'status_code', None),
        'code': error.get('code') or getattr(exc, 'code', None),
        'param': error.get('param'),
        'message': message,
        'request_id': getattr(exc, 'request_id', None),
    }


async def main():
    video = Path(sys.argv[1]).resolve()
    config_path = Path(os.getenv('APPDATA', '')) / 'hamster-ai' / 'config.json'
    config = json.loads(config_path.read_text(encoding='utf-8'))
    key = str(config.get('llmApiKey', '')).strip()
    model = str(config.get('llmEndpointId') or config.get('creativeEndpointId') or 'doubao-seed-2-0-lite-260428').strip()
    media_endpoint = str(config.get('mediaUploadEndpoint') or 'https://media.hamsterai.cc/v1/upload').strip()
    if not video.is_file() or not key:
        raise SystemExit('video or configured model key is missing')

    if '--full' in sys.argv[2:]:
        await full_probe(video, config, key, model, media_endpoint)
        return

    remote_url = ''
    remote_file = None
    client = AsyncArk(api_key=key, base_url='https://ark.cn-beijing.volces.com/api/v3', timeout=600, max_retries=0)
    try:
        data = video.read_bytes()
        async with httpx.AsyncClient(timeout=180) as http:
            response = await http.post(
                media_endpoint,
                params={'fileName': video.name, 'ttl': 900},
                headers={
                    'X-Hamster-Client': 'hamster-desktop-v1',
                    'Content-Type': 'video/mp4',
                    'Content-Length': str(len(data)),
                },
                content=data,
            )
            response.raise_for_status()
            remote_url = response.json()['file']['url']
            head = await http.head(remote_url)
            print(json.dumps({'r2': {'status': head.status_code, 'bytes': int(head.headers.get('content-length', 0))}}))

        prompt = '只用一句话描述这段视频画面中可见的主要动作，不分析声音。'
        try:
            response = await client.responses.create(
                model=model,
                input=[{'role': 'user', 'content': [
                    {'type': 'input_video', 'video_url': remote_url},
                    {'type': 'input_text', 'text': prompt},
                ]}],
                store=False,
                thinking={'type': 'enabled'},
            )
            text = getattr(response, 'output_text', '') or ''
            print(json.dumps({'variant': 'r2_video_url_no_fps', 'ok': True, 'status': response.status,
                              'response_id': getattr(response, 'id', ''), 'text_chars': len(text)}, ensure_ascii=False))
            return
        except Exception as exc:
            print(json.dumps({'variant': 'r2_video_url_no_fps', 'ok': False, **safe_error(exc)}, ensure_ascii=False))

        with video.open('rb') as handle:
            remote_file = await client.files.create(
                file=handle,
                purpose='user_data',
                preprocess_configs={'video': {'fps': 2}},
            )
        ready = await client.files.wait_for_processing(remote_file.id, poll_interval=2, max_wait_seconds=180)
        response = await client.responses.create(
            model=model,
            input=[{'role': 'user', 'content': [
                {'type': 'input_video', 'file_id': remote_file.id},
                {'type': 'input_text', 'text': prompt},
            ]}],
            store=False,
            thinking={'type': 'enabled'},
        )
        text = getattr(response, 'output_text', '') or ''
        print(json.dumps({'variant': 'ark_file_id', 'ok': True, 'file_status': ready.status,
                          'status': response.status, 'response_id': getattr(response, 'id', ''),
                          'text_chars': len(text)}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'variant': 'ark_file_id', 'ok': False, **safe_error(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        if remote_file is not None:
            try:
                await client.files.delete(remote_file.id)
            except Exception:
                pass
        if remote_url:
            try:
                async with httpx.AsyncClient(timeout=30) as http:
                    await http.request('DELETE', new_url(media_endpoint, '/v1/objects'),
                                       headers={'X-Hamster-Client': 'hamster-desktop-v1'},
                                       json={'urls': [remote_url]})
            except Exception:
                pass
        await client.close()


def new_url(value, path):
    origin = httpx.URL(value)
    return str(origin.copy_with(path=path, query=None))


async def full_probe(video, config, key, model, media_endpoint):
    root = Path(tempfile.mkdtemp(prefix='hamster-creative-full-probe-'))
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'smart-video-agent'))
    from creative import Creative

    service = Creative(root / 'data', root / 'output', lambda: {
        'MODEL_AGENT_API_KEY': key,
        'LLM_ENDPOINT_ID': model,
    })

    async def upload_object(data, mime, name, ttl=None):
        async with httpx.AsyncClient(timeout=180) as http:
            response = await http.post(
                media_endpoint,
                params={'fileName': name, **({'ttl': ttl} if ttl else {})},
                headers={
                    'X-Hamster-Client': 'hamster-desktop-v1',
                    'Content-Type': mime,
                    'Content-Length': str(len(data)),
                },
                content=data,
            )
            response.raise_for_status()
            return response.json()['file']['url']

    async def delete_urls(urls):
        async with httpx.AsyncClient(timeout=30) as http:
            response = await http.request(
                'DELETE', new_url(media_endpoint, '/v1/objects'),
                headers={'X-Hamster-Client': 'hamster-desktop-v1'},
                json={'urls': urls},
            )
            response.raise_for_status()

    service.upload_object = upload_object
    service.delete_urls = delete_urls
    media = await service.store_media(video.read_bytes(), 'video/mp4', video.name)
    item = {
        'id': uuid.uuid4().hex,
        'source': media['id'],
        'source_hash': media['sha256'],
        'name': video.name,
        'analysis_mode': 'precise',
        'analysis_version': 5,
        'stage': '准备拆解',
        'status': 'running',
        'script': None,
        'result': None,
    }
    await service.execute(item, lambda: service.analyze(item))
    report = {
        'ok': item.get('status') == 'success',
        'status': item.get('status'),
        'stage': item.get('stage'),
        'failure': item.get('failure'),
        'response_id': item.get('model_response_id'),
        'response_status': item.get('model_response_status'),
        'transport': item.get('source_transport'),
        'thinking': item.get('thinking_mode'),
        'analysis_chars': len(item.get('analysis_text', '')),
        'shots': len((item.get('script') or {}).get('shots', [])),
        'dimensions': sorted((item.get('script') or {}).get('shots', [{}])[0])
            if (item.get('script') or {}).get('shots') else [],
        'cleanup_warning': item.get('cleanup_warning'),
        'probe_dir': str(root),
    }
    print(json.dumps(report, ensure_ascii=False))
    if not report['ok'] or not report['analysis_chars'] or not report['shots']:
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
