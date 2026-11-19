import contextlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location("secret_upload",Path(__file__).with_name("upload-promptvv-secret.py"))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SecretTransportTests(unittest.TestCase):
    def test_secret_is_only_in_stdin_and_never_in_arguments_or_output(self):
        secret="synthetic-only-private-api-key"
        output=io.StringIO()
        response=SimpleNamespace(returncode=0,stdout='{"success":true}',stderr="")
        def run(arguments,**options):
            self.assertNotIn(secret," ".join(arguments))
            self.assertEqual(json.loads(options["input"]),{"key":secret})
            self.assertTrue(options["capture_output"])
            self.assertNotIn("shell",options)
            return response
        with mock.patch.object(module.sys,"stdin",io.StringIO(json.dumps({"key":secret}))),mock.patch.object(module.subprocess,"run",side_effect=run),contextlib.redirect_stdout(output):
            module.main()
        self.assertNotIn(secret,output.getvalue())
        self.assertEqual(json.loads(output.getvalue()),{"success":True,"key_configured":True,"mode":"0600","activated":False})

    def test_invalid_key_cannot_dispatch_ssh(self):
        for secret in ["short","x"*513,"private with whitespace","x"*16+"\nINJECTED=true","x"*16+"'", "x"*16+chr(0)]:
            with self.subTest(kind=len(secret)),mock.patch.object(module.sys,"stdin",io.StringIO(json.dumps({"key":secret}))),mock.patch.object(module.subprocess,"run") as run:
                with self.assertRaises(ValueError):
                    module.main()
                run.assert_not_called()

    def test_ssh_error_details_are_not_exposed(self):
        output=io.StringIO()
        with mock.patch.object(module.sys,"stdin",io.StringIO('{"key":"synthetic-only-private-api-key"}')),mock.patch.object(module.subprocess,"run",return_value=SimpleNamespace(returncode=1,stdout="private",stderr="private")),contextlib.redirect_stdout(output):
            with self.assertRaises(RuntimeError) as caught:
                module.main()
        self.assertEqual(str(caught.exception),"")
        self.assertEqual(output.getvalue(),"")

    def test_remote_installer_parses_and_has_no_activation_command(self):
        compile(module.REMOTE,"remote-installer","exec")
        self.assertNotIn("docker",module.REMOTE)
        self.assertNotIn("print(key",module.REMOTE)
        self.assertIn("os.fchmod(fd,0o600)",module.REMOTE)
        self.assertIn("target.is_symlink()",module.REMOTE)

if __name__=="__main__":
    unittest.main()
