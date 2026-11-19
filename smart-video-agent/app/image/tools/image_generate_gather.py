"""Batch image generation through the Sanbao upstream."""

import asyncio
import os
from typing import Dict

from google.adk.tools import ToolContext

from app.sanbao import generate, result_url


SIZE_TO_RATIO = {
    "2048x2048": "1:1", "2384x1728": "4:3", "1728x2304": "3:4",
    "2560x1440": "16:9", "1440x2560": "9:16", "2496x1664": "3:2",
    "1664x2496": "2:3", "3024x1296": "21:9",
}


def _references(task: dict) -> list:
    value = task.get("image") or task.get("reference") or []
    return value if isinstance(value, list) else [value]


async def _generate_one(task: dict) -> str:
    size = str(task.get("size") or "1:1")
    model = os.getenv("SANBAO_IMAGE_MODEL", "image_2_5_flare")
    if model not in {"image_2_5_flare", "image_2_5_sunburst"}:
        model = "image_2_5_flare"
    payload = {
        "model": model,
        "prompt": str(task.get("prompt") or ""),
        "aspect_ratio": SIZE_TO_RATIO.get(size, size),
        "images": [item for item in _references(task) if item],
        "quality": "auto",
        "concurrency": 1,
    }
    return result_url(await generate("images", payload), "images")


async def image_generate(tasks: list[dict], tool_context: ToolContext) -> Dict:
    """Generate one or more candidate images for every storyboard shot."""
    jobs = []
    keys = []
    for task_index, task in enumerate(tasks):
        is_group = str(task.get("task_type", "")).endswith("_group")
        count = int(task.get("max_images", 1)) if is_group else 1
        for image_index in range(max(1, count)):
            jobs.append(_generate_one(task))
            keys.append(f"task_{task_index}_image_{image_index}")

    results = await asyncio.gather(*jobs, return_exceptions=True)
    success_list = []
    error_list = []
    for key, result in zip(keys, results):
        if isinstance(result, Exception):
            error_list.append(key.rsplit("_image_", 1)[0])
        else:
            success_list.append({key: result})
    return {
        "status": "success" if success_list else "failed",
        "success_list": success_list,
        "error_list": sorted(set(error_list)),
    }
