"""Renew the direct origin certificate and reload validated Nginx files."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time

ROOT=Path('/opt/piknoai-relay/direct-origin')
IMAGE='certbot/certbot@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20'
CONTAINER='pikno-direct-origin-renew'
LABEL='pikno.direct-origin.certificate-renewal'

def run(*args,timeout=600):
    r=subprocess.run(args,capture_output=True,timeout=timeout)
    if r.returncode:raise ValueError('CERTIFICATE_OPERATION_FAILED')
    return r.stdout


def replace(path,data):
    # Unique same-directory files also recover from an interrupted prior copy.
    fd,temporary=tempfile.mkstemp(prefix=path.name+'.renew-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.chmod(temporary,0o600);os.replace(temporary,path)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)


def cleanup_container():
    result=subprocess.run(['docker','container','inspect',CONTAINER],capture_output=True,timeout=15)
    if result.returncode:
        if b'No such container' in result.stderr or b'No such object' in result.stderr:return
        raise ValueError('CERTIFICATE_CONTAINER_INSPECT_FAILED')
    info=json.loads(result.stdout)[0]
    if info['Config'].get('Labels',{}).get(LABEL)!='true' or info['Config']['Image']!=IMAGE:
        raise ValueError('CERTIFICATE_CONTAINER_OWNER_MISMATCH')
    if info['State']['Running']:run('docker','stop','-t','20',info['Id'],timeout=30)
    # --rm normally removes it after stop. Only remove an exited exact ID.
    if not info['HostConfig'].get('AutoRemove'):run('docker','rm',info['Id'],timeout=15)


def verify_live_certificate(source):
    first=source.read_text().split('-----END CERTIFICATE-----',1)[0]+'-----END CERTIFICATE-----\n'
    expected=hashlib.sha256(ssl.PEM_cert_to_DER_cert(first)).hexdigest()
    context=ssl.create_default_context()
    for attempt in range(10):
        try:
            with socket.create_connection(('127.0.0.1',443),timeout=3) as connection:
                with context.wrap_socket(connection,server_hostname='www.piknoai.com') as tls:
                    if hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest()==expected:return
        except (OSError,ssl.SSLError):pass
        if attempt<9:time.sleep(0.5)
    raise ValueError('LIVE_CERTIFICATE_NOT_LOADED')

def main(mode):
    os.umask(0o077)
    with (ROOT/'private/renewal.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        for folder in (ROOT/'acme-webroot',ROOT/'acme-webroot/.well-known',ROOT/'acme-webroot/.well-known/acme-challenge'):
            if folder.is_symlink():raise ValueError('CHALLENGE_PATH_REJECTED')
            folder.mkdir(mode=0o755,exist_ok=True);os.chmod(folder,0o755)
        cleanup_container()
        args=['docker','run','--rm','--name',CONTAINER,'--label',LABEL+'=true','--read-only','--cap-drop','ALL',
              '--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,size=32m']
        for source,target in [('private/letsencrypt','/etc/letsencrypt'),('private/certbot-work','/var/lib/letsencrypt'),
                              ('private/certbot-logs','/var/log/letsencrypt'),('acme-webroot','/var/www/acme')]:
            args+=['-v',str(ROOT/source)+':'+target]
        if mode=='reconfigure':
            args +=[IMAGE,'reconfigure','--cert-name','pikno-direct-origin','--webroot','--webroot-path','/var/www/acme',
                    '--preferred-challenges','http','--non-interactive']
        elif mode=='renew':
            args +=[IMAGE,'renew','--cert-name','pikno-direct-origin','--non-interactive','--quiet']
        else:raise ValueError('INVALID_MODE')
        try:run(*args)
        except Exception:
            cleanup_container()
            raise
        source=ROOT/'private/letsencrypt/live/pikno-direct-origin'
        run('openssl','x509','-in',str(source/'fullchain.pem'),'-checkend','604800','-noout')
        for host in ('www.piknoai.com','origin.piknoai.com'):
            run('openssl','x509','-in',str(source/'fullchain.pem'),'-noout','-checkhost',host)
        public=run('openssl','x509','-in',str(source/'fullchain.pem'),'-noout','-pubkey')
        if public!=run('openssl','pkey','-in',str(source/'privkey.pem'),'-pubout'):raise ValueError('KEY_MISMATCH')
        target=ROOT/'private/ingress-tls'
        fingerprint=hashlib.sha256((source/'fullchain.pem').read_bytes()).hexdigest()
        loaded=ROOT/'private/nginx-certificate-loaded.sha256'
        changed=any((source/name).read_bytes()!=(target/name).read_bytes() for name in ('fullchain.pem','privkey.pem'))
        if changed:
            previous={name:(target/name).read_bytes() for name in ('fullchain.pem','privkey.pem')}
            try:
                for name in previous:replace(target/name,(source/name).read_bytes())
            except Exception:
                for name,data in previous.items():replace(target/name,data)
                raise
        reload_needed=changed or not loaded.exists() or loaded.read_text().strip()!=fingerprint
        if reload_needed:
            compose=['docker','compose','--env-file',str(ROOT/'ingress.env'),'-f',str(ROOT/'compose.yaml')]
            try:run(*compose,'exec','-T','ingress','nginx','-t')
            except Exception:
                if changed:
                    for name,data in previous.items():replace(target/name,data)
                raise
            run(*compose,'exec','-T','ingress','nginx','-s','reload')
            verify_live_certificate(source/'fullchain.pem')
            # Only acknowledge after a successful reload. A failed reload or
            # interrupted run must retry even if the served files already match.
            replace(loaded,(fingerprint+'\n').encode())
        else:
            try:verify_live_certificate(source/'fullchain.pem')
            except Exception:
                loaded.unlink(missing_ok=True)
                raise
        result={'ok':True,'mode':mode,'certificateChanged':changed,'nginxReloaded':reload_needed,
                'certificateSha256':fingerprint,'liveCertificateVerified':True}
        replace(ROOT/('certificate-'+mode+'-status.json'),json.dumps(result,indent=2).encode())
        replace(ROOT/'certificate-renewal-status.json',json.dumps(result,indent=2).encode());print(json.dumps(result))

if __name__=='__main__':
    try:main(sys.argv[1])
    except Exception:
        print('{"ok":false,"error":"CERTIFICATE_RENEWAL_FAILED","privateDetailsWithheld":true}')
        raise SystemExit(1)
