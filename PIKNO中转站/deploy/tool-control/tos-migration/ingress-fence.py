"""Render a temporary control-route fence without changing the source file."""
import argparse
from pathlib import Path
import re
import sys


HOSTS = ("www.piknoai.com", "origin.piknoai.com")
CONTROL = (b"= /media/v1/tools", b"^~ /media/v1/tools/", b"= /media/v1/packy")
VHOST = re.compile(rb"^    server \{\r?\n.*?^    \}\r?$", re.MULTILINE | re.DOTALL)


def fence(content: bytes) -> bytes:
    """Block the existing three control locations on both reviewed TLS hosts."""
    if len(re.findall(rb"(?m)^    proxy_next_upstream off;[ \t]*\r?$", content)) != 1:
        raise ValueError("Expected the unchanged no-retry proxy directive")

    def block(match: re.Match[bytes]) -> bytes:
        vhost = match[0]
        matched_hosts = [
            host for host in HOSTS
            if re.search(rb"(?m)^        server_name " + re.escape(host.encode()) + rb";[ \t]*\r?$", vhost)
        ]
        if not matched_hosts:
            return vhost
        if len(matched_hosts) != 1 or matched_hosts[0] in blocked:
            raise ValueError("Unexpected control virtual host")
        if not re.search(rb"(?m)^        listen 443 ssl;[ \t]*\r?$", vhost):
            raise ValueError("Expected a TLS control virtual host")
        for route in CONTROL:
            prefix = rb"^        location " + re.escape(route) + rb"[ \t]*\{"
            if len(re.findall(prefix, vhost, flags=re.MULTILINE)) != 1:
                raise ValueError("Expected one control location per virtual host")
            vhost, count = re.subn(
                rb"(" + prefix + rb"[ \t]*)proxy_pass http://task_control;([ \t]*\})",
                rb"\g<1>return 503;\g<2>",
                vhost,
                flags=re.MULTILINE,
            )
            if count != 1:
                raise ValueError("Unexpected control upstream or location layout")
        blocked.add(matched_hosts[0])
        return vhost

    blocked: set[str] = set()
    for route in CONTROL:
        if len(re.findall(rb"(?m)^\s*location " + re.escape(route) + rb"[ \t]*\{", content)) != len(HOSTS):
            raise ValueError("Unexpected number of direct control routes")
    result = VHOST.sub(block, content)
    if blocked != set(HOSTS):
        raise ValueError("Expected both reviewed TLS control hosts")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the rewrite without writing the candidate")
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    try:
        candidate = fence(args.source.read_bytes())
    except (OSError, ValueError) as error:
        parser.exit(1, f"{type(error).__name__}: ingress candidate rejected\n")
    if not args.check:
        sys.stdout.buffer.write(candidate)


if __name__ == "__main__":
    main()
