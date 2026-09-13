"""Sanbao image/video OpenAPI adapter used by the bundled V1 workflow."""

import asyncio
import json
import os
import uuid
from typing import Any

import aiohttp


API_BASE = os.getenv("SANBAO_API_BASE", "https://sanbaobeauty.com").rstrip("/")


def _headers(video: bool = False) -> dict[str, str]:
    api_key = os.getenv("SANBAO_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("未配置三宝 API Key，请先在仓鼠AI的账户页保存图片/视频 API Key")
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
            raise RuntimeError(f"三宝接口返回了无效响应（HTTP {response.status}）") from exc
        if response.status >= 400:
            message = payload.get("message") or payload.get("error") or text
            raise RuntimeError(f"三宝接口请求失败（HTTP {response.status}）：{message}")
        return payload


def _task_id(payload: dict) -> str:
    tasks = payload.get("tasks") or []
    item = tasks[0] if tasks else payload.get("data") or payload
    return str(item.get("task_id") or item.get("taskId") or item.get("id") or "")


async def generate(kind: str, payload: dict[str, Any], max_wait_seconds: int = 1200) -> dict:
    endpoint = f"{API_BASE}/openapi/v1/{kind}"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as session:
        created = await _json(session, "POST", endpoint, headers=_headers(video=kind == "videos"), json=payload)
        task_id = _task_id(created)
        if not task_id:
            raise RuntimeError("三宝接口未返回 taskId")
        deadline = asyncio.get_running_loop().time() + max_wait_seconds
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(2)
            result = await _json(session, "GET", f"{endpoint}/{task_id}", headers=_headers())
            data = result.get("data") or result
            status = str(data.get("status") or "").lower()
            if status in {"succeeded", "success", "completed"}:
                return data
            if status in {"failed", "failure", "error", "cancelled"}:
                raise RuntimeError(str(data.get("error") or data.get("message") or "三宝生成任务失败"))
        raise RuntimeError("三宝生成任务等待超时")


def result_url(data: dict, kind: str) -> str:
    keys = ("image_url", "download_url") if kind == "images" else ("video_url", "download_url")
    for key in keys:
        if data.get(key):
            return str(data[key])
    raise RuntimeError("三宝任务成功但没有返回结果链接")
