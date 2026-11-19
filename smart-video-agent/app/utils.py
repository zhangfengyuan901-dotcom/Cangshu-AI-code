# Copyright (c) 2025 Beijing Volcano Engine Technology Co., Ltd. and/or its affiliates.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import mimetypes
import os
import shutil
from typing import Optional
import threading
import re
from urllib.parse import urlencode

import requests
from google.adk.agents.callback_context import CallbackContext
from google.adk.models import LlmResponse
from veadk.utils.logger import get_logger

logger = get_logger(__name__)


# --- Define the Callback Function ---
def callback_for_debug(callback_context: CallbackContext) -> Optional[LlmResponse]:
    pass


# --- URL Shortener Singleton ---
class UrlShortener:
    _instance = None
    _lock = threading.Lock()

    # 进制转换字符集
    CHAR_SET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    BASE = len(CHAR_SET)

    PREFIX = "⌥"

    def __new__(cls):
        if not cls._instance:
            with cls._lock:
                if not cls._instance:
                    cls._instance = super(UrlShortener, cls).__new__(cls)
                    cls._instance._initialize()
        return cls._instance

    def _initialize(self):
        self._id_lock = threading.Lock()
        self._current_id = 0
        self._short_to_long = {}  # key: short_url, value: original_url
        self._long_to_short = {}  # key: original_url, value: short_url

    def _encode(self, num: int) -> str:
        if num == 0:
            return self.CHAR_SET[0]

        encoded = []
        while num > 0:
            num, remainder = divmod(num, self.BASE)
            encoded.append(self.CHAR_SET[remainder])
        result = "".join(reversed(encoded))

        # Pad to 5 characters
        return result.rjust(5, "0")

    def url2code(self, original_url: str) -> str:
        """
        输入一个url字符串，换出来一个短ID
        """
        try:
            # 1. Check if already exists (Deduplication)
            with self._id_lock:
                if original_url in self._long_to_short:
                    return self._long_to_short[original_url]

                # 2. Increment ID and Encode
                self._current_id += 1
                current_id = self._current_id
                short_code = self._encode(current_id)

            # 3. Construct short ID
            short_id = f"{self.PREFIX}{short_code}"

            # 4. Store mappings
            with self._id_lock:
                # Double check in case another thread inserted it
                self._short_to_long[short_id] = original_url
                self._long_to_short[original_url] = short_id

            return short_id
        except Exception:
            return original_url

    def code2url(self, short_id: str) -> Optional[str]:
        """
        输入这个短ID，换出原始的url
        """
        return self._short_to_long.get(short_id, short_id)

    def replace_in_text(self, text: str) -> str:
        """
        给你一个长字符串，提取短ID并无缝替换回原始URL
        """
        # Pattern matches ⌥<code> where code is 5 characters
        pattern = r"⌥([0-9a-zA-Z]{5})"

        def replace_match(match):
            full_short_id = match.group(0)
            original_url = self.code2url(full_short_id)
            return original_url if original_url != full_short_id else full_short_id

        return re.sub(pattern, replace_match, text)

    def extract_ids_to_urls(self, text: str) -> list[str]:
        """
        从字符串中提取所有短ID并转换为URL列表
        """
        # Pattern matches ⌥<code> where code is 5 characters
        pattern = r"⌥([0-9a-zA-Z]{5})"
        matches = re.findall(pattern, text)

        urls = []
        for code in matches:
            short_id = f"⌥{code}"
            original_url = self.code2url(short_id)
            if original_url != short_id:
                urls.append(original_url)

        return urls


# Global instance
url_shortener = UrlShortener()

def upload_file_to_tos(
    file_path: str,
    object_key: Optional[str] = None,
    region: str = "cn-beijing",
    expires: int = 604800,
) -> Optional[str]:
    """Save final videos locally and upload media to the private R2 bridge."""
    if not os.path.isfile(file_path):
        logger.error(f"File does not exist: {file_path}")
        return None
    media_api = os.getenv("HAMSTER_MEDIA_API", "").strip()
    if not media_api:
        logger.error("HAMSTER_MEDIA_API is not configured")
        return None

    mime_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    if mime_type.startswith("image/"):
        kind = "image"
    elif mime_type.startswith("video/"):
        kind = "video"
    else:
        kind = "audio"

    if kind == "video":
        output_dir = os.getenv("HAMSTER_SMART_VIDEO_OUTPUT_DIR", "").strip()
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            shutil.copy2(file_path, os.path.join(output_dir, os.path.basename(file_path)))

    query = urlencode({"kind": kind, "fileName": os.path.basename(file_path)})
    url = f"{media_api}?{query}"
    headers = {"Content-Type": mime_type}
    try:
        with open(file_path, "rb") as source:
            response = requests.post(url, headers=headers, data=source, timeout=300)
        response.raise_for_status()
        payload = response.json()
        return (payload.get("file") or {}).get("url") or (payload.get("data") or {}).get("download_url")
    except Exception as exc:
        logger.error(f"R2 media upload failed: {exc}")
        return None
