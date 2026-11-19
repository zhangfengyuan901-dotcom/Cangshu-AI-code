"""Offline workbench contract tests: no paid model requests."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from studio import configured_keys, create_studio, relay_key_configured


class StudioTests(unittest.TestCase):
    def test_pikno_mode_keeps_customer_keys_out_of_python(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "config.json"
            config.write_text(json.dumps({"apiKey": "old-key", "billingApiKey": "old-wallet"}))
            with patch.dict(os.environ, {"HAMSTER_CONFIG_PATH": str(config), "HAMSTER_PIKNO_MODE": "1", "HAMSTER_WALLET_MODE": "0", "MODEL_AGENT_API_KEY": "hamster-cloud-session", "MODEL_AGENT_API_BASE": "http://127.0.0.1:12345/api/inference/api/v3"}), patch('studio.relay_execution_context', return_value={'EXECUTION_SCOPE':'a'*64,'CONFIG_REVISION':1}):
                keys = configured_keys()
                self.assertEqual(keys['SANBAO_API_KEY'], 'hamster-relay-session')
                self.assertEqual(keys['MODEL_AGENT_API_KEY'], 'hamster-cloud-session')
                self.assertNotIn('old-key', json.dumps(keys))
                self.assertNotIn('old-wallet', json.dumps(keys))

    def test_pikno_readiness_tracks_local_configuration_without_reading_customer_keys(self):
        environment = {"HAMSTER_PIKNO_MODE": "1", "HAMSTER_WALLET_MODE": "0",
                       "HAMSTER_WALLET_API": "http://127.0.0.1:12345",
                       "MODEL_AGENT_API_KEY": "hamster-cloud-session"}
        with patch.dict(os.environ, environment), patch('studio.build_opener') as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            for status, expected in [
                    ({"configured": False,"scope":"","revision":1}, False),
                    ({"configured": True,"scope":"a"*64,"revision":1}, True),
                    ({"configured": True,"scope":"b"*64,"revision":2}, True),
                    ({"configured": True,"scope":"real-account-123","revision":1}, False),
                    ({"configured": True,"scope":"a"*64,"revision":0}, False),
                    ({"configured": True,"scope":"a"*64,"revision":True}, False),
                    ({"configured": "true","scope":"a"*64,"revision":1}, False)]:
                response.read.return_value = json.dumps(status).encode()
                values = configured_keys()
                self.assertEqual(bool(values["MODEL_AGENT_API_KEY"]), expected)
                request = opener.return_value.open.call_args.args[0]
                self.assertEqual(request.full_url, "http://127.0.0.1:12345/api/inference/context")
                self.assertEqual(request.get_method(), "GET")
                self.assertNotIn("authorization", {key.lower() for key in request.headers})
                response.read.assert_called_with(4096)
            opener.return_value.open.side_effect = OSError('local service unavailable')
            self.assertEqual(configured_keys()["MODEL_AGENT_API_KEY"], "")

    def test_pikno_readiness_rejects_foreign_or_invalid_local_status_destinations(self):
        with patch('studio.build_opener') as opener:
            for base in ("https://127.0.0.1:12345", "http://localhost:12345", "http://foreign.test:12345",
                         "http://127.0.0.1:12345/path", "http://user:pass@127.0.0.1:12345",
                         "http://127.0.0.1:12345?private=value", "http://127.0.0.1:bad", "http://["):
                with patch.dict(os.environ, {"HAMSTER_WALLET_API": base}):
                    self.assertFalse(relay_key_configured())
            opener.assert_not_called()

    def test_pikno_chat_disables_submission_without_image_or_video_key(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
                "HAMSTER_PIKNO_MODE": "1", "HAMSTER_WALLET_MODE": "0", "MODEL_AGENT_API_KEY": "hamster-cloud-session"}), patch('studio.relay_execution_context', return_value={}):
            with TestClient(create_studio(Path(root) / "jobs", Path(root) / "out")) as client:
                self.assertFalse(client.get('/chat-api/config').json()['ready'])
                self.assertEqual(client.get('/creative-api/config').status_code, 404)
                self.assertEqual(configured_keys()['SANBAO_API_KEY'], '')
    def test_wallet_mode_ignores_legacy_key_and_tracks_email_logout(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "config.json"
            with patch.dict(os.environ, {"HAMSTER_CONFIG_PATH": str(config), "HAMSTER_WALLET_MODE": "1", "MODEL_AGENT_API_KEY": "cloud-session"}):
                config.write_text(json.dumps({"apiKey": "old-key"}))
                self.assertEqual(configured_keys()["MODEL_AGENT_API_KEY"], "")
                config.write_text(json.dumps({"apiKey": "old-key", "billingApiKey": "fixture-session"}))
                self.assertEqual(configured_keys()["MODEL_AGENT_API_KEY"], "cloud-session")
                self.assertEqual(configured_keys()["SANBAO_API_KEY"], "hamster-wallet-session")

    def test_cloud_inference_activates_only_with_main_key(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "config.json"
            environment = {"HAMSTER_CONFIG_PATH": str(config), "MODEL_AGENT_API_KEY": "cloud-session",
                           "MODEL_AGENT_API_BASE": "http://127.0.0.1:8787/api/inference/api/v3",
                           "LLM_ENDPOINT_ID": "hamster-auto"}
            with patch.dict(os.environ, environment):
                config.write_text(json.dumps({"llmApiKey": "legacy-local-secret", "llmEndpointId": "ep-legacy-test"}))
                self.assertEqual(configured_keys()["MODEL_AGENT_API_KEY"], "")
                config.write_text(json.dumps({"apiKey": "main-key", "llmApiKey": "legacy-local-secret"}))
                values = configured_keys()
                self.assertEqual(values["MODEL_AGENT_API_KEY"], "cloud-session")
                self.assertEqual(values["MODEL_AGENT_API_BASE"], environment["MODEL_AGENT_API_BASE"])
                self.assertEqual(values["LLM_ENDPOINT_ID"], "hamster-auto")

    def test_workbench_navigation_has_only_chat(self):
        with tempfile.TemporaryDirectory() as root:
            with TestClient(create_studio(Path(root) / "jobs", Path(root) / "out")) as client:
                self.assertEqual(client.get("/", follow_redirects=False).headers["location"], "/chat/")
                response = client.get('/chat/')
                self.assertEqual(response.status_code, 200)
                self.assertIn('href="/chat/" aria-current="page"', response.text)
                self.assertNotIn('/creative/', response.text)
                self.assertNotIn('创意工作台', response.text)
                self.assertNotIn('智能成片', response.text)
                self.assertEqual(client.get("/workbench.css").status_code, 200)

    def test_creative_business_is_not_imported_registered_or_allowed_to_touch_history(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            history = root / 'creative-data' / 'history.json'
            history.parent.mkdir()
            history.write_text('{"status":"running","fixture":"preserve"}', encoding='utf-8')
            exported = root / 'results' / '创意工作台' / '旧提示词.txt'
            exported.parent.mkdir(parents=True)
            exported.write_text('客户历史输出', encoding='utf-8')
            originals = {file: file.read_bytes() for file in (history, exported)}
            with patch.dict(sys.modules, {'creative': None, 'creative_prompt': None, 'creative_result': None}):
                app = create_studio(root / 'jobs', root / 'results')
                self.assertFalse(hasattr(app.state, 'creative'))
                with TestClient(app) as client:
                    health = client.get('/studio-api/health').json()
                    self.assertEqual(health['version'], 26)
                    self.assertTrue(health['chat'])
                    self.assertFalse(health['creative'])
                    for route in ('/creative/', '/creative/creative.js', '/creative-api/config', '/creative-api/jobs',
                                  '/creative-api/media/fixture', '/creative-api/jobs/fixture/result'):
                        self.assertEqual(client.get(route).status_code, 404, route)
                    for route in ('/creative-api/media', '/creative-api/asset/fixture', '/creative-api/analyze/fixture',
                                  '/creative-api/jobs/fixture/script', '/creative-api/jobs/fixture/adapt', '/creative-api/jobs/fixture/cancel'):
                        self.assertEqual(client.post(route, json={}).status_code, 404, route)
                    self.assertEqual(client.post('/chat-api/sessions').status_code, 201)
            for file, original in originals.items():
                self.assertEqual(file.read_bytes(), original)

    def test_smart_video_http_feature_is_removed(self):
        with tempfile.TemporaryDirectory() as root:
            with TestClient(create_studio(Path(root) / "jobs", Path(root) / "out")) as client:
                self.assertEqual(client.get("/studio-api/health").json()["app"], "hamster-smart-video")
                self.assertEqual(client.post("/studio-api/jobs", json={"product": "开衫"}).status_code, 404)
                self.assertEqual(client.get("/studio-api/jobs").status_code, 404)
                self.assertEqual(client.post("/studio-api/upload", content=b"bad image").status_code, 404)


if __name__ == "__main__":
    unittest.main()
