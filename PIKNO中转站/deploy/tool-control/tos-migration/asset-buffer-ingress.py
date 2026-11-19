"""Render an asset-only request-buffering candidate from the live routing layout."""
import argparse
from pathlib import Path
import re
import sys


SITE = b"        server_name www.piknoai.com;\n"
ASSETS = b"        location ^~ /media/v1/assets/ {\n"
CAPACITY = b"    client_max_body_size 55m;\n"
ZONE = b"\n".join((
    b"    map $request_method $asset_upload_slot {",
    b'        default "";',
    b'        PUT $server_name;',
    b"    }",
    b"    limit_conn_zone $asset_upload_slot zone=asset_uploads:1m;",
    b"",
))
BUFFERING = b"\n".join((
    b"            proxy_request_buffering on;",
    b"            client_body_buffer_size 55m;",
    b"            client_body_timeout 30s;",
    b"            limit_conn asset_uploads 4;",
    b"            limit_conn_status 503;",
    b"",
))


def buffer_assets(content: bytes) -> bytes:
    if content.count(CAPACITY) != 1 or content.count(SITE) != 1 or content.count(ASSETS) != 1:
        raise ValueError("Unexpected asset ingress layout")
    if content.count(b"    proxy_request_buffering off;\n") != 1 or content.count(b"    proxy_next_upstream off;\n") != 1:
        raise ValueError("Expected unchanged global proxy streaming and no retries")
    if b"$asset_upload_slot" in content or b"asset_uploads:" in content:
        raise ValueError("Asset buffering already defined")
    start = content.index(ASSETS)
    end = content.index(b"\n        }", start)
    site = content.index(SITE)
    site_end = content.index(b"\n    }", site)
    if not site < start < end < site_end:
        raise ValueError("Asset route must be inside the www TLS host")
    block = content[start:end]
    directives = rb"(?m)^\s*(?:proxy_request_buffering|client_body_buffer_size|client_body_timeout|client_max_body_size|limit_conn(?:_status)?|client_body_in_file_only)\s"
    if re.search(directives, block) or block.count(b"proxy_pass http://task_control;") != 1:
        raise ValueError("Asset upstream or buffering policy changed")
    if block.count(b"proxy_set_header Host www.piknoai.com;") != 1:
        raise ValueError("Unexpected asset upstream host")
    result = content[:start + len(ASSETS)] + BUFFERING + content[start + len(ASSETS):]
    return result.replace(CAPACITY, ZONE + CAPACITY, 1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--check", action="store_true", help="validate without writing candidate to stdout")
    args = parser.parse_args()
    try:
        candidate = buffer_assets(args.source.read_bytes())
    except (OSError, ValueError):
        parser.exit(1, "Asset buffering candidate rejected\n")
    if not args.check:
        sys.stdout.buffer.write(candidate)


if __name__ == "__main__":
    main()
