"""Run on the ECS. Prepare or inspect a DNS-01 certificate without changing traffic."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path("/opt/piknoai-relay/direct-origin")
IMAGE = "certbot/certbot@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20"
NAME = "pikno-direct-origin-certificate"


def run(*args, timeout=60):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("Certificate command failed; private output withheld")
    return result.stdout.strip()


def status():
    pending = ROOT / "private/dns-challenge/pending.json"
    state = json.loads(run("docker", "inspect", NAME))[0]["State"]
    result = {"running": state["Running"], "exitCode": state["ExitCode"], "businessTrafficChanged": False}
    if pending.exists():
        result["pendingDNS"] = json.loads(pending.read_text())
    result["certificatePresent"] = (ROOT / "private/letsencrypt/live/pikno-direct-origin/fullchain.pem").is_file()
    return result


def prepare():
    if shutil.disk_usage("/opt").free < 2 * 1024**3:
        raise RuntimeError("Insufficient certificate staging disk space")
    existing = subprocess.run(["docker", "inspect", NAME], capture_output=True)
    if existing.returncode == 0:
        return status()
    for name in ("private", "private/dns-challenge", "private/letsencrypt", "private/certbot-work", "private/certbot-logs"):
        folder = ROOT / name
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(folder, 0o700)
    if list((ROOT / "private/dns-challenge").iterdir()):
        raise RuntimeError("Existing challenge state needs inspection")
    hook = ROOT / "certbot-auth.py"
    if not hook.is_file():
        raise RuntimeError("Missing reviewed DNS hook")
    run("docker", "image", "inspect", IMAGE)
    run("docker", "run", "-d", "--name", NAME, "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
        "-v", str(hook) + ":/hooks/auth.py:ro",
        "-v", str(ROOT / "private/dns-challenge") + ":/state",
        "-v", str(ROOT / "private/letsencrypt") + ":/etc/letsencrypt",
        "-v", str(ROOT / "private/certbot-work") + ":/var/lib/letsencrypt",
        "-v", str(ROOT / "private/certbot-logs") + ":/var/log/letsencrypt", IMAGE,
        "certonly", "--manual", "--preferred-challenges", "dns", "--manual-auth-hook", "python /hooks/auth.py",
        "--non-interactive", "--agree-tos", "--register-unsafely-without-email",
        "--key-type", "rsa", "--rsa-key-size", "2048", "--cert-name", "pikno-direct-origin",
        "-d", "www.piknoai.com", "-d", "origin.piknoai.com")
    return status()


def continue_after_dns(digest):
    pending = json.loads((ROOT / "private/dns-challenge/pending.json").read_text())
    expected = hashlib.sha256(json.dumps(pending["records"], sort_keys=True).encode()).hexdigest()
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or digest != expected or digest != pending["digest"]:
        raise RuntimeError("DNS verification receipt mismatch")
    if time.time() - pending["createdAt"] > 7000:
        raise RuntimeError("DNS challenge expired; inspect certificate process")
    if not status()["running"]:
        raise RuntimeError("Certificate process no longer running")
    (ROOT / "private/dns-challenge/dns-verified.sha256").write_text(digest)
    return {"validationReleased": True, "businessTrafficChanged": False}


if __name__ == "__main__":
    os.umask(0o077)
    try:
        if sys.argv[1:] == ["prepare"]:
            result = prepare()
        elif sys.argv[1:] == ["status"]:
            result = status()
        elif len(sys.argv) == 3 and sys.argv[1] == "continue-after-dns":
            result = continue_after_dns(sys.argv[2])
        else:
            raise RuntimeError("Expected prepare, status or continue-after-dns DIGEST")
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, RuntimeError) else "CERTIFICATE_OPERATION_FAILED"}))
        raise SystemExit(1)
