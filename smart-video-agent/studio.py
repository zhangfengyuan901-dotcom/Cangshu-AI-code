"""Local customer workbench for the bundled sequential video workflow."""

import asyncio
import json
import os
import re
import shutil
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, model_validator

ROOT = Path(__file__).resolve().parent
STAGES = [
    ("market_agent", "营销策划"), ("storyboard_agent", "分镜脚本"),
    ("image_agent", "首帧生成"), ("image_evaluate_agent", "图片评选"),
    ("video_agent", "视频生成"), ("video_evaluate_agent", "视频评选"),
    ("release_agent", "合成成片"),
]


class AssetReference(BaseModel):
    role: Literal['talent', 'product', 'scene']
    kind: Literal['image', 'video']
    url: str = Field(max_length=3000)
    name: str = Field(default='', max_length=160)

class Brief(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    product: str = Field(min_length=1, max_length=120)
    selling_points: str = Field(min_length=1, max_length=3000)
    audience: str = Field(default="", max_length=500)
    platform: Literal["TikTok Shop", "抖音", "小红书", "淘宝 / 天猫"] = "TikTok Shop"
    style: Literal["自然种草", "质感广告", "产品展示", "生活方式"] = "自然种草"
    ratio: Literal["9:16", "16:9", "1:1"] = "9:16"
    video_model: Literal["hailuo_h3_2k_line2", "wan30_720p_real", "sd2_limited_line3", "sd25_30img_special"] = "sd2_limited_line3"
    resolution: Literal["720p", "2k"] = "720p"
    seconds: Literal[5, 10] = 5
    candidates: Literal[1, 2] = 1
    notes: str = Field(default="", max_length=3000)
    image_url: str = Field(default="", max_length=3000)
    references: list[AssetReference] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def validate_route_quality(self):
        expected = "2k" if self.video_model == "hailuo_h3_2k_line2" else "720p"
        if self.resolution != expected:
            raise ValueError("所选线路不支持此画质")
        if len({r.role for r in self.references}) != len(self.references):
            raise ValueError('每类素材只能选择一份')
        if any(not public_url(r.url) for r in self.references):
            raise ValueError('素材必须先上传并获得可访问地址')
        if self.video_model == 'sd25_30img_special' and any(r.kind == 'video' for r in self.references):
            raise ValueError('seedance2.5不支持视频参考，请换用图片或其他线路')
        return self

    def prompt(self):
        return (
            f"请制作商品营销视频。商品：{self.product}\n卖点：{self.selling_points}\n"
            f"目标人群：{self.audience or '根据商品分析'}\n投放平台：{self.platform}\n"
            f"风格：{self.style}\n比例：{self.ratio}，分辨率：{self.resolution}\n"
            f"固定4个分镜，每个分镜{self.seconds}秒，总长约{4 * self.seconds}秒。\n"
            f"每个分镜首帧候选数量：{self.candidates}；视频候选数量：{self.candidates}。\n"
            f"附加要求：{self.notes or '无'}\n"
            + (f"商品参考图片URL：{self.image_url}\n" if self.image_url else '')
            + ''.join(f"{dict(talent='达人', product='产品', scene='场景')[r.role]}{r.kind}参考：{r.url}\n" for r in self.references)
            + '\n达人图片仅参考人物形象并保持一致；产品图片参考商品与服装；场景图片参考环境、构图与光线。视频素材仅参考动作节奏、空间及运镜，不继承原视频人物外观与商品。不修改素材URL，将各类参考职责传递到所有分镜。\n'
        )


def now():
    return datetime.now(timezone.utc).isoformat()


def configured_keys():
    config_path = os.getenv("HAMSTER_CONFIG_PATH", "")
    try:
        cfg = json.loads(Path(config_path).read_text(encoding="utf-8")) if config_path else {}
    except (OSError, ValueError):
        cfg = {}
    return {
        "SANBAO_API_KEY": str(cfg.get("apiKey", os.getenv("SANBAO_API_KEY", ""))).strip(),
        "MODEL_AGENT_API_KEY": str(cfg.get("llmApiKey", os.getenv("MODEL_AGENT_API_KEY", ""))).strip(),
        "LLM_ENDPOINT_ID": str(cfg.get("llmEndpointId", cfg.get("creativeEndpointId", ""))).strip(),
    }


def public_url(value):
    parsed = urlparse(value)
    return parsed.scheme in {"https", "http"} and bool(parsed.hostname)


class Jobs:
    def __init__(self, directory, output, executor=None):
        self.directory = Path(directory)
        self.output = Path(output)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.items = {}
        self.tasks = {}
        self.executor = executor or self.run_workflow
        for file in self.directory.glob("*.json"):
            try:
                item = json.loads(file.read_text(encoding="utf-8"))
                self.items[item["id"]] = item
                if item["status"] == "running":
                    item.update(status="interrupted", error="服务已重启，此任务未完成。可复用需求重新制作。")
                    self.save(item)
            except (OSError, ValueError, KeyError):
                continue

    def save(self, item):
        item["updated"] = now()
        target = self.directory / f"{item['id']}.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)

    def get(self, job_id):
        if job_id not in self.items:
            raise HTTPException(404, "任务不存在")
        return self.items[job_id]

    def active(self):
        return next((x for x in self.items.values() if x["status"] == "running"), None)

    def create(self, brief):
        if self.active():
            raise HTTPException(409, "已有任务正在制作，请等待完成或停止后再试")
        item = dict(id=uuid.uuid4().hex, brief=brief.model_dump(), status="running", created=now(),
                    stages=[dict(id=key, title=title, status="pending", text="", media=[]) for key, title in STAGES],
                    error="", result=None)
        self.items[item["id"]] = item
        self.save(item)
        self.tasks[item["id"]] = asyncio.create_task(self.execute(item, brief))
        return item

    async def execute(self, item, brief):
        try:
            await self.executor(item, brief)
            result = item.get("result")
            if not result or not (self.output / result["name"]).is_file():
                raise RuntimeError("工作流已结束，但尚未生成可下载的成片。请查看各阶段内容并调整需求。")
            item["status"] = "success"
        except asyncio.CancelledError:
            item.update(status="cancelled", error="已停止后续流程。上游已提交的生成任务可能继续运行并计费。")
        except Exception as exc:
            message = str(exc)
            for secret in configured_keys().values():
                if secret:
                    message = message.replace(secret, "[已隐藏]")
            item.update(status="failed", error=message[:1500] or "制作失败，请检查账户配置后重试")
        finally:
            for stage in item["stages"]:
                if stage["status"] == "running":
                    stage["status"] = "complete" if item["status"] == "success" else item["status"]
            self.save(item)
            self.tasks.pop(item["id"], None)

    async def run_workflow(self, item, brief):
        os.environ.update(configured_keys())
        os.environ["SANBAO_VIDEO_MODEL"] = brief.video_model
        from google.adk.runners import Runner
        from google.adk.sessions import InMemorySessionService
        from google.genai import types
        from app.root import get_root_agent
        from app.utils import url_shortener

        root = get_root_agent()
        stage_map = {stage["id"]: stage for stage in item["stages"]}

        async def enter_stage(callback_context):
            name = callback_context.agent_name
            for stage in item["stages"]:
                if stage["status"] == "running":
                    stage["status"] = "complete"
            stage_map[name]["status"] = "running"
            self.save(item)

        async def capture_final(tool, args, tool_context, tool_response):
            if tool.name == "video_combine" and isinstance(tool_response, str):
                source = Path(tool_response).resolve()
                merged = (ROOT / "merged_videos").resolve()
                if source.is_relative_to(merged) and source.is_file() and source.stat().st_size:
                    self.output.mkdir(parents=True, exist_ok=True)
                    name = f"仓鼠成片-{item['id']}.mp4"
                    await asyncio.to_thread(shutil.copy2, source, self.output / name)
                    item["result"] = {"name": name, "url": f"/studio-api/jobs/{item['id']}/result"}
                    self.save(item)

        async def apply_generation_settings(tool, args, tool_context):
            # The customer's explicit settings take precedence over model flags.
            if tool.name == "image_generate":
                tasks = args.get("tasks", [])
                if len(tasks) > 4:
                    raise ValueError("首帧任务超过四个分镜，请调整需求后重试")
                for task in tasks:
                    task.update(size=brief.ratio, max_images=brief.candidates, task_type="storyboard_group")
                    references = [r.url for r in brief.references if r.kind == 'image']
                    if brief.image_url: references.append(brief.image_url)
                    if references: task['image'] = list(dict.fromkeys(references))
                    task['prompt'] = str(task.get('prompt','')) + '\n参考职责：' + '; '.join(f"参考图{index+1}为{dict(talent='达人形象',product='产品外观',scene='场景环境')[r.role]}" for index,r in enumerate([r for r in brief.references if r.kind=='image'])) + ('；最后一张为补充商品图' if brief.image_url else '')
            elif tool.name == "sanbao_video_generate":
                from app.video.tools.video_generate_by_code import _clean_prompt
                params = args.get("params", [])
                if len(params) > 4 * brief.candidates:
                    raise ValueError("视频候选数量超过所选配置，请调整需求后重试")
                for param in params:
                    param['reference_images'] = [r.url for r in brief.references if r.kind == 'image']
                    param['reference_videos'] = [r.url for r in brief.references if r.kind == 'video']
                    param['reference_roles'] = [dict(role=r.role,kind=r.kind,url=r.url) for r in brief.references]
                    param["prompt"] = (_clean_prompt(str(param.get("prompt", "")))
                        + f" --rt {brief.ratio} --rs {brief.resolution} --dur {brief.seconds}")

        for agent in root.sub_agents:
            if agent.name in stage_map:
                callbacks = agent.before_agent_callback or []
                agent.before_agent_callback = [enter_stage] + (callbacks if isinstance(callbacks, list) else [callbacks])
                tools_callbacks = agent.before_tool_callback or []
                agent.before_tool_callback = [apply_generation_settings] + (tools_callbacks if isinstance(tools_callbacks, list) else [tools_callbacks])
                if agent.name == "release_agent":
                    agent.after_tool_callback = [capture_final] + list(agent.after_tool_callback or [])
        sessions = InMemorySessionService()
        await sessions.create_session(app_name="smart_video", user_id="local", session_id=item["id"])
        runner = Runner(agent=root, app_name="smart_video", session_service=sessions)
        async for event in runner.run_async(user_id="local", session_id=item["id"],
                                           new_message=types.Content(role="user", parts=[types.Part(text=brief.prompt())])):
            if getattr(event, "error_code", None):
                raise RuntimeError(event.error_message or str(event.error_code))
            if event.author not in stage_map or event.partial:
                continue
            stage = stage_map[event.author]
            parts = event.content.parts if event.content else []
            for part in parts:
                if part.text and not getattr(part, "thought", False):
                    stage["text"] += url_shortener.replace_in_text(part.text) + "\n\n"
                if part.function_response:
                    payload = part.function_response.response
                    raw = url_shortener.replace_in_text(json.dumps(payload, ensure_ascii=False))
                    kind = "video" if event.author == "video_agent" else "image" if event.author == "image_agent" else None
                    if kind:
                        for url in re.findall(r'https?://[^\s<>"\\]+', raw):
                            if not any(m["url"] == url for m in stage["media"]):
                                stage["media"].append({"url": url, "kind": kind})
            self.save(item)


def create_studio(directory=None, output=None, executor=None):
    jobs = Jobs(directory or ROOT / "studio-data", output or os.getenv("HAMSTER_SMART_VIDEO_OUTPUT_DIR")
                or Path.home() / "Desktop" / "仓鼠AI生成结果" / "智能成片", executor)

    @asynccontextmanager
    async def lifespan(app):
        yield
        tasks = list(jobs.tasks.values()) + list(app.state.creative.tasks.values()) + list(app.state.chat.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        app.state.chat.db.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.jobs = jobs

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.url.path.startswith(('/chat/', '/chat-api/')) and request.url.hostname not in ('127.0.0.1', 'localhost', 'testserver'):
            from fastapi.responses import JSONResponse
            return JSONResponse({'detail':'请使用本机地址访问智能体'}, status_code=403)
        if origin and origin != str(request.base_url).rstrip("/"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "请在本地工作台操作"}, status_code=403)
        return await call_next(request)

    @app.get("/studio-api/health")
    async def health():
        return {"app": "hamster-smart-video", "version": 19, "creative": True, "chat": True,
                "instance": os.getenv("HAMSTER_SERVICE_INSTANCE", "")}

    @app.get("/studio-api/config")
    async def config():
        keys = configured_keys()
        return {"mediaReady": bool(keys["SANBAO_API_KEY"]), "llmReady": bool(keys["MODEL_AGENT_API_KEY"]),
                "output": str(jobs.output), "active": (jobs.active() or {}).get("id")}

    @app.get("/studio-api/jobs")
    async def history():
        return [dict(id=x["id"], product=x["brief"]["product"], status=x["status"], created=x["created"])
                for x in sorted(jobs.items.values(), key=lambda x: x["created"], reverse=True)]

    @app.post("/studio-api/jobs", status_code=202)
    async def create(brief: Brief):
        keys = configured_keys()
        if not all(keys.get(name) for name in ('SANBAO_API_KEY', 'MODEL_AGENT_API_KEY')):
            raise HTTPException(400, "请在仓鼠AI账户页保存图片/视频 API Key 和仓鼠智能 API Key，再刷新配置")
        if brief.image_url and not public_url(brief.image_url):
            raise HTTPException(422, "参考图片必须是可访问的 HTTP/HTTPS 地址")
        return jobs.create(brief)

    @app.get("/studio-api/jobs/{job_id}")
    async def detail(job_id: str):
        return jobs.get(job_id)

    @app.post("/studio-api/jobs/{job_id}/cancel")
    async def cancel(job_id: str):
        item = jobs.get(job_id)
        task = jobs.tasks.get(job_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if item["status"] == "running":
                item.update(status="cancelled", error="已停止后续流程。上游已提交的任务可能继续计费。")
                jobs.save(item)
                jobs.tasks.pop(job_id, None)
        return item

    @app.get("/studio-api/jobs/{job_id}/result")
    async def result(job_id: str, download: bool = False):
        result = jobs.get(job_id).get("result")
        if not result:
            raise HTTPException(404, "成片尚未生成")
        file = (jobs.output / result["name"]).resolve()
        if file.parent != jobs.output.resolve() or not file.is_file():
            raise HTTPException(404, "本地成片文件不存在")
        return FileResponse(file, media_type="video/mp4", filename=file.name if download else None)

    @app.api_route('/studio-api/assets', methods=['GET'])
    @app.api_route('/studio-api/assets/{suffix:path}', methods=['GET', 'POST'])
    async def asset_proxy(request: Request, suffix: str = ''):
        base = os.getenv('HAMSTER_ASSET_API', '')
        if not base:
            raise HTTPException(503, '请从仓鼠AI应用打开工作台，以连接共用资产库')
        if not re.fullmatch(r'[a-zA-Z0-9/-]*', suffix):
            raise HTTPException(400, '无效资产路径')
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 50*1024*1024: raise HTTPException(413, '素材最大50MB')
        headers = {key: request.headers[key] for key in ['content-type','range'] if key in request.headers}
        async with httpx.AsyncClient(timeout=180) as client:
            try:
                upstream = await client.request(request.method, base + ('/'+suffix if suffix else ''), params=request.query_params, content=bytes(data), headers=headers)
            except httpx.HTTPError:
                raise HTTPException(503, '资产库连接中断，请保持仓鼠AI应用开启')
        return Response(upstream.content, status_code=upstream.status_code, headers={key:value for key,value in upstream.headers.items() if key in ['content-type','content-range','accept-ranges']})

    @app.post('/studio-api/jobs/{job_id}/collect')
    async def collect(job_id: str, request: Request):
        item=jobs.get(job_id)
        if not item.get('result'): raise HTTPException(400,'成片尚未生成')
        payload=await request.json()
        base=os.getenv('HAMSTER_ASSET_API','')
        if not base: raise HTTPException(503,'请从仓鼠AI应用打开工作台')
        async with httpx.AsyncClient(timeout=60) as client:
            upstream=await client.post(base+'/import-result',json={'category':payload.get('category'),'name':item['brief']['product']+'成片.mp4','local_path':str(jobs.output / item['result']['name'])})
        return Response(upstream.content,status_code=upstream.status_code,media_type='application/json')

    @app.post("/studio-api/upload")
    async def upload(request: Request):
        key = configured_keys()["SANBAO_API_KEY"]
        if not key:
            raise HTTPException(400, "请先在仓鼠AI账户页配置图片/视频 API Key")
        mime = request.headers.get("content-type", "")
        if mime not in {"image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "video/quicktime"}:
            raise HTTPException(415, "请选择图片或视频素材")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 50 * 1024 * 1024:
                raise HTTPException(413, "素材不能超过50MB")
        if not body:
            raise HTTPException(400, "图片为空")
        if mime.startswith('image/') and len(body)>30*1024*1024: raise HTTPException(413,'图片最大30MB')
        if mime.startswith('video/'):
            valid = body[:4] == bytes.fromhex('1a45dfa3') if mime=='video/webm' else body[4:8]==b'ftyp'
            if not valid: raise HTTPException(400,'文件不是有效视频格式')
        from io import BytesIO
        from PIL import Image
        try:
            if mime.startswith('image/'):
                with Image.open(BytesIO(body)) as image:
                    image.verify()
        except Exception:
            raise HTTPException(400, "文件不是有效图片")
        async with httpx.AsyncClient(timeout=180) as client:
            try:
                response = await client.post(os.getenv("SANBAO_API_BASE", "https://sanbaobeauty.com").rstrip("/") + "/openapi/v1/uploads/raw",
                    params={"kind": mime.split('/')[0], "fileName": request.query_params.get("name", "product.png")},
                    content=bytes(body), headers={"Authorization": f"Bearer {key}", "X-API-Key": key, "Content-Type": mime})
                response.raise_for_status()
                payload = response.json()
                url = (payload.get("file") or {}).get("url") or (payload.get("data") or {}).get("download_url")
                if not url or not public_url(url):
                    raise ValueError("missing URL")
                return {"url": url}
            except (httpx.HTTPError, ValueError):
                raise HTTPException(502, "素材上传失败，请检查图片 / 视频 API Key 和网络后重试")

    shared = ROOT/'studio-ui'/'shared'
    @app.get('/shared/{name}')
    async def shared_asset(name: str):
        types={'asset-library.mjs':'application/javascript','assets.css':'text/css'}
        if name not in types: raise HTTPException(404,'文件不存在')
        return FileResponse((shared if shared.is_dir() else ROOT.parent/'public')/name, media_type=types[name])
    from creative import install_creative
    install_creative(app, Path(directory).parent / 'creative-data' if directory else ROOT/'creative-data', jobs.output.parent/'创意工作台', configured_keys)
    from chat import install_chat
    install_chat(app, Path(directory).parent / 'chat-data' if directory else ROOT/'chat-data', configured_keys)
    app.mount("/", StaticFiles(directory=ROOT / "studio-ui", html=True), name="studio-ui")
    return app
