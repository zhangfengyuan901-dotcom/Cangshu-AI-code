"""Sanbao image/video OpenAPI adapter used by the bundled V1 workflow."""

import asyncio
import json
import os
import uuid
from urllib.parse import urlparse
from typing import Any

import aiohttp


API_BASE = os.getenv("SANBAO_API_BASE", "https://sanbaobeauty.com").rstrip("/")


def _headers(video: bool = False) -> dict[str, str]:
    api_key = os.getenv("SANBAO_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("未配置主线路 API Key，请先在仓鼠AI的账户页保存图片/视频 API Key")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-API-Key": api_key,
        "Content-Type": "application/json",
    }
    if video:
        headers["Idempotency-Key"] = str(uuid.uuid4())
    return headers


async def _json(session: aiohttp.ClientSession, method: str, url: str, **kwargs) -> dict:
    async with session.request(method, url, **kwargs) as response:
        text = await response.text()
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"仓鼠服务返回了无效响应（HTTP {response.status}）") from exc
        if response.status >= 400:
            message = payload.get("message") or payload.get("error") or text
            raise RuntimeError(f"仓鼠服务请求失败（HTTP {response.status}）：{message}")
        return payload


def _task_id(payload: dict) -> str:
    tasks = payload.get("tasks") or []
    item = tasks[0] if tasks else payload.get("data") or payload
    return str(item.get("task_id") or item.get("taskId") or item.get("id") or "")


async def generate(kind: str, payload: dict[str, Any], max_wait_seconds: int = 1200) -> dict:
    if os.getenv("HAMSTER_WALLET_MODE") == "1" or os.getenv("HAMSTER_PIKNO_MODE") == "1":
        return await _wallet_generate(kind, payload, max_wait_seconds)
    endpoint = f"{API_BASE}/openapi/v1/{kind}"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as session:
        created = await _json(session, "POST", endpoint, headers=_headers(video=kind == "videos"), json=payload)
        task_id = _task_id(created)
        if not task_id:
            raise RuntimeError("仓鼠服务未返回任务编号")
        deadline = asyncio.get_running_loop().time() + max_wait_seconds
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(2)
            result = await _json(session, "GET", f"{endpoint}/{task_id}", headers=_headers())
            data = result.get("data") or result
            status = str(data.get("status") or "").lower()
            if status in {"succeeded", "success", "completed"}:
                return data
            if status in {"failed", "failure", "error", "cancelled"}:
                raise RuntimeError(str(data.get("error") or data.get("message") or "仓鼠服务生成任务失败"))
        raise RuntimeError("仓鼠服务生成任务等待超时")


async def _wallet_generate(kind: str, payload: dict[str, Any], max_wait_seconds: int) -> dict:
    """Use the desktop's authenticated wallet journal; never submit directly upstream."""
    base = os.getenv("HAMSTER_WALLET_API", "").rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.path:
        raise RuntimeError("账户服务未就绪，请重启应用")
    if kind not in {"images", "videos"}:
        raise ValueError("生成类型无效")
    aliases = {"sd_2_5_once_720p": "main-video-720", "sd_2_5_once_line3": "main-video-flex",
               "sd_2_5_900_30s": "main-video-30", "image_2_5_flare": "main-image-a",
               "image_2_5_sunburst": "main-image-b"}
    payload = {**payload, "model": aliases.get(payload.get("model"), payload.get("model")), "concurrency": 1}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as session:
        catalog = await _json(session, "GET", base + "/api/models")
        model = next((m for m in catalog.get("data", []) if m.get("id") == payload["model"]), None)
        if not model:
            raise RuntimeError("当前线路尚未开放，请在生成页面选择可用线路")
        if model.get("price_version") is not None:
            payload["price_version"] = model["price_version"]
        created = await _json(session, "POST", base + "/api/" + kind,
                              headers={"Idempotency-Key": str(uuid.uuid4())}, json=payload)
        task = created.get("task") or (created.get("tasks") or [{}])[0]
        task_key = task.get("key")
        if not task_key:
            raise RuntimeError("任务受理状态待核查，请查看任务记录，不要重复生成")
        deadline = asyncio.get_running_loop().time() + max_wait_seconds
        while True:
            if task.get("status") == "succeeded":
                result = task.get("result") or {}
                url = result.get("download_url") or result.get("image_url") or result.get("video_url")
                if os.getenv("HAMSTER_PIKNO_MODE") == "1" and str(result.get("local_url", "")).startswith('/api/tasks/'):
                    url = base + result["local_url"]
                if not url:
                    raise RuntimeError("结果正在保存，请稍后查看任务记录")
                return {"status": "succeeded", "download_url": url}
            if task.get("status") == "failed":
                raise RuntimeError("生成任务未成功，请在任务记录查看状态；费用以账户任务记录为准")
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeError("任务仍在后台处理，请查看任务记录，不要重复生成")
            await asyncio.sleep(2)
            records = await _json(session, "GET", base + "/api/tasks")
            task = next((t for t in records.get("tasks", []) if t.get("key") == task_key), {})
            if not task:
                raise RuntimeError("请登录原任务所属账户后查看结果，不要重复生成")


def result_url(data: dict, kind: str) -> str:
    keys = ("image_url", "download_url") if kind == "images" else ("video_url", "download_url")
    for key in keys:
        if data.get(key):
            return str(data[key])
    raise RuntimeError("仓鼠服务任务成功但没有返回结果链接")
