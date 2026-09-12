#!/usr/bin/env python3
import hashlib
import os
import json
import pathlib
import sys


def option(name):
    return sys.argv[sys.argv.index(name) + 1]


command = sys.argv[1]
if command == "capabilities":
    supported = {key: True for key in ("model", "reasoning", "fast", "goal")}
    print(json.dumps({"kind": "execution-capabilities", "schemaVersion": "0.1.0", "submit": supported, "send": supported}))
    sys.exit(0)
if "--help" in sys.argv:
    print("--agent --model --reasoning-effort --fast --goal-mode")
    sys.exit(0)
project_root = pathlib.Path(option("--project-root"))
runtime_home = pathlib.Path(os.environ['AGENT_FACTORY_HOME'])
project_id = 'project-' + hashlib.sha256(str(project_root.resolve()).encode()).hexdigest()[:32]
agents_root = runtime_home / 'projects' / project_id / 'agents'
if command == 'init':
    agents_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    print(json.dumps({'schemaVersion': 1, 'kind': 'runtime-location', 'registered': True,
        'home': str(runtime_home), 'projectRoot': str(project_root.resolve()), 'projectId': project_id,
        'runtimeRoot': str(agents_root.parent), 'agentsRoot': str(agents_root)}))
    sys.exit(0)
agent_id = option("--agent") if "--agent" in sys.argv else ""
run_id = option("--run-id") if "--run-id" in sys.argv else "run-fake"
with (project_root / "fake-invocations.jsonl").open("a", encoding="utf-8") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\n")

if command == "list":
    print(json.dumps({
        "schemaVersion": "0.1.0",
        "kind": "agent-list",
        "agents": [
            {"agentId": "main-older", "sessionId": "session-older", "role": "main", "updatedAt": "2026-08-30T10:00:00Z"},
            {"agentId": "work-hidden", "sessionId": "session-work", "role": "work", "updatedAt": "2026-09-01T10:00:00Z"},
            {"agentId": "main-newer", "sessionId": "session-newer", "role": "main", "updatedAt": "2026-09-01T09:00:00Z", "model": "gpt-5.6-sol"},
        ],
    }))
elif command in {"submit", "send"}:
    print(json.dumps({
        "schemaVersion": "0.1.0",
        "kind": "ack",
        "status": "accepted",
        "agentId": agent_id,
        "runId": run_id,
    }))
elif command == "status":
    print(json.dumps({
        "schemaVersion": "0.1.0",
        "kind": "status",
        "run": {"status": "completed"},
        "heartbeat": {},
    }))
elif command == "result":
    result_path = agents_root / agent_id / "runs" / run_id / "result.md"
    state_path = result_path.with_name("state.json")
    run = json.loads(state_path.read_text()) if state_path.exists() else {"status": "completed"}
    print(json.dumps({
        "schemaVersion": "0.1.0",
        "kind": "result",
        "run": {"status": "completed", **run, "resultPath": str(result_path)},
    }))
elif command == "cancel":
    print(json.dumps({
        "schemaVersion": "0.1.0",
        "kind": "ack",
        "status": "cancelling",
        "agentId": agent_id,
        "runId": run_id,
    }))
