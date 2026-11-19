"""Check the active PIKNO relay without submitting any generation or payment request."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from ecs_ssh import DEFAULT_KNOWN_HOSTS, read_remote


HOST = 'https://www.piknoai.com'
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
ROUTES = (
    ('status', '/api/status', None, 200),
    ('catalog', '/api/pikno/catalog', None, 200),
    ('activate', '/assistant/v2/activate', {}, 401),
    ('responses', '/assistant/v2/responses', {'model': 'doubao-seed-2.1-pro'}, 401),
    ('doubao_chat', '/v1/chat/completions', {'model': 'doubao-seed-2.1-pro'}, 401),
    ('legacy_model', '/v1/chat/completions', {'model': 'pikno-chat-standard'}, 404),
    ('generic_responses', '/v1/responses', {'model': 'doubao-seed-2.1-pro'}, 404),
    ('playground', '/pg/chat/completions', None, 404),
    ('legacy_activate', '/assistant/v1/activate', {}, 410),
)


def public_check(route):
    name, path, payload, expected = route
    data = json.dumps(payload).encode() if payload is not None else None
    request = Request(HOST + path, data=data, headers={'User-Agent': USER_AGENT, 'Content-Type': 'application/json'})
    try:
        response = urlopen(request, timeout=12)
    except HTTPError as error:
        response = error
    with response:
        result = {'check': name, 'status': response.code, 'passed': response.code == expected}
        if not result['passed']:
            return result
        if name in {'status', 'catalog'} or expected == 404:
            value = json.load(response)
        if name == 'status':
            result['passed'] = value.get('success') is True
        if name == 'catalog':
            photo = [item for item in value['data']['models'] if item.get('id') == 'pikno-image-flare']
            result['passed'] = len(photo) == 1 and photo[0].get('image_billing') == 'usage-v1'
        if expected == 404:
            result['passed'] = value.get('error', {}).get('type') == 'unsupported_feature'
    return result


REMOTE_CHECK = '''
import json
import subprocess


def run(*arguments, input_text=None):
    result = subprocess.run(arguments, input=input_text, capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        raise RuntimeError('RUNTIME_READ_FAILED')
    return result.stdout


def runtime():
    app = 'piknoai-relay-new-api-1'
    metadata = json.loads(run('docker', 'inspect', '--type', 'container', app))[0]
    digest = run('docker', 'exec', app, 'sha256sum', '/new-api').split()[0]
    env = dict(item.split('=', 1) for item in metadata['Config']['Env'])
    flags = {
        'PIKNO_LLM_ENABLED': 'true',
        'PIKNO_LLM_ARK_VERIFIED': 'true',
        'PIKNO_LLM_ARK_MEDIA_VERIFIED': 'true',
        'PIKNO_LLM_MODEL_VERIFIED': 'false',
        'PIKNO_LLM_BILLING_MODE': 'actual_usage_v1',
        'PIKNO_IMAGE_USAGE_BILLING_ENABLED': 'true',
    }
    query = """
        BEGIN READ ONLY;
        SELECT json_build_object(
            'image_usage_schema', EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'pikno_settlements'
                  AND column_name = 'image_usage_quota' AND is_nullable = 'YES'),
            'doubao_channel', (SELECT count(*) = 1 FROM channels WHERE id = 7 AND status = 1
                AND "group" = 'chat-standard' AND models = 'doubao-seed-2.1-pro'
                AND coalesce(model_mapping, '') <> ''),
            'image_route', (SELECT count(*) = 1 FROM abilities
                WHERE model = 'pikno-image-flare' AND "group" = 'image-standard' AND enabled)
        );
        ROLLBACK;
    """
    db = json.loads(run('docker', 'exec', '-i', 'piknoai-relay-postgres-1',
                        'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'pikno', '-d', 'newapi', input_text=query))
    return {
        'healthy': metadata['State'].get('Health', {}).get('Status') == 'healthy',
        'image_matches_state': metadata['Image'] == EXPECTED_IMAGE,
        'binary_matches_state': digest == EXPECTED_BINARY,
        'policy_matches': env.get('PIKNO_LLM_ARK_CHANNEL_ID') == '7' and all(env.get(k) == v for k, v in flags.items()),
        **{k: db.get(k) is True for k in ('image_usage_schema', 'doubao_channel', 'image_route')},
    }


try:
    print(json.dumps(runtime()))
except Exception:
    print(json.dumps({'runtime_read_failed': True}))
'''


def relay_release(state_file):
    if state_file is None:
        state_file = next((parent / '.agents' / 'project-state.json' for parent in Path(__file__).resolve().parents
                           if (parent / '.agents' / 'project-state.json').is_file()), None)
    if state_file is None:
        raise RuntimeError('RELEASE_STATE_MISSING')
    release = json.loads(state_file.read_text(encoding='utf-8-sig'))['relay']
    image, binary = release['production_image_id'], release['binary_sha256']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image) or not re.fullmatch(r'[0-9a-f]{64}', binary):
        raise RuntimeError('RELEASE_STATE_INVALID')
    return image, binary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ecs', action='store_true', help='also verify Docker runtime and read-only database facts over SSH')
    parser.add_argument('--ssh-target', default=os.getenv('PIKNO_ECS_SSH_TARGET'), help='SSH host alias or user@host')
    parser.add_argument('--known-hosts', type=Path, default=DEFAULT_KNOWN_HOSTS)
    parser.add_argument('--identity-file', type=Path, default=os.getenv('PIKNO_ECS_SSH_IDENTITY'))
    parser.add_argument('--state', type=Path, help='override the workspace release state location')
    args = parser.parse_args()
    if args.ecs and not args.ssh_target:
        parser.error('--ecs requires an SSH target')
    with ThreadPoolExecutor(max_workers=3) as executor:
        checks = list(executor.map(public_check, ROUTES))
    report = {'passed': all(check['passed'] for check in checks), 'checked_at': datetime.now(timezone.utc).isoformat(),
              'public_checks': checks, 'inference_calls': 0, 'payment_calls': 0}
    if args.ecs:
        image, binary = relay_release(args.state)
        expected = f'EXPECTED_IMAGE = {image!r}\nEXPECTED_BINARY = {binary!r}\n'
        result = read_remote(expected + REMOTE_CHECK, target=args.ssh_target, known_hosts=args.known_hosts,
                             identity_file=args.identity_file)
        required = ('healthy', 'image_matches_state', 'binary_matches_state', 'policy_matches',
                    'image_usage_schema', 'doubao_channel', 'image_route')
        report['ecs_checks'] = {name: result.get(name) is True for name in required}
        report['passed'] = report['passed'] and all(report['ecs_checks'].values())
    print(json.dumps(report, ensure_ascii=True))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        code = str(error) if isinstance(error, (RuntimeError, ValueError)) and re.fullmatch(r'[A-Z0-9_]+', str(error)) else 'VERIFICATION_FAILED'
        print(json.dumps({'passed': False, 'code': code}))
        sys.exit(1)
