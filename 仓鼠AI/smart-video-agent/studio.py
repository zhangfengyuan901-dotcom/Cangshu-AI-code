"""Local customer service for durable multimodal chat."""

import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import ProxyHandler, Request as URLRequest, build_opener

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response

ROOT = Path(__file__).resolve().parent


def relay_execution_context():
    """Read an opaque execution scope. Protected customer Keys stay in Node."""
    base = os.getenv("HAMSTER_WALLET_API", "")
    try:
        parsed = urlparse(base)
        valid = (parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
                 and not parsed.username and not parsed.password and not parsed.path
                 and not parsed.query and not parsed.fragment)
        if not valid:
            return {}
        request = URLRequest(base + "/api/inference/context", headers={"Accept": "application/json"})
        with build_opener(ProxyHandler({})).open(request, timeout=2) as response:
            status = json.loads(response.read(4096))
        if (isinstance(status, dict) and status.get('configured') is True
                and re.fullmatch(r'[a-f0-9]{64}', str(status.get('scope', '')))
                and type(status.get('revision')) is int and status['revision'] > 0):
            return {'EXECUTION_SCOPE': status['scope'], 'CONFIG_REVISION': status['revision']}
        return {}
    except (OSError, ValueError):
        return {}


def relay_key_configured():
    return bool(relay_execution_context())


def configured_keys():
    context = {}
    config_path = os.getenv("HAMSTER_CONFIG_PATH", "")
    try:
        cfg = json.loads(Path(config_path).read_text(encoding="utf-8")) if config_path else {}
    except (OSError, ValueError):
        cfg = {}
    main_key = str(cfg.get("apiKey", os.getenv("SANBAO_API_KEY", ""))).strip()
    if os.getenv("HAMSTER_WALLET_MODE") == "1":
        main_key = "hamster-wallet-session" if cfg.get("billingApiKey") else ""
    if os.getenv("HAMSTER_PIKNO_MODE") == "1":
        # Identity is checked by the local gateway on every inference session.
        # Customer keys remain protected in Node/Electron, never in Python env.
        context = relay_execution_context()
        main_key = "hamster-relay-session" if context else ""
    return {
        "SANBAO_API_KEY": main_key,
        "MODEL_AGENT_API_KEY": str(os.getenv("MODEL_AGENT_API_KEY", "")).strip() if main_key else "",
        "MODEL_AGENT_API_BASE": str(os.getenv("MODEL_AGENT_API_BASE", "")).strip(),
        "LLM_ENDPOINT_ID": str(os.getenv("LLM_ENDPOINT_ID", "hamster-auto")).strip(),
        "PIKNO_LLM_V2": os.getenv("HAMSTER_PIKNO_MODE") == "1",
        **context,
    }


