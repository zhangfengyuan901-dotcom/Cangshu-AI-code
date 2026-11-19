"""Local reference-video analysis and asset-aware prompt drafting. No video generation."""
import asyncio
import hashlib
import json
import math
import os
import re
import time
import uuid
from pathlib import Path
from typing import Literal

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from creative_prompt import analysis_prompt, adaptation_prompt
from creative_result import Script, Draft, display_result

ROOT = Path(__file__).resolve().parent
MODEL = 'doubao-seed-2-0-lite-260428'
ANALYSIS_VERSION = 5
REMOTE_REUSE_SECONDS = 50 * 60
MAX_REVERSE_VIDEO_SECONDS = 60.0
PROMPT_SEGMENT_SECONDS = 15.0

STEPS = {'inspect':'读取视频', 'sample_video':'读取原片与镜头证据', 'upload_r2':'上传 R2 原片与证据', 'upload_video':'上传视频',
         'parse_video':'解析视频', 'inference':'请求智能分析',
         'validate':'整理分析结果'}


class EmptyModelOutput(RuntimeError):
    """The upstream request completed but did not expose any usable output text."""


def member(value, name, default=None):
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def response_text(response):
    """Read output text from standard Responses items and Doubao endpoint blocks."""
    parts = []

    def visit(value):
        if member(value, 'type') == 'output_text':
            text = member(value, 'text', '')
            if isinstance(text, str):
                parts.append(text)
            return
        for key in ('content', 'blocks'):
            children = member(value, key, ()) or ()
            if isinstance(children, (list, tuple)):
                for child in children:
                    visit(child)

    for output in member(response, 'output', ()) or ():
        visit(output)
    if not parts:
        fallback = member(response, 'output_text', '')
        if isinstance(fallback, str):
            parts.append(fallback)
    return ''.join(parts)


