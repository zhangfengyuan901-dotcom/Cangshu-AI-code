"""Start the standalone local Hamster workbench."""
import argparse
import os
import threading
import uvicorn
from studio import create_studio

def watch_parent():
    """A retained Windows process handle cannot accidentally follow a reused PID."""
    pid = int(os.getenv("HAMSTER_PARENT_PID", "0"))
    if os.name != "nt" or not pid:
        return
    import ctypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    if not handle:
        raise RuntimeError("无法确认主应用进程，工作台未启动")
    def wait():
        result = kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        kernel.CloseHandle(handle)
        if result == 0:
            os._exit(0)
    threading.Thread(target=wait, daemon=True).start()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    watch_parent()
    uvicorn.run(create_studio(), host="127.0.0.1", port=args.port)
