"""Publish only the official website and its user-provided netdisk link."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / '仓鼠AI/website'
OUT = SITE.parent / 'output/website-netdisk-current'
STATE = ROOT / '.agents/project-state.json'
WORKER = 'hamster-ai-official'
PROFILE = 'default'
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
INSTALLERS = {'.exe', '.msi', '.msix', '.msixbundle', '.appx', '.appxbundle',
              '.dmg', '.pkg', '.appimage', '.deb', '.rpm', '.apk', '.aab',
              '.zip', '.7z', '.rar'}
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def read(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))


def digest(file):
    with file.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def hashed(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def save(name, value):
    require(not OUT.is_symlink(), 'OUTPUT_PATH_INVALID')
    OUT.mkdir(parents=True, exist_ok=True)
    file = OUT / name
    temporary = file.with_name(file.name + '.tmp-' + str(os.getpid()))
    require(not file.is_symlink() and not temporary.exists(), 'OUTPUT_PATH_INVALID')
    with temporary.open('x', encoding='utf-8') as target:
        json.dump(value, target, ensure_ascii=True, indent=2)
        target.write('\n')
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, file)


def distribution():
    state = read(STATE)
    website, client = state['website'], state['client']
    value = website.get('pending_distribution', client['distribution'])
    release = value.get('version', website.get('release', client['released']))
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', release) is not None,
            'WEBSITE_RELEASE_INVALID')
    require(value.get('mode') == 'netdisk_only' and value.get('provider') == 'baidu', 'NETDISK_POLICY_REQUIRED')
    result = {key: value[key] for key in ('mode', 'provider', 'url', 'extraction_code', 'filename')}
    parsed = urllib.parse.urlsplit(result['url'])
    require(parsed.scheme == 'https' and parsed.netloc == 'pan.baidu.com'
            and parsed.path.startswith('/s/') and len(parsed.path) > 3 and not parsed.fragment,
            'NETDISK_URL_INVALID')
    require(re.fullmatch(r'[A-Za-z0-9]{4}', result['extraction_code']) is not None
            and urllib.parse.parse_qs(parsed.query) == {'pwd': [result['extraction_code']]},
            'NETDISK_EXTRACTION_CODE_INVALID')
    require(Path(result['filename']).name == result['filename'] and result['filename'].endswith('.exe'),
            'INSTALLER_DISPLAY_NAME_INVALID')
    require(re.fullmatch(UUID, website['worker_version']) is not None, 'PRODUCTION_VERSION_INVALID')
    return result, website['worker_version'], release


def source_snapshot(site, share):
    require(not site.is_symlink(), 'WEBSITE_PATH_INVALID')
    config = read(site / 'wrangler.jsonc')
    require(config.get('name') == WORKER and config.get('main') == 'src/worker.js', 'WEBSITE_IDENTITY_INVALID')
    require(config.get('assets') == {'directory': './public', 'binding': 'ASSETS', 'run_worker_first': True},
            'WEBSITE_ASSETS_INVALID')
    require(not config.get('r2_buckets'), 'INSTALLER_STORAGE_BINDING_FORBIDDEN')
    require(config.get('cache', {}).get('enabled') is False, 'WEBSITE_CACHE_MUST_BE_DISABLED')
    require(config.get('cache', {}).get('cross_version_cache') is False, 'CROSS_VERSION_CACHE_FORBIDDEN')
    require(config.get('exports') == {'default': {'type': 'worker', 'cache': {'enabled': False}}},
            'DOWNLOAD_EXPORT_FORBIDDEN')
    roots = [site / 'wrangler.jsonc', site / 'src', site / 'public']
    files = []
    for entry in roots:
        require(entry.exists() and not entry.is_symlink(), 'WEBSITE_INPUT_MISSING')
        files.extend([entry] if entry.is_file() else entry.rglob('*'))
    result = {}
    for file in files:
        require(not file.is_symlink(), 'WEBSITE_SYMLINK_FORBIDDEN')
        if not file.is_file():
            continue
        relative = file.relative_to(site).as_posix()
        if relative.startswith('public/'):
            require(file.suffix.lower() not in INSTALLERS, 'PUBLIC_INSTALLER_FORBIDDEN')
            with file.open('rb') as source:
                require(source.read(2) != b'MZ', 'PUBLIC_EXECUTABLE_FORBIDDEN')
            if file.suffix.lower() in ('.html', '.js', '.mjs', '.json'):
                text = file.read_text(encoding='utf-8')
                require('HamsterAI-Portable-' not in text and 'hamsterai.cc/download/' not in text,
                        'PUBLIC_DIRECT_DOWNLOAD_FORBIDDEN')
                require(re.search(r'(?:href|src)\s*=\s*[\"\'][^\"\']*\.exe(?:[?\"\'])', text, re.I) is None,
                        'PUBLIC_DIRECT_DOWNLOAD_FORBIDDEN')
        result[relative] = digest(file)
    home = (site / 'public/index.html').read_text(encoding='utf-8')
    tutorial = (site / 'public/tutorials/index.html').read_text(encoding='utf-8')
    for text in (home, tutorial):
        require(share['url'] in text and share['extraction_code'] in text, 'PUBLIC_NETDISK_LINK_MISSING')
    require(share['filename'] in home, 'PUBLIC_INSTALLER_NAME_MISSING')
    worker = (site / config['main']).read_text(encoding='utf-8')
    require('DOWNLOADS' not in worker and 'class Download' not in worker, 'DOWNLOAD_WORKER_FORBIDDEN')
    return result, config


def cli(*arguments, timeout=240):
    require(arguments[:2] in (('deployments', 'list'), ('versions', 'view'),
                             ('versions', 'upload'), ('versions', 'deploy')),
            'CLI_OPERATION_FORBIDDEN')
    executable = 'npx.cmd' if os.name == 'nt' else 'npx'
    options = {'cwd': SITE, 'stdin': subprocess.DEVNULL, 'stdout': subprocess.PIPE,
               'stderr': subprocess.PIPE, 'env': {**os.environ, 'CI': 'true'}}
    if os.name == 'nt':
        options['creationflags'] = subprocess.CREATE_NO_WINDOW
    else:
        options['start_new_session'] = True
    process = subprocess.Popen([executable, '--yes', 'wrangler@4.151.1', *arguments, '--profile', PROFILE], **options)
    try:
        stdout, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        if process.poll() is None:
            if os.name == 'nt':
                subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW, check=False)
            else:
                os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            process.stdout.close()
            process.stderr.close()
        raise RuntimeError('CONTROLLED_CLI_TIMEOUT') from None
    require(process.returncode == 0, 'CONTROLLED_CLI_FAILED')
    return stdout


def cli_json(*arguments):
    try:
        return json.loads(cli(*arguments))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise RuntimeError('CONTROLLED_CLI_JSON_INVALID') from None


def production_version():
    deployments = cli_json('deployments', 'list', '--name', WORKER, '--json')
    require(isinstance(deployments, list) and bool(deployments), 'PRODUCTION_DEPLOYMENT_MISSING')
    current = max(deployments, key=lambda value: value.get('created_on', ''))
    versions = current.get('versions', [])
    require(len(versions) == 1 and versions[0].get('percentage') == 100, 'PRODUCTION_SPLIT_TRAFFIC')
    version = versions[0].get('version_id', '')
    require(re.fullmatch(UUID, version) is not None, 'PRODUCTION_VERSION_INVALID')
    return version


def version_info(version):
    info = cli_json('versions', 'view', version, '--name', WORKER, '--json')
    require(info.get('id') == version, 'WORKER_IDENTITY_MISMATCH')
    return info['resources']


def compatibility(resources):
    runtime = resources['script_runtime']
    require(bool(runtime.get('compatibility_date')), 'WORKER_COMPATIBILITY_MISSING')
    return {key: runtime.get(key) for key in ('compatibility_date', 'compatibility_flags', 'usage_model', 'limits')}


def target_metadata(resources, plan):
    require(resources.get('bindings') == [{'name': 'ASSETS', 'type': 'assets'}], 'TARGET_BINDINGS_INVALID')
    require(compatibility(resources) == plan['compatibility'], 'TARGET_COMPATIBILITY_CHANGED')


def preflight():
    share, expected, version = distribution()
    sources, config = source_snapshot(SITE, share)
    require(production_version() == expected, 'PRODUCTION_CHANGED_FROM_STATE')
    resources = version_info(expected)
    compat = compatibility(resources)
    require(config['compatibility_date'] == compat['compatibility_date'], 'SOURCE_COMPATIBILITY_CHANGED')
    require(sorted(config.get('compatibility_flags', [])) == sorted(compat['compatibility_flags'] or []),
            'SOURCE_COMPATIBILITY_CHANGED')
    value = {'ready': True, 'checked_at': datetime.now(timezone.utc).isoformat(), 'profile': PROFILE,
             'worker': WORKER, 'baseline_worker_version': expected, 'release': version,
             'distribution': share, 'source_hashes': sources, 'compatibility': compat,
             'baseline_binding_names': sorted(binding['name'] for binding in resources.get('bindings', [])),
             'installer_upload_supported': False, 'production_mutations': 0}
    save('preflight.json', value)
    return {'ready': True, 'profile': PROFILE, 'baseline_worker_version': expected,
            'source_files': len(sources), 'installer_upload_supported': False, 'production_mutations': 0}


def frozen_plan():
    value = read(OUT / 'preflight.json')
    require(value.get('ready') and value.get('worker') == WORKER and value.get('profile') == PROFILE,
            'PREFLIGHT_REQUIRED')
    share, _, version = distribution()
    require(share == value['distribution'] and version == value['release'], 'DISTRIBUTION_CHANGED_AFTER_PREFLIGHT')
    sources, _ = source_snapshot(SITE, share)
    require(sources == value['source_hashes'], 'SOURCE_CHANGED_AFTER_PREFLIGHT')
    return value


@contextmanager
def writer():
    OUT.mkdir(parents=True, exist_ok=True)
    lock = OUT / 'publish.lock'
    try:
        with lock.open('x', encoding='ascii') as file:
            file.write(str(os.getpid()))
    except FileExistsError:
        raise RuntimeError('PUBLISH_WRITER_ALREADY_PRESENT') from None
    try:
        yield
    finally:
        require(lock.read_text(encoding='ascii') == str(os.getpid()), 'PUBLISH_LOCK_CHANGED')
        lock.unlink()


def stage():
    plan = frozen_plan()
    require(production_version() == plan['baseline_worker_version'], 'PRODUCTION_CHANGED_AFTER_PREFLIGHT')
    target_metadata_baseline = version_info(plan['baseline_worker_version'])
    require(compatibility(target_metadata_baseline) == plan['compatibility'], 'BASELINE_METADATA_CHANGED')
    output = cli('versions', 'upload', '--name', WORKER, '--tag', 'netdisk-only',
                 '--message', 'Use user-provided netdisk downloads only', '--keep-vars')
    match = re.search(rb'(?:Worker Version ID|Version ID):\s*(' + UUID.encode() + rb')', output, re.I)
    require(match is not None, 'STAGED_VERSION_UNAVAILABLE')
    version = match.group(1).decode('ascii')
    target_metadata(version_info(version), plan)
    require(frozen_plan()['source_hashes'] == plan['source_hashes'], 'SOURCE_CHANGED_DURING_STAGE')
    require(production_version() == plan['baseline_worker_version'], 'PRODUCTION_CHANGED_DURING_STAGE')
    value = {'staged': True, 'worker_version': version, 'baseline_worker_version': plan['baseline_worker_version'],
             'source_hashes': plan['source_hashes'], 'distribution': plan['distribution'],
             'only_assets_binding': True, 'compatibility_preserved': True, 'traffic_changed': False}
    save('stage.json', value)
    return {'staged': True, 'worker_version': version, 'only_assets_binding': True,
            'compatibility_preserved': True, 'traffic_changed': False}


def checked_stage(plan):
    value = read(OUT / 'stage.json')
    require(value.get('staged') and value['source_hashes'] == plan['source_hashes']
            and value['distribution'] == plan['distribution']
            and value['baseline_worker_version'] == plan['baseline_worker_version'], 'STAGED_PLAN_MISMATCH')
    require(re.fullmatch(UUID, value['worker_version']) is not None, 'STAGED_VERSION_INVALID')
    target_metadata(version_info(value['worker_version']), plan)
    return value


def deploy():
    plan = frozen_plan()
    staged = checked_stage(plan)
    require(production_version() == plan['baseline_worker_version'], 'PRODUCTION_CHANGED_BEFORE_DEPLOY')
    cli('versions', 'deploy', staged['worker_version'] + '@100%', '--name', WORKER, '--yes',
        '--message', 'Netdisk-only official distribution')
    require(production_version() == staged['worker_version'], 'DEPLOYMENT_NOT_OBSERVED')
    target_metadata(version_info(staged['worker_version']), plan)
    value = {'deployed': True, 'release': plan['release'], 'worker_version': staged['worker_version'],
             'previous_worker_version': plan['baseline_worker_version'], 'profile': PROFILE,
             'only_assets_binding': True, 'compatibility_preserved': True, 'netdisk_only': True,
             'automatic_rollback_supported': False}
    save('deployment.json', value)
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        return None


def public_response(opener, url, method='GET', range_request=False, limit=4097):
    headers = {'User-Agent': UA, 'Accept-Encoding': 'identity'}
    if range_request:
        headers['Range'] = 'bytes=0-63'
    request = urllib.request.Request(url, method=method, headers=headers)
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read(limit)


def verify_redirect(status, headers, body, share):
    require(status == 302 and headers.get('Location') == share['url'], 'PUBLIC_NETDISK_REDIRECT_INVALID')
    require('no-store' in headers.get('Cache-Control', '').lower(), 'PUBLIC_REDIRECT_CACHE_INVALID')
    require(not headers.get('Content-Range') and 'octet-stream' not in headers.get('Content-Type', '').lower()
            and len(body) <= 4096 and not body.startswith(b'MZ'), 'PUBLIC_INSTALLER_BYTES_DETECTED')


def verify():
    plan = frozen_plan()
    staged = checked_stage(plan)
    require(production_version() == staged['worker_version'], 'PUBLIC_VERSION_NOT_DEPLOYED')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(), NoRedirect())
    checks = []
    for host in ('hamsterai.cc', 'www.hamsterai.cc'):
        for version in ('1.7.73', '1.7.74', '1.7.75', '1.7.77'):
            path = '/download/HamsterAI-Portable-' + version + '.exe'
            for method, ranged in (('GET', False), ('HEAD', False), ('GET', True)):
                status, headers, body = public_response(opener, 'https://' + host + path, method, ranged)
                verify_redirect(status, headers, body, plan['distribution'])
                checks.append({'host': host, 'path': path, 'method': method, 'range': ranged, 'status': status})
    for path in ('/', '/tutorials/'):
        status, _, body = public_response(opener, 'https://hamsterai.cc' + path, limit=1024 * 1024 + 1)
        require(status == 200, 'PUBLIC_PAGE_UNAVAILABLE')
        require(len(body) <= 1024 * 1024, 'PUBLIC_PAGE_SIZE_UNEXPECTED')
        text = body.decode('utf-8')
        require(plan['distribution']['url'] in text and plan['distribution']['extraction_code'] in text,
                'PUBLIC_PAGE_NETDISK_MISSING')
        require('HamsterAI-Portable-' not in text and re.search(r'href\s*=\s*[\"\'][^\"\']*\.exe', text, re.I) is None,
                'PUBLIC_PAGE_DIRECT_DOWNLOAD_PRESENT')
        checks.append({'path': path, 'status': 200, 'netdisk_link_and_code': True})
    value = {'passed': True, 'checked_at': datetime.now(timezone.utc).isoformat(),
             'release': plan['release'], 'worker_version': staged['worker_version'],
             'official_download': plan['distribution']['url'],
             'extraction_code': plan['distribution']['extraction_code'], 'checks': checks,
             'old_direct_download_disabled': True, 'only_assets_binding': True,
             'share_content_verified': False, 'followed_netdisk_redirects': False}
    save('verification.json', value)
    return {'passed': True, 'release': plan['release'], 'worker_version': staged['worker_version'],
            'checks': len(checks), 'old_direct_download_disabled': True, 'share_content_verified': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('preflight', 'stage', 'deploy', 'verify'))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(args.action not in ('stage', 'deploy') or args.apply, 'EXPLICIT_APPLY_REQUIRED')
    if args.action in ('stage', 'deploy'):
        with writer():
            value = globals()[args.action]()
    else:
        value = globals()[args.action]()
    print(json.dumps(value, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z0-9_]+', str(error)) else 'CONTROLLED_OPERATION_FAILED'
        print(json.dumps({'passed': False, 'code': code, 'automatic_rollback_supported': False}))
        sys.exit(1)