def failure_details(exc, step):
    """Translate known upstream failures; never expose raw messages, accounts or keys."""
    body = getattr(exc, 'body', None)
    error = body.get('error', body) if isinstance(body, dict) else {}
    if not isinstance(error, dict): error = {}
    code = error.get('code') or getattr(exc, 'code', None)
    http = getattr(exc, 'status_code', None)
    unsupported_content = code == 'InvalidParameter' and error.get('param') == 'input.content' and 'content type is not supported' in str(error.get('message', ''))
    cases = {
        'ModelNotOpen': ('MODEL_NOT_ENABLED', '当前密钥所属账户未开通本功能指定的模型版本。开通其他多模态模型并不等于已开通本版本，请联系管理员核对模型开通管理。'),
        'InvalidApiKey': ('AUTH_FAILED', '智能密钥无效或已失效，请在主应用账户页重新配置。'),
        'AuthenticationError': ('AUTH_FAILED', '智能密钥认证失败，请检查是否已撤销或复制不完整。'),
        'PermissionDenied': ('PERMISSION_DENIED', '当前密钥没有访问此服务的权限，请核对密钥所属项目和授权范围。'),
        'InvalidEndpointOrModel.NotFound': ('MODEL_NOT_FOUND', '智能服务当前不可用，请联系管理员检查云端配置。'),
        'QuotaExceeded': ('QUOTA_EXCEEDED', '智能服务额度不足，请检查账户可用额度后重试。'),
    }
    if isinstance(exc, EmptyModelOutput):
        public_code, message = 'OUTPUT_EMPTY', '智能服务已响应，但没有返回可用的分析正文。请重新拆解；若持续出现，请联系管理员检查云端配置。'
    elif unsupported_content:
        public_code, message = 'CONTENT_TYPE_UNSUPPORTED', '智能服务暂不支持本次输入的素材类型，请联系管理员检查云端能力配置。'
    elif isinstance(code, str) and code in cases:
        public_code, message = cases[code]
    elif http == 401:
        public_code, message = 'AUTH_FAILED', '智能密钥认证失败，请重新配置有效密钥。'
    elif http == 403:
        public_code, message = 'PERMISSION_DENIED', '当前密钥无权访问此资源，请检查所属项目和模型授权。'
    elif http == 404:
        public_code, message = 'RESOURCE_NOT_FOUND', '当前步骤所需的云端资源或临时素材不可用，请复制诊断信息联系支持。'
    elif http == 429:
        public_code, message = 'RATE_OR_QUOTA_LIMIT', '请求达到频率、并发或额度限制，请检查额度后稍后重试。'
    elif http == 400 or http == 422:
        public_code, message = 'INPUT_REJECTED', '智能服务不接受本次参数或素材格式，请检查视频或图片格式。'
    elif isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)) or type(exc).__name__ == 'ArkAPITimeoutError':
        public_code, message = 'REQUEST_TIMEOUT', '当前步骤等待超时；不会自动重复提交，请稍后主动重试。'
    elif isinstance(exc, httpx.TransportError) or type(exc).__name__ == 'ArkAPIConnectionError':
        public_code, message = 'CONNECTION_FAILED', '无法连接智能服务，请检查网络、代理或证书设置。'
    elif isinstance(exc, ValueError):
        public_code = 'MEDIA_INVALID' if step == 'inspect' else 'OUTPUT_INVALID'
        message = '视频无法读取或超过1分钟，请检查素材。' if step == 'inspect' else '本次操作未完成，请检查所选素材后重试。'
    elif isinstance(http, int) and http >= 500:
        public_code, message = 'SERVICE_UNAVAILABLE', '智能服务暂时异常，请稍后重试。'
    else:
        public_code, message = 'ANALYSIS_FAILED', '本次分析未完成，请复制诊断信息联系支持；不会自动重复提交。'
    request_id = getattr(exc, 'request_id', None)
    # SDK request IDs are opaque tracing identifiers, never the raw exception text.
    request_id = request_id if isinstance(request_id, str) and re.fullmatch(r'[a-zA-Z0-9_-]{12,128}', request_id) else ''
    return dict(code=public_code, message=message, step=STEPS.get(step, '处理任务'),
                http_status=http if isinstance(http, int) and 400 <= http <= 599 else None,
                request_id=request_id)


class Binding(BaseModel):
    target: str
    media: str = Field(pattern=r'^[a-f0-9]{32}$')


class AnalyzeRequest(BaseModel):
    mode: Literal['fast', 'precise'] = 'precise'


class Adapt(BaseModel):
    script: Script
    bindings: list[Binding] = Field(default_factory=list, max_length=9)
    notes: str = Field(default='', max_length=3000)
    reference_motion: bool = True


def inspect_video(source):
    from moviepy import VideoFileClip
    with VideoFileClip(str(source), audio=False) as clip:
        duration = float(clip.duration)
        if not 0 < duration <= MAX_REVERSE_VIDEO_SECONDS:
            raise ValueError('请使用 1 分钟以内的参考视频')
        return dict(duration=duration)


def plan_generation_segments(duration):
    """Split a source timeline into deterministic 15-second generation jobs."""
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        raise ValueError('视频时长无效')
    if not math.isfinite(duration) or not 0 < duration <= MAX_REVERSE_VIDEO_SECONDS:
        raise ValueError('请使用 1 分钟以内的参考视频')
    duration = round(duration, 3)
    segments = []
    start = 0.0
    while start < duration:
        end = min(round(start + PROMPT_SEGMENT_SECONDS, 3), duration)
        segments.append(dict(index=len(segments) + 1, start=start, end=end,
                             duration=round(end - start, 3)))
        start = end
    return segments


def format_seconds(value):
    return f'{value:g}'


