"""Offline installer smoke check; never access customer configuration or call models."""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

workflow = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(workflow))
sys.dont_write_bytecode = True
os.chdir(workflow)

import uvicorn, fastapi, httpx, PIL, moviepy, imageio_ffmpeg
from volcenginesdkarkruntime import AsyncArk
from studio import create_studio

assert Path(imageio_ffmpeg.get_ffmpeg_exe()).is_file()
ark = AsyncArk(api_key='runtime-check', base_url='https://example.invalid', timeout=1, max_retries=0)
assert ark.files and ark.responses
asyncio.run(ark.close())

async def check():
    with tempfile.TemporaryDirectory(prefix="hamster-install-check-") as temporary:
        app = create_studio(directory=Path(temporary) / "jobs", output=Path(temporary) / "output")
        try:
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
                    response = await client.get('/studio-api/health')
                    assert response.status_code == 200
                    health = response.json()
                    assert health['app'] == 'hamster-smart-video' and health['version'] == 26 and health['chat'] and not health['creative']
                    assert not hasattr(app.state, 'creative')
                    for route in ('/creative/', '/creative-api/config', '/creative-api/jobs'):
                        assert (await client.get(route)).status_code == 404
        finally:
            # Close SQLite even if startup failed, before deleting temporary data on Windows.
            app.state.chat.db.close()

asyncio.run(check())
print('Offline installation smoke check passed')
