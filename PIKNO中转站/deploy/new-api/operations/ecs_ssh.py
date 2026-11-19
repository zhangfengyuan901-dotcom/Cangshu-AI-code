"""Run a read-only Python diagnostic over the configured, host-key-pinned SSH connection."""

import json
from pathlib import Path
import re
import subprocess


DEFAULT_KNOWN_HOSTS = Path(__file__).resolve().parents[1] / 'ecs_known_hosts'


def read_remote(source, *, target, known_hosts=DEFAULT_KNOWN_HOSTS, identity_file=None, timeout=60):
    if not re.fullmatch(r'(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*', target):
        raise ValueError('INVALID_SSH_TARGET')
    known_hosts = Path(known_hosts).resolve(strict=True)
    if not known_hosts.is_file() or any(char in str(known_hosts) for char in '\r\n"'):
        raise ValueError('INVALID_KNOWN_HOSTS')
    command = [
        'ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=10', '-o', f'UserKnownHostsFile="{known_hosts.as_posix()}"',
    ]
    if identity_file is not None:
        identity = Path(identity_file).resolve(strict=True)
        if not identity.is_file():
            raise ValueError('INVALID_SSH_IDENTITY')
        command.extend(['-o', 'IdentitiesOnly=yes', '-i', str(identity)])
    command.extend([target, 'python3 -'])
    result = subprocess.run(command, input=source, capture_output=True, encoding='utf-8', timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError('SSH_READ_FAILED')
    try:
        return json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        raise RuntimeError('SSH_RESPONSE_INVALID') from None
