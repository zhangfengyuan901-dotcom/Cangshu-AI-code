"""Anonymous fault metadata only. Never serialize exceptions or customer content."""
import os
from pathlib import Path
from urllib.parse import urlsplit
import httpx


async def report_fault(module, error=None, status=0):
    try:
        endpoint = os.getenv('HAMSTER_REPORT_URL', '')
        url = urlsplit(endpoint)
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path != '/api/error-report' or url.username or url.query:
            return
        status = int(status or getattr(error, 'status_code', 0) or 0)
        code = 'AUTH_FAILED' if status in (401, 403) else 'RATE_LIMITED' if status == 429 else 'REQUEST_FAILED' if status >= 400 else 'UNEXPECTED'
        frames, trace = [], getattr(error, '__traceback__', None)
        while trace:
            name = Path(trace.tb_frame.f_code.co_filename).name
            if name in ('chat.py', 'creative.py', 'studio.py'):
                frames.append({'file': name, 'line': trace.tb_lineno})
            trace = trace.tb_next
        payload = {'module': module if module in ('chat', 'creative', 'service', 'interface') else 'service',
                   'code': code, 'httpStatus': status if 0 <= status <= 599 else 0, 'frames': frames[-6:]}
        async with httpx.AsyncClient(timeout=1, trust_env=False) as client:
            await client.post(endpoint, json=payload)
    except Exception:
        pass  # Reporting never changes the customer's operation or retries generation.
