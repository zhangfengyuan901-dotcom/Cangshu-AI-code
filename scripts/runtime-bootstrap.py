"""Isolated embedded runtime entry point; no machine Python or user site paths."""
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
    import google.adk, veadk, volcenginesdkarkruntime
    from app.root import get_root_agent
    from studio import create_studio
    from creative import install_creative
    assert Path(imageio_ffmpeg.get_ffmpeg_exe()).is_file()
    import tempfile
    with tempfile.TemporaryDirectory(prefix="hamster-runtime-check-") as temporary:
        create_studio(directory=Path(temporary) / "jobs", output=Path(temporary) / "output")
    print("Runtime smoke check passed (web, agents, media, FFmpeg)")
else:
    sys.argv = [str(workflow / "web.py"), *sys.argv[2:]]
    runpy.run_path(sys.argv[0], run_name="__main__")
