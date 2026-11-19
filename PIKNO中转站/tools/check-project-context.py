"""Check the two source trees without requiring built artifacts."""

import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / '仓鼠AI'
RELAY = ROOT / 'PIKNO中转站'


def main():
    state = json.loads((ROOT / '.agents/project-state.json').read_bytes())
    release = json.loads((APP / 'release/current.json').read_bytes())
    result = subprocess.run(
        ['node', str(APP / 'scripts/stage-current-release.cjs'), '--check'],
        cwd=APP, capture_output=True, check=True, encoding='utf-8',
    )
    build = json.loads(result.stdout)
    assert build['ok'] and build['version'] == release['version']
    assert build['historicalReleaseDependencies'] == 0
    assert release['builder']['appId'] == 'com.hamster.ai'
    assert not release['builder']['nsis']['deleteAppDataOnUninstall']
    assert all(path.is_file() for path in (
        RELAY / 'deploy/new-api/Dockerfile',
        RELAY / 'deploy/new-api/backend/go.mod',
        RELAY / 'deploy/new-api/operations/verify-relay.py',
        RELAY / 'build/hamster-trim44-web/bun.lock',
        RELAY / 'cloudflare/relay-media/wrangler.jsonc',
        APP / 'website/wrangler.jsonc',
    ))
    print(json.dumps({'ok': True, 'client_source': build['version'],
                      'website_release': state['website']['release'], 'relay': state['relay']['version']}))


if __name__ == '__main__':
    main()
