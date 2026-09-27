"""Desk's terminal supervisor. One in-memory Prompture router per CLI session.

No global agent settings or routing files are modified. This adapter deliberately
fails closed instead of falling back to a CLI's subscription or another model.
"""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
import time


AGENTS = {"claude-code": ("Claude Code", "claude"), "codex": ("Codex CLI", "codex")}


def find_agent(binary):
    # Windows must not discover a same-named executable in the project folder.
    os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
    search = os.pathsep.join(p for p in os.get_exec_path() if Path(p).is_absolute())
    return shutil.which(binary, path=search)


def catalog():
    from prompture.infra.discovery import get_available_models
    from prompture.infra.capabilities import get_capabilities

    models = []
    for name in get_available_models():
        if not isinstance(name, str) or "/" not in name:
            continue
        caps = get_capabilities(name)
        models.append({"id": name, "tools": caps.tool_use})
    return {"models": models, "agents": [
        {"id": key, "name": name, "installed": find_agent(binary) is not None}
        for key, (name, binary) in AGENTS.items()
    ]}


def make_router(model, project, token):
    from prompture.companion.live import LiveBus
    from prompture.companion.router import Router, Routes, _send_json, _error_body
    from prompture.companion.routing_policy import Decision, RoutePolicy, compatible

    class PinnedPolicy(RoutePolicy):
        def decide(self, tool, dialect, requested, kind, **kwargs):
            needs = kwargs.get("needs")
            reason = compatible(model, needs) if needs else None
            if reason:
                return Decision(stop=True, reason=reason)
            return Decision(target=model, source="model", reason="Selected for this terminal session.")

    class SessionRouter(Router):
        def handle(self, handler, method, path, query):
            auth = handler.headers.get("Authorization", "")
            key = handler.headers.get("x-api-key", "")
            if not (secrets.compare_digest(auth, "Bearer " + token) or secrets.compare_digest(key, token)):
                return _send_json(handler, 401, {"error": {"message": "Invalid session token"}})
            return super().handle(handler, method, path, query)

        def _route(self, handler, req, targets, query, **kwargs):
            return super()._route(handler, req, [model], query, vendor_last=False)

        def _pass(self, handler, tool, method, suffix, query, raw, req):
            if method == "POST" and suffix == "/v1/messages/count_tokens":
                # Same approximation used by Prompture's Anthropic gateway.
                from prompture.gateway import estimate_input_tokens
                body = json.loads(raw or b"{}")
                messages = list(body.get("messages") or [])
                if body.get("system"):
                    messages.insert(0, {"role": "system", "content": body["system"]})
                return _send_json(handler, 200, {"input_tokens": estimate_input_tokens(messages, body.get("tools"))})
            # Never forward the CLI's credentials or fall back to its vendor.
            return _send_json(handler, 400, _error_body(tool.dialect,
                "This endpoint is not supported by the selected-model session proxy."))

    routes = Routes(None)
    routes.save({"tools": {key: {"models": {"*": model}} for key in AGENTS}})
    router = SessionRouter(LiveBus(), routes, project_for=lambda agent, session: project)
    router.policy = PinnedPolicy(routes.data)
    return router


def agent_command(agent, base, token, directory, model):
    """Only fixed CLI arguments; user model/folder values never become shell code."""
    env = os.environ.copy()
    for key in ("CLAUDECODE", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"):
        env.pop(key, None)
    env["PROMPTURE_SESSION_TOKEN"] = token
    if agent == "claude-code":
        settings = {"env": {
            "ANTHROPIC_BASE_URL": base + "/tools/claude-code",
            "ANTHROPIC_AUTH_TOKEN": token,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }}
        env.update(settings["env"])
        path = directory / "claude-settings.json"
        path.write_text(json.dumps(settings), encoding="utf-8")
        return ["claude", "--settings", str(path), "--model", model], env
    if agent == "codex":
        return ["codex", "--model", model, "-c", 'model_provider="prompture_session"',
                "-c", 'model_providers.prompture_session.name="Prompture session"',
                "-c", 'model_providers.prompture_session.base_url=' + json.dumps(base + "/tools/codex/v1"),
                "-c", 'model_providers.prompture_session.wire_api="responses"',
                "-c", 'model_providers.prompture_session.env_key="PROMPTURE_SESSION_TOKEN"',
                "-c", "model_providers.prompture_session.requires_openai_auth=false",
                "-c", "model_providers.prompture_session.supports_websockets=false"], env
    raise ValueError("Unsupported agent")


def write_status(directory, **status):
    temp = directory / "status.tmp"
    temp.write_text(json.dumps({**status, "updated": time.time()}), encoding="utf-8")
    temp.replace(directory / "status.json")


def executable_command(binary, agent, args):
    if os.name != "nt" or Path(binary).suffix.lower() not in (".cmd", ".bat"):
        return [binary, *args]
    # Standard npm shims wrap these entry points. Run Node directly so cmd.exe
    # never interprets a model name or a path containing shell metacharacters.
    entry = {"codex": "@openai/codex/bin/codex.js", "claude-code": "@anthropic-ai/claude-code/cli.js"}[agent]
    script = Path(binary).parent / "node_modules" / entry
    node = find_agent("node")
    if not script.is_file() or not node:
        raise RuntimeError("This CLI shim is not a standard npm install. Install the native CLI or its standard npm package.")
    return [node, str(script), *args]


def run(directory):
    config = json.loads((directory / "launch.json").read_text(encoding="utf-8"))
    server = None
    child = None
    try:
        from prompture.companion.server import CompanionServer
        from prompture.companion.routing_policy import compatible, Needs
        from prompture.drivers import get_driver_for_model

        model, agent = config["model"], config["agent"]
        binary = find_agent(AGENTS[agent][1])
        if not binary:
            raise RuntimeError(f"Install {AGENTS[agent][0]} and restart Desk so it can find the CLI on PATH.")
        reason = compatible(model, Needs(tools=True))
        if reason:
            raise RuntimeError(reason)
        get_driver_for_model(model)  # Reject unknown drivers before opening the agent.
        token = secrets.token_urlsafe(32)
        server = CompanionServer(router=make_router(model, config["name"], token), state_path=None)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        command, env = agent_command(agent, server.url, token, directory, model)
        command = executable_command(binary, agent, command[1:])
        env["PROMPTURE_PROJECT"] = config["name"]
        print(f"\n{config['name']} · {AGENTS[agent][0]}\nModel: {model}\nFolder: {config['folder']}\n", flush=True)
        child = subprocess.Popen(command, cwd=config["folder"], env=env)
        write_status(directory, state="running", pid=os.getpid())
        code = child.wait()
        write_status(directory, state="exited", exit_code=code)
        return code
    except KeyboardInterrupt:
        if child is not None:
            child.wait()
        write_status(directory, state="exited", exit_code=130)
        return 130
    except Exception as exc:
        write_status(directory, state="failed", error=str(exc))
        print(f"\nCould not launch session: {exc}", file=sys.stderr, flush=True)
        return 1
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        (directory / "claude-settings.json").unlink(missing_ok=True)


if __name__ == "__main__":
    if sys.argv[1] == "--catalog":
        print("DESK_CATALOG=" + json.dumps(catalog()))
    else:
        sys.exit(run(Path(sys.argv[1])))
