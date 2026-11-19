"""Offline renewal recovery tests. No Docker, network or real certificate use."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('renew',Path(__file__).with_name('renew-certificate.py'))
M=importlib.util.module_from_spec(spec)
with patch.dict(sys.modules,{'fcntl':SimpleNamespace(flock=lambda *a:None,LOCK_EX=1,LOCK_NB=2)}):spec.loader.exec_module(M)

class Renewal(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self,changed=True):
        with tempfile.TemporaryDirectory() as directory,contextlib.ExitStack() as stack:
            root=Path(directory);source=root/'private/letsencrypt/live/pikno-direct-origin';target=root/'private/ingress-tls'
            source.mkdir(parents=True);target.mkdir(parents=True)
            for name in ('fullchain.pem','privkey.pem'):
                (source/name).write_bytes(('new-'+name).encode());(target/name).write_bytes((('old-' if changed else 'new-')+name).encode())
            state={'reloads':0,'fail_reload':False,'fail_config':False,'fail_certbot':False,'bad_key':False,'fail_live':False}
            def run(*args,**kwargs):
                if args[:2]==('docker','run') and state['fail_certbot']:raise ValueError('mock-certbot')
                if args[:2]==('openssl','x509') and '-pubkey' in args:return b'public'
                if args[:2]==('openssl','pkey'):return b'wrong' if state['bad_key'] else b'public'
                if args[-2:]==('nginx','-t') and state['fail_config']:raise ValueError('mock-config')
                if args[-3:]==('nginx','-s','reload'):
                    state['reloads']+=1
                    if state['fail_reload']:raise ValueError('mock-reload')
                return b''
            def live(*args):
                if state['fail_live']:raise ValueError('mock-live')
            stack.enter_context(patch.object(M,'ROOT',root));stack.enter_context(patch.object(M,'run',run));stack.enter_context(patch.object(M,'cleanup_container'));stack.enter_context(patch.object(M,'verify_live_certificate',live));stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield root,source,target,state

    def test_reload_failure_retries_unchanged_files(self):
        with self.fixture() as (root,source,target,state):
            state['fail_reload']=True
            with self.assertRaises(ValueError):M.main('renew')
            self.assertFalse((root/'private/nginx-certificate-loaded.sha256').exists())
            self.assertEqual((source/'fullchain.pem').read_bytes(),(target/'fullchain.pem').read_bytes())
            state['fail_reload']=False;M.main('renew');self.assertEqual(state['reloads'],2)
            M.main('renew');self.assertEqual(state['reloads'],2)

    def test_first_run_reloads_even_when_files_match(self):
        with self.fixture(False) as (root,source,target,state):
            M.main('reconfigure');self.assertEqual(state['reloads'],1)
            self.assertTrue((root/'certificate-reconfigure-status.json').exists())
            M.main('renew');self.assertTrue((root/'certificate-reconfigure-status.json').exists());self.assertEqual(state['reloads'],1)

    def test_invalid_nginx_restores_pair_and_retries(self):
        with self.fixture() as (root,source,target,state):
            state['fail_config']=True
            with self.assertRaises(ValueError):M.main('renew')
            self.assertEqual((target/'fullchain.pem').read_bytes(),b'old-fullchain.pem')
            self.assertEqual((target/'privkey.pem').read_bytes(),b'old-privkey.pem')
            self.assertEqual(state['reloads'],0)
            state['fail_config']=False;M.main('renew');self.assertEqual(state['reloads'],1)

    def test_second_copy_failure_restores_pair(self):
        with self.fixture() as (root,source,target,state):
            original=M.replace;failed=False
            def replace(path,data):
                nonlocal failed
                if path==target/'privkey.pem' and not failed:failed=True;raise OSError('mock-full-disk')
                return original(path,data)
            with patch.object(M,'replace',replace),self.assertRaises(OSError):M.main('renew')
            self.assertEqual((target/'fullchain.pem').read_bytes(),b'old-fullchain.pem');self.assertEqual((target/'privkey.pem').read_bytes(),b'old-privkey.pem')
            M.main('renew');self.assertEqual(state['reloads'],1)

    def test_stale_temp_does_not_block_recovery(self):
        with self.fixture() as (root,source,target,state):
            (target/'privkey.pem.renew-tmp').write_bytes(b'synthetic-interrupted')
            M.main('renew');self.assertEqual(state['reloads'],1)

    def test_failed_replace_removes_own_temp(self):
        with self.fixture() as (root,source,target,state):
            with patch.object(M.os,'replace',side_effect=OSError('mock-error')),self.assertRaises(OSError):M.replace(target/'new',b'value')
            self.assertEqual(list(target.glob('new.renew-*')),[])

    def test_failed_certificate_validation_keeps_target(self):
        for flag in ('fail_certbot','bad_key'):
            with self.subTest(flag=flag),self.fixture() as (root,source,target,state):
                state[flag]=True
                with self.assertRaises(ValueError):M.main('renew')
                self.assertEqual((target/'fullchain.pem').read_bytes(),b'old-fullchain.pem');self.assertEqual(state['reloads'],0)
                self.assertFalse((root/'certificate-renewal-status.json').exists())

    def test_reload_signal_without_live_certificate_retries(self):
        with self.fixture() as (root,source,target,state):
            state['fail_live']=True
            with self.assertRaises(ValueError):M.main('renew')
            self.assertFalse((root/'private/nginx-certificate-loaded.sha256').exists())
            state['fail_live']=False;M.main('renew');self.assertEqual(state['reloads'],2)

    def test_later_live_mismatch_invalidates_saved_acknowledgement(self):
        with self.fixture() as (root,source,target,state):
            M.main('renew');state['fail_live']=True
            with self.assertRaises(ValueError):M.main('renew')
            self.assertFalse((root/'private/nginx-certificate-loaded.sha256').exists())
            state['fail_live']=False;M.main('renew');self.assertEqual(state['reloads'],2)

    def test_cleanup_rejects_unrelated_container(self):
        data={'Id':'synthetic','Config':{'Image':M.IMAGE,'Labels':{}},'State':{'Running':True},'HostConfig':{'AutoRemove':True}}
        with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps([data]).encode())),patch.object(M,'run') as command:
            with self.assertRaises(ValueError):M.cleanup_container()
            command.assert_not_called()

    def test_cleanup_stops_only_owned_exact_id(self):
        data={'Id':'synthetic','Config':{'Image':M.IMAGE,'Labels':{M.LABEL:'true'}},'State':{'Running':True},'HostConfig':{'AutoRemove':True}}
        with patch.object(M.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps([data]).encode())),patch.object(M,'run') as command:
            M.cleanup_container();command.assert_called_once_with('docker','stop','-t','20','synthetic',timeout=30)

if __name__=='__main__':unittest.main()
