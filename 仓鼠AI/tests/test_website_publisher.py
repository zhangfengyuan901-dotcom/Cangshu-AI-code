"""Isolated checks for the netdisk-only website publication boundary."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SOURCE = ROOT / 'scripts/publish-website.py'
spec = importlib.util.spec_from_file_location('netdisk_publisher', SOURCE)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
OLD = '841d3848-6bb0-4016-b8c4-98a2530a182e'
NEW = '11111111-2222-4333-8444-555555555555'
SHARE = {'mode': 'netdisk_only', 'provider': 'baidu',
         'url': 'https://pan.baidu.com/s/fixture?pwd=njd6', 'extraction_code': 'njd6',
         'filename': '仓鼠AI-1.7.77.exe'}
COMPAT = {'compatibility_date': '2026-09-16', 'compatibility_flags': [], 'usage_model': 'standard', 'limits': None}


class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hamster-netdisk-publisher-')
        self.root = Path(self.temporary.name)
        self.site = self.root / 'website'
        self.out = self.root / 'out'
        self.state = self.root / 'state.json'
        self.config = {'name': publisher.WORKER, 'main': 'src/worker.js',
                       'compatibility_date': COMPAT['compatibility_date'],
                       'assets': {'directory': './public', 'binding': 'ASSETS', 'run_worker_first': True},
                       'cache': {'enabled': False, 'cross_version_cache': False},
                       'exports': {'default': {'type': 'worker', 'cache': {'enabled': False}}}}
        self.write('wrangler.jsonc', json.dumps(self.config))
        self.write('src/worker.js', 'export default { fetch() {} };')
        self.write('public/index.html', SHARE['url'] + ' ' + SHARE['filename'] + ' njd6')
        self.write('public/tutorials/index.html', SHARE['url'] + ' njd6')
        self.state.write_text(json.dumps({'client': {'released': '1.7.77', 'distribution': SHARE},
                                          'website': {'worker_version': OLD}}), encoding='utf-8')
        self.patches = [patch.object(publisher, 'SITE', self.site), patch.object(publisher, 'OUT', self.out),
                        patch.object(publisher, 'STATE', self.state)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.assertTrue(self.root.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()))
        self.temporary.cleanup()

    def write(self, name, value):
        file = self.site / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(value, encoding='utf-8')
        return file

    def plan(self):
        hashes, _ = publisher.source_snapshot(self.site, SHARE)
        result = {'ready': True, 'worker': publisher.WORKER, 'profile': publisher.PROFILE,
                  'baseline_worker_version': OLD, 'release': '1.7.77', 'source_hashes': hashes,
                  'compatibility': COMPAT, 'distribution': copy.deepcopy(SHARE)}
        publisher.save('preflight.json', result)
        return result

    def staged(self, plan):
        result = {'staged': True, 'worker_version': NEW, 'baseline_worker_version': OLD,
                  'source_hashes': plan['source_hashes'], 'distribution': plan['distribution']}
        publisher.save('stage.json', result)
        return result

    def resources(self, bindings=None):
        return {'script_runtime': COMPAT,
                'bindings': bindings if bindings is not None else [{'name': 'ASSETS', 'type': 'assets'}]}

    def test_user_share_and_code_are_bound(self):
        self.assertEqual(publisher.distribution(), (SHARE, OLD, '1.7.77'))
        state = publisher.read(self.state)
        state['client']['distribution']['extraction_code'] = 'xxxx'
        self.state.write_text(json.dumps(state), encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'NETDISK_EXTRACTION_CODE_INVALID'):
            publisher.distribution()

    def test_public_installers_are_rejected_before_cli(self):
        for suffix in publisher.INSTALLERS:
            file = self.write('public/fixture' + suffix, 'synthetic installer')
            with self.assertRaisesRegex(RuntimeError, 'PUBLIC_INSTALLER_FORBIDDEN'):
                publisher.source_snapshot(self.site, SHARE)
            file.unlink()

    def test_renamed_executable_is_rejected(self):
        file = self.site / 'public/renamed.bin'
        file.write_bytes(b'MZsynthetic executable')
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_EXECUTABLE_FORBIDDEN'):
            publisher.source_snapshot(self.site, SHARE)

    def test_old_r2_binding_and_download_export_are_rejected(self):
        for field, value, code in [('r2_buckets', [{'binding': 'DOWNLOADS', 'bucket_name': 'fixture'}], 'INSTALLER_STORAGE_BINDING_FORBIDDEN'),
                                   ('exports', {'Download': {'type': 'worker'}}, 'DOWNLOAD_EXPORT_FORBIDDEN')]:
            self.write('wrangler.jsonc', json.dumps({**self.config, field: value}))
            with self.assertRaisesRegex(RuntimeError, code):
                publisher.source_snapshot(self.site, SHARE)

    def test_old_public_direct_link_is_rejected(self):
        self.write('public/legacy.html', '<a href="/download/HamsterAI-Portable-1.7.75.exe">old</a>')
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_DIRECT_DOWNLOAD_FORBIDDEN'):
            publisher.source_snapshot(self.site, SHARE)

    def test_frozen_source_blocks_stage_without_cli_mutation(self):
        self.plan()
        self.write('public/changed.txt', 'changed after review')
        with patch.object(publisher, 'cli') as command:
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_CHANGED_AFTER_PREFLIGHT'):
                publisher.stage()
            command.assert_not_called()

    def test_source_changed_during_stage_cannot_be_deployed(self):
        self.plan()
        def changed(*args):
            self.write('public/changed.txt', 'changed during upload')
            return ('Worker Version ID: ' + NEW).encode()
        with patch.object(publisher, 'production_version', return_value=OLD), \
             patch.object(publisher, 'version_info', return_value=self.resources()), \
             patch.object(publisher, 'cli', side_effect=changed) as command:
            with self.assertRaisesRegex(RuntimeError, 'SOURCE_CHANGED_AFTER_PREFLIGHT'):
                publisher.stage()
            self.assertEqual(command.call_count, 1)
        self.assertFalse((self.out / 'stage.json').exists())

    def test_stage_accepts_only_assets_binding(self):
        plan = self.plan()
        publisher.target_metadata(self.resources(), plan)
        with self.assertRaisesRegex(RuntimeError, 'TARGET_BINDINGS_INVALID'):
            publisher.target_metadata(self.resources([{'name': 'ASSETS', 'type': 'assets'},
                                                       {'name': 'DOWNLOADS', 'type': 'r2_bucket'}]), plan)
        changed = self.resources()
        changed['script_runtime'] = {**COMPAT, 'compatibility_flags': ['different']}
        with self.assertRaisesRegex(RuntimeError, 'TARGET_COMPATIBILITY_CHANGED'):
            publisher.target_metadata(changed, plan)

    def test_production_drift_blocks_deploy(self):
        self.staged(self.plan())
        with patch.object(publisher, 'version_info', return_value=self.resources()), \
             patch.object(publisher, 'production_version', return_value=NEW), \
             patch.object(publisher, 'cli') as command:
            with self.assertRaisesRegex(RuntimeError, 'PRODUCTION_CHANGED_BEFORE_DEPLOY'):
                publisher.deploy()
            command.assert_not_called()

    def test_one_publisher_writer_is_enforced(self):
        with publisher.writer():
            with self.assertRaisesRegex(RuntimeError, 'PUBLISH_WRITER_ALREADY_PRESENT'):
                with publisher.writer():
                    pass
        self.assertFalse((self.out / 'publish.lock').exists())

    def test_redirect_must_be_exact_uncached_and_without_installer_body(self):
        good = {'Location': SHARE['url'], 'Cache-Control': 'no-store'}
        publisher.verify_redirect(302, good, b'', SHARE)
        for status, headers, body, code in [(200, good, b'MZ', 'PUBLIC_NETDISK_REDIRECT_INVALID'),
                                            (302, {**good, 'Location': 'https://example.com'}, b'', 'PUBLIC_NETDISK_REDIRECT_INVALID'),
                                            (302, {**good, 'Cache-Control': 'public'}, b'', 'PUBLIC_REDIRECT_CACHE_INVALID'),
                                            (302, good, b'MZsynthetic', 'PUBLIC_INSTALLER_BYTES_DETECTED'),
                                            (302, {**good, 'Content-Range': 'bytes 0-63/100'}, b'', 'PUBLIC_INSTALLER_BYTES_DETECTED')]:
            with self.assertRaisesRegex(RuntimeError, code):
                publisher.verify_redirect(status, headers, body, SHARE)

    def test_verify_never_follows_netdisk(self):
        self.assertIsNone(publisher.NoRedirect().redirect_request(None, None, 302, '', {}, SHARE['url']))

    def test_public_probe_checks_the_ordinary_cache_path(self):
        requests = []
        class Response:
            status = 302
            headers = {'Location': SHARE['url'], 'Cache-Control': 'no-store'}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, limit): return b''
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return Response()
        publisher.public_response(Opener(), 'https://hamsterai.cc/download/fixture.exe')
        self.assertIsNone(requests[0].get_header('Cache-control'))
        self.assertIsNone(requests[0].get_header('Pragma'))

    def test_mutation_requires_explicit_apply(self):
        for action in ('stage', 'deploy'):
            result = subprocess.run([sys.executable, str(SOURCE), action], capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['code'], 'EXPLICIT_APPLY_REQUIRED')

    def test_object_storage_commands_are_not_available(self):
        with patch.object(publisher.subprocess, 'Popen') as process:
            with self.assertRaisesRegex(RuntimeError, 'CLI_OPERATION_FORBIDDEN'):
                publisher.cli('r2', 'object', 'put', 'synthetic')
            process.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