def segment_draft_timeline(draft, segment):
    """Project the complete adapted timeline into one local-time production window."""
    lines = []
    for shot in draft.shots:
        start = max(shot.start, segment['start'])
        end = min(shot.end, segment['end'])
        content = shot.content.strip()
        if end <= start or not content:
            continue
        local_start = round(start - segment['start'], 3)
        local_end = round(end - segment['start'], 3)
        lines.append(f'{format_seconds(local_start)}–{format_seconds(local_end)}秒：{content}')
    if lines:
        return '\n'.join(lines)
    fallback = draft.direction.strip() or '按原片对应区间还原动作、构图与运镜。'
    return f"0–{format_seconds(segment['duration'])}秒：{fallback}"


def compile_segment_prompts(draft, segments, allowed, reference_motion):
    """Compile independent, locally-timed prompts even if model timestamps drift."""
    prompts = []
    for segment in segments:
        timeline = clean_reference_tags(segment_draft_timeline(draft, segment), allowed)
        reference = ''
        if reference_motion and '@视频1' in allowed:
            interval = (f"的{format_seconds(segment['start'])}–{format_seconds(segment['end'])}秒"
                        if len(segments) > 1 else '')
            reference = f'动作与运镜参考@视频1{interval}。\n'
        prompt = reference + timeline
        prompts.append(dict(**segment, prompt=prompt))
    return prompts


def clean_reference_tags(text, allowed):
    return re.sub(r'@图片\d+|@视频1', lambda match: match.group(0) if match.group(0) in allowed
                  else ('文字设定' if match.group(0).startswith('@图片') else '原片脚本'), text or '')


