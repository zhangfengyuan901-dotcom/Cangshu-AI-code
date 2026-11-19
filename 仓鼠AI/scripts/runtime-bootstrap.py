"""Isolated embedded runtime entry point; no machine Python or user site paths."""
import asyncio
import os
import runpy
import sys
from pathlib import Path

check = sys.argv[1] == "--check"
workflow = Path(sys.argv[2] if check else sys.argv[1]).resolve()
sys.path.insert(0, str(workflow))
sys.dont_write_bytecode = True
os.chdir(workflow)
if check:
    import uvicorn, fastapi, httpx, PIL, moviepy, imageio_ffmpeg
    from volcenginesdkarkruntime import AsyncArk
    from studio import create_studio
    from chat import install_chat
    from chat_media import inspect_video
    assert Path(imageio_ffmpeg.get_ffmpeg_exe()).is_file()
    client = AsyncArk(api_key="runtime-check", base_url="https://example.invalid", timeout=1, max_retries=0)
    assert client.files and client.responses
    asyncio.run(client.close())
    import tempfile
    with tempfile.TemporaryDirectory(prefix="hamster-runtime-check-") as temporary:
        app = create_studio(directory=Path(temporary) / "jobs", output=Path(temporary) / "output")
        assert not hasattr(app.state, "creative")
        app.state.chat.db.close()
    assert "creative" not in sys.modules
    print("Runtime smoke check passed (chat, media, FFmpeg; creative retired)")
else:
    sys.argv = [str(workflow / "web.py"), *sys.argv[2:]]
    runpy.run_path(sys.argv[0], run_name="__main__")
