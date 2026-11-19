"""Install one user-authorized secret via SSH stdin; print whitelist metadata."""
import base64
import json
from pathlib import Path
import shlex
import subprocess
import sys

REMOTE = r'''
import json,os,pathlib,sys,tempfile
try:
    key=json.load(sys.stdin).get("key","")
    if not isinstance(key,str) or not 16<=len(key)<=512 or any(ord(c)<33 or ord(c)>126 or c in "\\\"'" for c in key):
        raise ValueError()
    root=pathlib.Path("/opt/piknoai-relay/current")
    target=root/".promptvv-reverse.env"
    if root.resolve()!=root or target.is_symlink():
        raise ValueError()
    data=("PIKNO_REVERSE_API_KEY='"+key+"'\n").encode()
    if target.exists():
        if not target.is_file() or target.read_bytes()!=data:
            print(json.dumps({"success":False,"code":"EXISTING_SECRET_REQUIRES_REVIEW"}))
            raise SystemExit(1)
    else:
        fd,name=tempfile.mkstemp(prefix=".reverse-key-",dir=root)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,"wb") as stream:
                stream.write(data);stream.flush();os.fsync(stream.fileno())
            os.replace(name,target)
        finally:
            if os.path.exists(name):os.unlink(name)
    os.chmod(target,0o600)
    print(json.dumps({"success":True,"key_configured":True,"mode":"0600","activated":False}))
except Exception:
    print(json.dumps({"success":False,"code":"SECRET_INSTALL_FAILED","sensitive_output_withheld":True}))
    raise SystemExit(1)
'''
def main():
    payload=json.load(sys.stdin)
    key=payload.get("key")
    if not isinstance(key,str) or not 16<=len(key)<=512 or any(ord(c)<33 or ord(c)>126 or c in "\\\"'" for c in key):
        raise ValueError()
    encoded=base64.b64encode(REMOTE.encode()).decode()
    command="python3 -c "+shlex.quote("import base64;exec(base64.b64decode("+repr(encoded)+"))")
    args=["ssh","-T","-i","C:/Users/ZhuanZ/Desktop/_PIKNO.pem","-o","BatchMode=yes","-o","IdentitiesOnly=yes","-o","StrictHostKeyChecking=yes","-o","UserKnownHostsFile="+str(Path(__file__).resolve().parents[1]/"ecs_known_hosts"),"root@8.217.68.247",command]
    result=subprocess.run(args,input=json.dumps({"key":key}),text=True,capture_output=True,encoding="utf8",timeout=45)
    if result.returncode:
        raise RuntimeError()
    response=json.loads(result.stdout)
    if response.get("success") is not True:
        raise RuntimeError()
    print(json.dumps({"success":True,"key_configured":True,"mode":"0600","activated":False}))
if __name__=="__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"success":False,"code":"SECRET_UPLOAD_FAILED","sensitive_output_withheld":True}))
        raise SystemExit(1)
