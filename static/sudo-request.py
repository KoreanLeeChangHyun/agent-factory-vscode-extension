#!/usr/bin/env python3
"""Request one Human-confirmed sudo command through the Agent Factory chat."""
import json
import os
from pathlib import Path
import socket
import sys


def main():
    command = sys.argv[1:]
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("Usage: sudo-request.py -- command [args...]", file=sys.stderr)
        return 2
    path = os.environ.get("AGENT_FACTORY_SUDO_SOCKET")
    token = os.environ.get("AGENT_FACTORY_SUDO_TOKEN")
    if not path or not token:
        print("Agent Factory administrator handoff is unavailable", file=sys.stderr)
        return 2
    parent = os.environ.get("AGENT_FACTORY_PARENT_STATE")
    if not parent:
        print("No active Agent Factory run was found", file=sys.stderr)
        return 2
    run_path = Path(parent)
    request = {"command": command, "runId": run_path.parent.name, "agentId": run_path.parents[2].name,
               "token": token}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(path)
        connection.sendall((json.dumps(request) + "\n").encode())
        with connection.makefile("r", encoding="utf-8") as stream:
            result = json.loads(stream.readline())
    if "error" in result:
        print(result["error"], file=sys.stderr)
        return 1
    sys.stdout.write(result.get("stdout", ""))
    sys.stderr.write(result.get("stderr", ""))
    return result.get("exitCode", 1)


if __name__ == "__main__":
    raise SystemExit(main())