def build_contact_sheets(source, directory, prefix):
    """Extract timestamped navigation evidence to cross-check the full video."""
    from moviepy import VideoFileClip
    from PIL import Image, ImageDraw
    paths = []
    with VideoFileClip(str(source), audio=False) as clip:
        duration = float(clip.duration)
        if not 0 < duration <= MAX_REVERSE_VIDEO_SECONDS:
            raise ValueError('请使用 1 分钟以内的参考视频')
        count = min(24, max(8, math.ceil(duration / 6)))
        times = [min(max(duration - 0.01, 0), duration * index / max(count - 1, 1)) for index in range(count)]
        frames = []
        for moment in times:
            image = Image.fromarray(clip.get_frame(moment)).convert('RGB')
            image.thumbnail((320, 180))
            cell = Image.new('RGB', (320, 206), '#151a17')
            cell.paste(image, ((320 - image.width) // 2, 26 + (180 - image.height) // 2))
            draw = ImageDraw.Draw(cell)
            draw.text((10, 7), f'{moment:.2f}s', fill='white')
            frames.append(cell)
    for offset in range(0, len(frames), 6):
        group = frames[offset:offset + 6]
        sheet = Image.new('RGB', (960, 412), '#151a17')
        for index, frame in enumerate(group):
            sheet.paste(frame, ((index % 3) * 320, (index // 3) * 206))
        path = Path(directory) / f'{prefix}-contact-{offset // 6 + 1}.jpg'
        sheet.save(path, format='JPEG', quality=82, optimize=True)
        paths.append(path)
    return dict(duration=duration, sampled_frames=len(frames)), paths


class Creative:
    def __init__(self, directory, output, keys):
        self.directory, self.output, self.keys = Path(directory), Path(output), keys
        self.directory.mkdir(parents=True, exist_ok=True)
        self.items, self.tasks, self.uploads, self.remote_objects = {}, {}, {}, {}
        for path in self.directory.glob('*.json'):
            if path.name.endswith('.media.json'): continue
            try:
                item = json.loads(path.read_text(encoding='utf-8'))
                if item['status'] == 'running':
                    item.update(status='interrupted', error='服务重启，任务已中断；可重新运行。')
                self.items[item['id']] = item
                self.save(item)
            except (ValueError, OSError, KeyError):
                continue

    def save(self, item):
        file = self.directory / (item['id'] + '.json')
        temp = file.with_suffix('.tmp')
        temp.write_text(json.dumps(item, ensure_ascii=False), encoding='utf-8')
        temp.replace(file)

    def get(self, ident):
        if ident not in self.items: raise HTTPException(404, '创作记录不存在')
        return self.items[ident]

    def media(self, ident):
        if not re.fullmatch('[a-f0-9]{32}', ident): raise HTTPException(400, '素材编号无效')
        meta = self.directory / (ident + '.media.json')
        if not meta.is_file(): raise HTTPException(404, '本地素材不存在，请重新上传')
        data = json.loads(meta.read_text(encoding='utf-8'))
        return data, self.directory / (ident + data['ext'])

    def save_media(self, info):
        meta = self.directory / (info['id'] + '.media.json')
        temp = meta.with_suffix('.tmp')
        temp.write_text(json.dumps(info, ensure_ascii=False), encoding='utf-8')
        temp.replace(meta)

    async def upload_object(self, data, mime, name, ttl=None):
        media_api = os.getenv('HAMSTER_MEDIA_API', '').strip()
        if not media_api:
            raise HTTPException(503, '请从仓鼠AI应用打开工作台，以连接素材通道')
        async with httpx.AsyncClient(timeout=180) as client:
            params = {'kind':mime.split('/')[0], 'fileName':name}
            if ttl: params['ttl'] = ttl
            response = await client.post(media_api, params=params,
                                         content=data, headers={'Content-Type':mime})
            response.raise_for_status()
            payload = response.json()
        url = (payload.get('file') or {}).get('url') or payload.get('url')
        if not isinstance(url, str) or not url.startswith('https://'):
            raise RuntimeError('素材通道未返回可用地址')
        self.remote_objects[url] = dict(key=(payload.get('file') or {}).get('key'),
                                        access_expires_at=payload.get('accessExpiresAt'))
        return url

    async def delete_urls(self, urls):
        signed_urls = list(dict.fromkeys(url for url in urls if self.remote_objects.get(url, {}).get('key')))
        if not signed_urls: return
        media_api = os.getenv('HAMSTER_MEDIA_API', '').strip()
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.request('DELETE', media_api, json={'urls':signed_urls})
                response.raise_for_status()
        finally:
            for url in urls: self.remote_objects.pop(url, None)
            deleted = set(urls)
            for meta in self.directory.glob('*.media.json'):
                try:
                    info = json.loads(meta.read_text(encoding='utf-8'))
                    if info.get('remote_url') not in deleted: continue
                    for field in ('remote_url', 'remote_uploaded_at', 'remote_key', 'remote_access_expires_at'):
                        info.pop(field, None)
                    self.save_media(info)
                except (OSError, ValueError):
                    continue

    async def upload_media(self, info, path):
        data = await asyncio.to_thread(path.read_bytes)
        url = await self.upload_object(data, info['mime'], info['name'])
        current, _ = self.media(info['id'])
        current['remote_url'] = url
        current['remote_uploaded_at'] = time.time()
        descriptor = self.remote_objects.get(url, {})
        current['remote_key'] = descriptor.get('key')
        current['remote_access_expires_at'] = descriptor.get('access_expires_at')
        self.save_media(current)
        return url

    async def remote_url(self, info, path):
        current, _ = self.media(info['id'])
        if current.get('remote_url') and time.time() - current.get('remote_uploaded_at', 0) < REMOTE_REUSE_SECONDS:
            return current['remote_url']
        task = self.uploads.get(info['id'])
        if task:
            try:
                return await task
            except Exception:
                self.uploads.pop(info['id'], None)
        return await self.upload_media(info, path)

    def cached_analysis(self, digest, mode):
        for item in reversed(list(self.items.values())):
            if (item.get('status') == 'success' and item.get('source_hash') == digest
                    and item.get('analysis_mode') == mode and item.get('analysis_version') == ANALYSIS_VERSION
                    and item.get('analysis_script')):
                return item
        return None

    async def store_media(self, data, mime, name):
        from io import BytesIO
        from PIL import Image
        exts = {'image/png':'.png', 'image/jpeg':'.jpg', 'image/webp':'.webp', 'video/mp4':'.mp4', 'video/quicktime':'.mov'}
        if mime not in exts: raise HTTPException(415, '支持 MP4 / MOV 视频和 JPG / PNG / WebP 图片')
        limit = 50 if mime.startswith('video') else 10
        if not data or len(data) > limit*1024*1024: raise HTTPException(413, f'素材不能为空，最大 {limit} MB')
        try:
            if mime.startswith('image'):
                with Image.open(BytesIO(data)) as image: image.verify()
            elif data[4:8] != b'ftyp': raise ValueError()
        except Exception:
            raise HTTPException(400, '素材格式无效')
        ident = uuid.uuid4().hex
        path = self.directory / (ident + exts[mime])
        await asyncio.to_thread(path.write_bytes, data)
        digest = hashlib.sha256(data).hexdigest()
        info = dict(id=ident, name=name[:160], mime=mime, ext=exts[mime], sha256=digest)
        for meta in self.directory.glob('*.media.json'):
            try:
                existing = json.loads(meta.read_text(encoding='utf-8'))
                if (existing.get('sha256') == digest and existing.get('remote_url')
                        and time.time() - existing.get('remote_uploaded_at', 0) < REMOTE_REUSE_SECONDS):
                    info['remote_url'] = existing['remote_url']
                    info['remote_uploaded_at'] = existing['remote_uploaded_at']
                    break
            except (OSError, ValueError):
                continue
        self.save_media(info)
        if mime.startswith('image/') and os.getenv('HAMSTER_MEDIA_API', '').strip() and not info.get('remote_url'):
            task = asyncio.create_task(self.upload_media(info, path))
            self.uploads[ident] = task
            task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        return info

    def start(self, item, operation):
        if any(x['status']=='running' for x in self.items.values()):
            raise HTTPException(409, '已有创意任务运行中，请等待完成或停止')
        if not self.keys()['MODEL_AGENT_API_KEY']:
            raise HTTPException(400, '请先在主应用「账户」页完成连接，再点击仓鼠标志检测智能服务。')
        item.update(status='running', error='', failure=None, cleanup_warning='')
        self.items[item['id']] = item
        self.save(item)
        task = asyncio.create_task(self.execute(item, operation))
        self.tasks[item['id']] = task
        def finished(done):
            # Cancellation before execute's first instruction still needs persistence.
            if done.cancelled() and item['status']=='running':
                item.update(status='cancelled', error='已停止；已发出的模型请求可能仍计费。')
                self.save(item)
            if self.tasks.get(item['id']) is done: self.tasks.pop(item['id'],None)
        task.add_done_callback(finished)
        return item

    async def execute(self, item, operation):
        try:
            await operation()
            item['status'] = 'success'
        except asyncio.CancelledError:
            item.update(status='cancelled', error='已停止；已发出的模型请求可能仍计费。')
        except Exception as exc:
            details = failure_details(exc, item.get('step'))
            from fault_report import report_fault
            await report_fault('creative', exc)
            if not details['request_id']:
                details['request_id'] = item.get('model_response_id', '')
            item.update(status='failed', error=details['message'], failure=details)
        finally:
            self.save(item)
            self.tasks.pop(item['id'], None)

    async def ask(self, item, text, schema, files=(), images=(), videos=(), thinking='disabled'):
        from volcenginesdkarkruntime import AsyncArk
        config = self.keys()
        client = AsyncArk(api_key=config['MODEL_AGENT_API_KEY'], base_url=config.get('MODEL_AGENT_API_BASE') or 'https://ark.cn-beijing.volces.com/api/v3', timeout=600, max_retries=0)
        uploaded, content = [], []
        try:
            for kind, path in files:
                item.update(step='upload_'+kind, stage=STEPS['upload_'+kind])
                self.save(item)
                with path.open('rb') as handle:
                    remote = await client.files.create(file=handle, purpose='user_data', **({'preprocess_configs':{'video':{'fps':2}}} if kind=='video' else {}))
                uploaded.append(remote.id)
                item.update(step='parse_'+kind, stage=STEPS['parse_'+kind])
                self.save(item)
                ready = await client.files.wait_for_processing(remote.id, poll_interval=2, max_wait_seconds=180)
                if ready.status != 'active': raise RuntimeError('file processing failed')
                content.append({'type':'input_'+kind, 'file_id':remote.id})
            for tag, url, fps in videos:
                content.extend([{'type':'input_text','text':tag}, {'type':'input_video','video_url':url,'fps':fps}])
            for tag, url in images:
                content.extend([{'type':'input_text','text':tag}, {'type':'input_image','image_url':url}])
            content.append({'type':'input_text','text':text+'\n建议使用以下字段组织 JSON，便于界面展示；无法结构化时保留文字分析：\n'+json.dumps(schema.model_json_schema(),ensure_ascii=False)})
            item.update(step='inference', stage=STEPS['inference'])
            self.save(item)
            response = await client.responses.create(model=config.get('LLM_ENDPOINT_ID') or os.getenv('HAMSTER_CREATIVE_MODEL', MODEL), input=[{'role':'user','content':content}], store=False,
                                                     thinking={'type':thinking})
            response_id = member(response, 'id', '')
            if isinstance(response_id, str) and re.fullmatch(r'[a-zA-Z0-9_-]{12,128}', response_id):
                item['model_response_id'] = response_id
            status = member(response, 'status', '')
            item['model_response_status'] = status
            usage = member(response, 'usage')
            if usage:
                item.setdefault('usage', []).append(usage if isinstance(usage, dict) else usage.model_dump())
            self.save(item)
            if status not in ('completed', 'incomplete'): raise RuntimeError('response failed')
            item.update(step='validate', stage=STEPS['validate'])
            raw = response_text(response)
            if not raw.strip(): raise EmptyModelOutput('empty output')
            item['analysis_text' if schema is Script else 'adaptation_text'] = raw
            item['response_incomplete'] = status == 'incomplete'
            self.save(item)
            result = display_result(raw, schema)
            if status == 'incomplete' and schema is Script:
                result.uncertainties.append('本次返回内容未完整结束，已保留现有分析与原文。')
            return result
        finally:
            for ident in uploaded:
                try: await asyncio.wait_for(client.files.delete(ident), timeout=10)
                except Exception: item['cleanup_warning'] = '云端临时素材清理未确认，请在服务控制台检查；本地原片保留。'
            try: await client.close()
            except Exception: pass  # Cleanup must not overwrite the primary failure.

    async def analyze(self, item):
        _, video = self.media(item['source'])
        item['analysis_mode'] = 'precise'
        item['thinking_mode'] = 'enabled'
        item['source_transport'] = 'ark_file_id'
        item.update(step='sample_video', stage=STEPS['sample_video'])
        self.save(item)
        sheets, urls, upload_tasks = [], [], []
        metadata, sheets = await asyncio.to_thread(build_contact_sheets, video, self.directory, item['id'])
        metadata.update(input='ark_video_file+contact_sheets', model_video_fps=2)
        item['video'] = metadata
        try:
            self.save(item)
            item['audio_analyzed'] = False
            item['stage'] = '拆解原片时序、运镜与镜头边界'
            self.save(item)
            item.update(step='upload_r2', stage=STEPS['upload_r2'])
            self.save(item)
            payloads = await asyncio.gather(*(asyncio.to_thread(path.read_bytes) for path in sheets))
            upload_tasks = [asyncio.create_task(self.upload_object(data, 'image/jpeg', path.name, ttl=1800))
                            for data, path in zip(payloads, sheets)]
            urls = list(await asyncio.gather(*upload_tasks))
            images = [(f'原片时间联系表 {index + 1}/{len(urls)}，角标为原片时间，仅用于定位与交叉核对', url)
                      for index, url in enumerate(urls)]
            prompt = analysis_prompt(metadata['duration']) + '\n本次为精确分析模式：先完整观察原片，再使用联系表复核时间与画面；看不清的细节必须降低置信度并写入 uncertainties，不得补猜。'
            script = await self.ask(item, prompt, Script, files=[('video', video)], images=images, thinking='enabled')
        finally:
            if upload_tasks:
                results = await asyncio.gather(*upload_tasks, return_exceptions=True)
                urls = list(dict.fromkeys(urls + [value for value in results if isinstance(value, str)]))
            try: await self.delete_urls(urls)
            except Exception: item['cleanup_warning'] = '临时联系表清理未确认，将由 1 天生命周期规则兜底。'
            for path in sheets:
                try: path.unlink()
                except OSError: pass
        script.uncertainties.insert(0, '本次以完整原片画面为主证据，联系表仅辅助定位；未独立核验音轨，字幕不等于实际语音。')
        payload = script.model_dump()
        item.update(script=payload, analysis_script=payload, stage='拆解完成，可直接改写或添加素材', result=None)

    async def adapt(self, item, brief):
        item['result'] = None
        targets = {c.id for c in brief.script.characters} | {s.id for s in brief.script.scenes} | {'product'}
        if len({b.target for b in brief.bindings}) != len(brief.bindings) or any(b.target not in targets for b in brief.bindings):
            raise ValueError('invalid binding')
        images, manifest = [], []
        for index, binding in enumerate(brief.bindings, 1):
            info, path = self.media(binding.media)
            if not info['mime'].startswith('image/'): raise ValueError('replacement must be image')
            tag = f'@图片{index}'
            images.append((tag,await self.remote_url(info,path)))
            manifest.append(dict(tag=tag,target=binding.target,name=info['name'],media=info['id']))
        if brief.reference_motion:
            info,_ = self.media(item['source'])
            manifest.append(dict(tag='@视频1',target='动作与运镜',name=info['name'],media=info['id']))
        item.update(brief=brief.model_dump(), references=manifest)
        item['stage'] = '结合替换资产改写分镜'
        self.save(item)
        try:
            draft = await self.ask(item, adaptation_prompt(
                brief.script.model_dump(), manifest, brief.notes, brief.reference_motion),
                Draft, images=images)
        finally:
            try: await self.delete_urls([url for _, url in images])
            except Exception: item['cleanup_warning'] = '临时改写素材清理未确认，将由 1 天生命周期规则兜底。'
        allowed = {entry['tag'] for entry in manifest}
        source_duration = item.get('video', {}).get('duration')
        if not source_duration:
            source_duration = max((shot.end for shot in brief.script.shots), default=0)
        segments = plan_generation_segments(source_duration)
        item['production_segments'] = segments
        segment_prompts = compile_segment_prompts(draft, segments, allowed, brief.reference_motion)
        prompt = '\n\n'.join(segment['prompt'] for segment in segment_prompts)
        self.output.mkdir(parents=True, exist_ok=True)
        name = f'创意脚本-{item["id"]}-{uuid.uuid4().hex[:8]}.txt'
        (self.output/name).write_text(prompt,encoding='utf-8')
        item.update(script=brief.script.model_dump(), brief=brief.model_dump(),
                    result=dict(prompt=prompt, manifest=manifest, segments=segment_prompts, file=name),
                    stage='Prompt 已保存到本地')


def install_creative(app, directory, output, keys):
    creative = Creative(directory, output, keys)
    app.state.creative = creative

    @app.get('/creative-api/config')
    async def config():
        return dict(ready=bool(keys()['MODEL_AGENT_API_KEY']), output=str(creative.output))

    @app.post('/creative-api/media')
    async def upload(request: Request):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body)>50*1024*1024: raise HTTPException(413,'素材最大50MB')
        return await creative.store_media(bytes(body),request.headers.get('content-type',''),request.query_params.get('name','素材'))

    @app.post('/creative-api/asset/{ident}')
    async def import_asset(ident: str):
        if not re.fullmatch('[a-f0-9]{32}',ident): raise HTTPException(400,'资产编号无效')
        base=os.getenv('HAMSTER_ASSET_API','')
        if not base: raise HTTPException(503,'请从仓鼠AI打开工作台')
        async with httpx.AsyncClient(timeout=60) as client:
            try:
                listing=await client.get(base)
                listing.raise_for_status()
                asset=next((x for x in listing.json()['items'] if x['id']==ident),None)
                if not asset or asset['kind']!='image': raise HTTPException(400,'替换资产请选择图片；原片用于动作参考')
                response=await client.get(base+'/'+ident+'/file')
                response.raise_for_status()
            except httpx.HTTPError: raise HTTPException(503,'资产库不可用，请保持主应用开启')
        return await creative.store_media(response.content,response.headers.get('content-type','').split(';')[0],asset['name'])

    @app.get('/creative-api/media/{ident}')
    async def media(ident: str, download: bool=False):
        info,path=creative.media(ident)
        return FileResponse(path,media_type=info['mime'],filename=info['name'] if download else None)

    @app.get('/creative-api/jobs')
    async def history():
        return [dict(id=x['id'],name=x['name'],status=x['status']) for x in reversed(list(creative.items.values()))]

    @app.post('/creative-api/analyze/{ident}',status_code=202)
    async def analyze(ident: str, options: AnalyzeRequest = AnalyzeRequest()):
        info,path=creative.media(ident)
        if not info['mime'].startswith('video/'): raise HTTPException(400,'请选择参考视频')
        try:
            metadata = await asyncio.to_thread(inspect_video, path)
        except Exception:
            raise HTTPException(400, '视频无法读取或超过1分钟，请使用60秒以内的 MP4 / MOV 视频')
        mode = 'precise'
        cached = creative.cached_analysis(info.get('sha256'), mode)
        item=dict(id=uuid.uuid4().hex, source=ident, source_hash=info.get('sha256'), name=info['name'],
                  analysis_mode=mode, analysis_version=ANALYSIS_VERSION, stage='准备拆解', script=None,
                  video=metadata, result=None)
        if cached:
            script = json.loads(json.dumps(cached['analysis_script'], ensure_ascii=False))
            item.update(status='success', script=script, analysis_script=script, video=cached.get('video'),
                        audio_analyzed=False, cache_hit=True, stage='已从分析缓存加载，可直接改写或添加素材')
            creative.items[item['id']] = item
            creative.save(item)
            return item
        return creative.start(item,lambda:creative.analyze(item))

    @app.get('/creative-api/jobs/{ident}')
    async def detail(ident: str): return creative.get(ident)

    @app.post('/creative-api/jobs/{ident}/script')
    async def edit_script(ident: str, script: Script):
        item=creative.get(ident)
        if item['status']=='running': raise HTTPException(409,'运行中不能修改脚本')
        if not item.get('video'): raise HTTPException(400,'请先完成拆解')
        item.update(script=script.model_dump(),result=None)
        creative.save(item)
        return script

    @app.post('/creative-api/jobs/{ident}/adapt',status_code=202)
    async def adapt(ident: str, brief: Adapt):
        item=creative.get(ident)
        if not item.get('script'): raise HTTPException(400,'请先完成视频拆解')
        return creative.start(item,lambda:creative.adapt(item,brief))

    @app.post('/creative-api/jobs/{ident}/cancel')
    async def cancel(ident: str):
        item=creative.get(ident)
        task=creative.tasks.get(ident)
        if task:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)
        return item

    @app.get('/creative-api/jobs/{ident}/result')
    async def result(ident: str):
        item=creative.get(ident)
        if not item.get('result'): raise HTTPException(404,'Prompt 尚未生成')
        file=creative.output/item['result']['file']
        return FileResponse(file,media_type='text/plain',filename=file.name)

    app.mount('/creative',StaticFiles(directory=ROOT/'creative-ui',html=True),name='creative-ui')
    return creative
