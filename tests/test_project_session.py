"""Run with Python from a current Prompture installation: python -m unittest discover -s tests."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("project_session", Path(__file__).parents[1] / "src-tauri/src/project_session.py")
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)


class Driver:
    supports_tool_use = True
    supports_streaming = True

    def generate_messages(self, messages, options):
        return {"text": "session answer", "meta": {"prompt_tokens": 2, "completion_tokens": 2}}

    def generate_messages_stream(self, messages, options):
        yield {"type": "delta", "text": "session answer"}
        yield {"type": "done", "text": "session answer", "meta": {"prompt_tokens": 2, "completion_tokens": 2}}


class SessionTests(unittest.TestCase):
    def start(self, model="test/one", driver=None):
        from prompture.companion.server import CompanionServer
        router = session.make_router(model, "Test project", "session-token")
        seen = []
        def get_driver(target):
            seen.append(target)
            if driver is False:
                raise RuntimeError("selected provider is offline")
            return driver or Driver()
        router._driver_for = get_driver
        server = CompanionServer(router=router, state_path=None)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, seen, router

    def request(self, server, agent="claude-code", token="session-token", stream=False, max_tokens=30):
        path = "/v1/messages" if agent == "claude-code" else "/v1/responses"
        body = {"model": "original-model", "max_tokens": max_tokens, "stream": stream}
        if agent == "claude-code": body["messages"] = [{"role": "user", "content": "hello"}]
        else: body["input"] = "hello"
        req = urllib.request.Request(server.url + "/tools/" + agent + path,
            data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode()

    def test_two_sessions_keep_their_models(self):
        one, seen_one, router_one = self.start("test/one")
        two, seen_two, router_two = self.start("test/two")
        for server in (one, two, one):
            self.assertEqual(self.request(server)[0], 200)
        self.assertEqual(seen_one, ["test/one", "test/one"])
        self.assertEqual(seen_two, ["test/two"])
        self.assertIsNone(router_one.routes.path)
        self.assertIsNone(router_two.routes.path)

    def test_codex_responses_and_streaming(self):
        server, seen, _ = self.start()
        for agent in ("codex", "claude-code"):
            code, body = self.request(server, agent=agent, stream=True)
            self.assertEqual(code, 200, body)
            self.assertIn("session answer", body)
        self.assertEqual(seen, ["test/one", "test/one"])

    def test_probe_uses_selected_model(self):
        server, seen, _ = self.start()
        self.assertEqual(self.request(server, max_tokens=1)[0], 200)
        self.assertEqual(seen, ["test/one"])

    def test_wrong_token_is_rejected_before_driver(self):
        server, seen, _ = self.start()
        self.assertEqual(self.request(server, token="wrong")[0], 401)
        self.assertFalse(seen)

    def test_token_count_does_not_contact_a_provider(self):
        server, seen, _ = self.start()
        req = urllib.request.Request(server.url + "/tools/claude-code/v1/messages/count_tokens",
            data=json.dumps({"messages": [{"role": "user", "content": "hello"}]}).encode(),
            headers={"x-api-key": "session-token", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as response:
            self.assertGreater(json.load(response)["input_tokens"], 0)
        self.assertFalse(seen)

    def test_unknown_endpoint_never_contacts_vendor(self):
        server, seen, router = self.start()
        req = urllib.request.Request(server.url + "/tools/codex/v1/unsupported",
            headers={"Authorization": "Bearer session-token"})
        with patch.object(router, "upstream_url", side_effect=AssertionError("vendor fallback")):
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(req, timeout=5)
        self.assertEqual(error.exception.code, 400)
        self.assertFalse(seen)

    def test_failure_never_falls_back_to_vendor(self):
        server, seen, router = self.start(driver=False)
        with patch.object(router, "upstream_url", side_effect=AssertionError("vendor fallback")):
            code, body = self.request(server)
        self.assertEqual(code, 502, body)
        self.assertEqual(seen, ["test/one"])

    def test_incompatible_requests_stop(self):
        from prompture.companion.routing_policy import Needs
        _, _, router = self.start()
        decision = router.policy.decide("codex", "openai", "model", "main", needs=Needs(native_only="stored response"))
        self.assertTrue(decision.stop)

    def test_cli_configuration_is_scoped_and_literal(self):
        with tempfile.TemporaryDirectory(prefix="Desk ' & $ ") as tmp:
            folder = Path(tmp)
            for agent in session.AGENTS:
                args, env = session.agent_command(agent, "http://127.0.0.1:1234", "local-token", folder, "test/model; literal")
                self.assertIn("test/model; literal", args)
                self.assertNotIn("--dangerously-skip-permissions", args)
                self.assertNotIn("--yolo", args)
                self.assertEqual(env["PROMPTURE_SESSION_TOKEN"], "local-token")
            settings = json.loads((folder / "claude-settings.json").read_text())
            self.assertEqual(settings["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:1234/tools/claude-code")

    @unittest.skipUnless(os.name == "nt", "Windows npm shim handling")
    def test_npm_shim_never_runs_a_command_shell(self):
        with tempfile.TemporaryDirectory(prefix="Desk & ") as tmp:
            folder = Path(tmp)
            entry = folder / "node_modules/@openai/codex/bin/codex.js"
            entry.parent.mkdir(parents=True)
            entry.write_text("// fixture")
            with patch.object(session, "find_agent", return_value="C:/node/node.exe"):
                command = session.executable_command(str(folder / "codex.cmd"), "codex", ["--model", "test/a&echo"])
            self.assertEqual(command, ["C:/node/node.exe", str(entry), "--model", "test/a&echo"])


if __name__ == "__main__":
    unittest.main()
