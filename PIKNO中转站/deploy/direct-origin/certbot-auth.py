"""Certbot manual DNS hook. Emits only public DNS validation records."""
import hashlib
import json
import os
from pathlib import Path
import re
import time

DOMAINS = {"www.piknoai.com", "origin.piknoai.com"}


def records_digest(records):
    return hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()


def main():
    state = Path("/state")
    domain = os.environ.get("CERTBOT_IDENTIFIER", os.environ.get("CERTBOT_DOMAIN", ""))
    value = os.environ.get("CERTBOT_VALIDATION", "")
    if domain not in DOMAINS or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
        raise RuntimeError("Unexpected certificate challenge")
    record = {"type": "TXT", "name": "_acme-challenge." + domain, "content": value}
    (state / (domain + ".json")).write_text(json.dumps(record))
    if os.environ.get("CERTBOT_REMAINING_CHALLENGES") != "0":
        return
    records = [json.loads(file.read_text()) for file in sorted(state.glob("*.piknoai.com.json"))]
    digest = records_digest(records)
    (state / "pending.json").write_text(json.dumps({"records": records, "digest": digest, "createdAt": time.time()}))
    # The operator continues only after authoritative/public DNS verification.
    # No business request is sent while the certificate process waits.
    for _ in range(3600):
        ready = state / "dns-verified.sha256"
        if ready.is_file() and ready.read_text().strip() == digest:
            return
        time.sleep(2)
    raise RuntimeError("DNS verification wait expired")


if __name__ == "__main__":
    main()