def create_studio(directory=None, output=None):
    # Only the exact local shell may frame this service. This does not grant API CORS.
    shell_origin = os.getenv("HAMSTER_WALLET_API", "")
    match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/?", shell_origin)
    frame_ancestors = "'self'"
    if match and int(match.group(1)) <= 65535:
        frame_ancestors += " " + shell_origin.rstrip("/")
    @asynccontextmanager
    async def lifespan(app):
        yield
        tasks = list(app.state.chat.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        app.state.chat.db.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.url.path.startswith(("/chat/", "/chat-api/")) and request.url.hostname not in (
                "127.0.0.1", "localhost", "testserver"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "请使用本机地址访问智能体"}, status_code=403)
        if origin and origin != str(request.base_url).rstrip("/"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "请在本机智能体页面操作"}, status_code=403)
        from fault_report import report_fault
        try:
            response = await call_next(request)
        except Exception as exc:
            await report_fault('service', exc)
            raise
        if response.status_code >= 500:
            await report_fault('service', status=response.status_code)
        response.headers['Content-Security-Policy'] = "base-uri 'self'; object-src 'none'; frame-ancestors " + frame_ancestors
        response.headers['Referrer-Policy'] = 'no-referrer'
        # The frame policy contains this launch's shell port, so static responses cannot be reused.
        if request.url.path.startswith(('/chat/', '/shared/')) or request.url.path in ('/', '/chat', '/workbench.css', '/hamster-logo.png'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get("/studio-api/health")
    async def health():
        return {"app": "hamster-smart-video", "version": 26, "creative": False, "chat": True,
                "instance": os.getenv("HAMSTER_SERVICE_INSTANCE", "")}

    @app.post('/studio-api/error-report')
    async def interface_fault(request: Request):
        # Ignore the body entirely: this endpoint represents one fixed UI event.
        if request.url.hostname not in ('127.0.0.1', 'localhost', 'testserver'):
            raise HTTPException(403, '请使用本机地址')
        from fault_report import report_fault
        await report_fault('interface')
        return Response(status_code=202)

    @app.api_route("/studio-api/assets", methods=["GET"])
    @app.api_route("/studio-api/assets/{suffix:path}", methods=["GET", "POST"])
    async def asset_proxy(request: Request, suffix: str = ""):
        base = os.getenv("HAMSTER_ASSET_API", "")
        if not base:
            raise HTTPException(503, "请从仓鼠AI应用打开智能体，以连接共用资产库")
        if not re.fullmatch(r"[a-zA-Z0-9/-]*", suffix):
            raise HTTPException(400, "无效资产路径")
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 50 * 1024 * 1024:
                raise HTTPException(413, "素材最大50MB")
        headers = {key: request.headers[key] for key in ("content-type", "range") if key in request.headers}
        async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
            try:
                upstream = await client.request(request.method, base + ("/" + suffix if suffix else ""),
                                                params=request.query_params, content=bytes(data), headers=headers)
            except httpx.HTTPError:
                raise HTTPException(503, "资产库连接中断，请保持仓鼠AI应用开启")
        allowed = ("content-type", "content-range", "accept-ranges")
        return Response(upstream.content, status_code=upstream.status_code,
                        headers={key: value for key, value in upstream.headers.items() if key in allowed})

    shared = ROOT / "studio-ui" / "shared"

    @app.get("/shared/{name}")
    async def shared_asset(name: str):
        types = {"asset-library.mjs": "application/javascript", "fault-events.mjs":"application/javascript", "assets.css": "text/css", "typography.css": "text/css", "material-preview.mjs":"application/javascript", "material-preview.css":"text/css", "interaction-policy.mjs":"application/javascript"}
        if name not in types:
            raise HTTPException(404, "文件不存在")
        return FileResponse((shared if (shared / name).is_file() else ROOT.parent / "public") / name,
                            media_type=types[name])

    @app.get("/shared/fonts/{name}")
    async def shared_font(name: str):
        types = {"InterVariable.woff2":"font/woff2", "JetBrainsMono-Regular.woff2":"font/woff2", "Roboto-Regular.ttf":"font/ttf",
                 "LICENSE-Inter.txt":"text/plain", "LICENSE-JetBrainsMono.txt":"text/plain", "LICENSE-Roboto.txt":"text/plain"}
        if name not in types:
            raise HTTPException(404, "文件不存在")
        bundled = shared / "fonts" / name
        return FileResponse(bundled if bundled.is_file() else ROOT.parent / "public" / "fonts" / name,
                            media_type=types[name])

    from chat import install_chat
    persistent_chat = os.getenv("HAMSTER_CHAT_DATA_DIR")
    chat_root = Path(directory).parent / "chat-data" if directory else Path(persistent_chat) if persistent_chat else ROOT / "chat-data"
    install_chat(app, chat_root, configured_keys)

    @app.get("/")
    async def workbench_home():
        return RedirectResponse("/chat/")

    @app.get("/hamster-logo.png")
    async def workbench_logo():
        return FileResponse(ROOT / "studio-ui" / "hamster-mark.png", media_type="image/png")

    @app.get("/workbench.css")
    async def workbench_styles():
        return FileResponse(ROOT / "studio-ui" / "workbench.css", media_type="text/css")

    return app
