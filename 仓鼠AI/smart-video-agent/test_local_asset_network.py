"""Loopback asset access stays local even with an enabled environment proxy."""
import io
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from studio import create_studio


class LocalAssetNetworkTests(unittest.TestCase):
    def test_studio_and_chat_asset_requests_bypass_environment_proxy(self):
        asset_id = 'a' * 32
        image = io.BytesIO()
        Image.new('RGB', (2, 2), 'white').save(image, format='PNG')
        payload = image.getvalue()
        listing = {'items': [{'id': asset_id, 'name': 'fixture', 'ext': 'png'}]}
        requests, proxied = [], []

        class Assets(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                data = payload if self.path.endswith('/file') else json.dumps(listing).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Content-Type', 'image/png' if self.path.endswith('/file') else 'application/json')
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        class Proxy(BaseHTTPRequestHandler):
            def do_GET(self):
                proxied.append(self.path)
                self.send_response(502)
                self.end_headers()

            def log_message(self, *_args):
                pass

        assets = ThreadingHTTPServer(('127.0.0.1', 0), Assets)
        proxy = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        servers = [assets, proxy]
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            proxy_url = 'http://127.0.0.1:' + str(proxy.server_port)
            environment = {key: proxy_url for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')}
            environment.update(NO_PROXY='', no_proxy='', HAMSTER_ASSET_API='http://127.0.0.1:' + str(assets.server_port) + '/api/assets',
                               HAMSTER_PIKNO_MODE='0', HAMSTER_WALLET_MODE='0', HAMSTER_REPORT_URL='', HAMSTER_CONFIG_PATH='')
            with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, environment):
                with TestClient(create_studio(Path(root) / 'jobs', Path(root) / 'out')) as client:
                    response = client.get('/studio-api/assets')
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), listing)
                    ident = client.post('/chat-api/sessions').json()['id']
                    response = client.post('/chat-api/sessions/' + ident + '/assets/' + asset_id)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()['size'], len(payload))
            self.assertEqual(proxied, [])
            self.assertEqual(requests, ['/api/assets', '/api/assets', '/api/assets/' + asset_id + '/file'])
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()
