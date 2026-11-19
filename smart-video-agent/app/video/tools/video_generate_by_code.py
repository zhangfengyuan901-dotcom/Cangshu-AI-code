"""Batch video generation through the Sanbao upstream."""

import asyncio
import os
import re
from typing import Dict

from google.adk.tools import ToolContext

from app.sanbao import generate, result_url


def _option(prompt: str, names: str, fallback: str) -> str:
    match = re.search(rf"(?:{names})\s+([^\s]+)", prompt)
    return match.group(1) if match else fallback


def _clean_prompt(prompt: str) -> str:
    return re.sub(
        r"\s+--(?:rs|resolution|rt|ratio|dur|duration|fps|framespersecond|wm|watermark|seed|cf|camerafixed)\s+[^\s]+",
        "", prompt,
    ).strip()


async def _generate_one(item: dict, max_wait_seconds: int) -> str:
    model = os.getenv("SANBAO_VIDEO_MODEL", "sd_2_5_once_720p")
    if model not in {"sd_2_5_once_720p", "sd_2_5_once_line3", "sd_2_5_900_30s"}:
        raise ValueError("请选择当前可用的仓鼠视频线路")
    prompt = str(item.get("prompt") or "")
    images = []
    for index, frame in enumerate((item.get("first_frame"), item.get("last_frame")), start=1):
        if frame:
            images.append({"tag": f"图片{index}", "url": frame})
    for image in item.get('reference_images', []):
        if not any(x['url'] == image for x in images): images.append({'tag':f'图片{len(images)+1}','url':image})
    roles=[]
    for ref in item.get('reference_roles', []):
        if ref['kind']=='image':
            tag=next((image['tag'] for image in images if image['url']==ref['url']),None)
            if tag: roles.append(f"@{tag}作为{dict(talent='人物形象',product='商品外观',scene='场景环境')[ref['role']]}参考")
        else:
            index=item.get('reference_videos',[]).index(ref['url'])+1
            roles.append(f'@视频{index}仅参考动作、节奏和运镜，不参考人物外观及商品')
    reference_videos = item.get('reference_videos', [])
    if model == "sd_2_5_900_30s" and reference_videos:
        raise ValueError("SD2.5-9图-30秒不支持视频参考")
    payload = {
        "model": model,
        "prompt": _clean_prompt(prompt) + ('\n'+'；'.join(roles) if roles else ''),
        "ratio": _option(prompt, "--rt|--ratio", "16:9"),
        "resolution": "720p" if model != "sd_2_5_once_line3" else _option(prompt, "--rs|--resolution", "720p"),
        "duration": 30 if model == "sd_2_5_900_30s" else int(_option(prompt, "--dur|--duration", "5")),
        "concurrency": 1,
        "reference": "all",
        "images": images,
        "videos": [{'tag':f'视频{i+1}','url':url} for i,url in enumerate(reference_videos)],
        "audios": [],
    }
    return result_url(await generate("videos", payload, max_wait_seconds), "videos")


async def sanbao_video_generate(
    params: list,
    tool_context: ToolContext,
    batch_size: int = 10,
    max_wait_seconds: int = 1200,
) -> Dict:
    """Generate storyboard video candidates with the configured Sanbao API key."""
    results = await asyncio.gather(
        *[_generate_one(item, max_wait_seconds) for item in params],
        return_exceptions=True,
    )
    success_list = []
    error_list = []
    for index, (item, result) in enumerate(zip(params, results)):
        name = str(item.get("video_name") or f"video_{index}.mp4")
        if isinstance(result, Exception):
            error_list.append(name)
        else:
            success_list.append({name: result})
    return {
        "status": "success" if success_list else "failed",
        "success_list": success_list,
        "error_list": error_list,
    }
