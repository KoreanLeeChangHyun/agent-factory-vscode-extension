# Agent Factory Main Chat

Agent Factory Main Agent sessions in VS Code editor tabs.

The current vertical slice connects each draft chat panel to the installed Agent Factory
managed runtime through `skills/agent/scripts/exec.py`. It submits the first turn as a new
Main Agent, sends later turns to the same session, polls for the terminal result, and can
cancel the exact active run.

## Development

```sh
npm install
npm run check
```

## F5 manual test

1. Install the Agent Factory plugin and confirm `skills/agent/scripts/exec.py` is present in
   the Codex plugin cache. If it is elsewhere, set
   `agentFactory.mainChat.runtimeExecPath` to its absolute path.
2. Open this extension folder in VS Code, run `npm install`, and press `F5`.
3. When prompted, enter the absolute path of the project to test. The Extension Development
   Host opens that project directly while keeping this extension loaded from
   `extensionDevelopmentPath`; do not use **Open Folder** after launch.
4. Run **Agent Factory: Main Agent 채팅 추가** from the Command Palette.
5. Enter a request. The footer should show the runtime as connected, the stop control should
   appear while the turn is running, and the final Main result should appear as assistant
   text.
6. Start another request and press `Esc` or the stop button to exercise cancellation.

The slice intentionally does not yet implement full event streaming, a durable message
queue, approvals, rich Resume/session management, snapshots and restore, settings capability
negotiation, background notifications, or rich Markdown/tool/diff cards. Attachments are
currently passed as explicit textual references; browser-only pasted files have no filesystem
path until a future attachment materialization flow is added.

Fast and Goal controls use Agent Factory's native local Codex app-server
adapter. Goal status and usage appear separately from run completion; the
composer offers a goal objective plus refresh, pause, reopen, cancel, and off
controls. Both initial messages and exact-session follow-ups carry on/off
settings. See the sibling plugin's [native runtime guide](../plugin/docs/native-fast-goal.md)
for required backend support and recovery limits. Goal continuation belongs to
Main; Work and Verification remain bounded.

The workspace extension host initializes and discovers the private runtime through `exec.py init`, then pins the returned home/project binding. On SSH/container hosts this uses the executing host’s `AGENT_FACTORY_HOME` or `~/.agent-factory`, not the UI machine’s home. Restart the connection after explicit project rebind. The extension no longer builds checkout-local runtime paths.

If a plugin reinstall replaces the versioned cache directory while a chat tab is open, the client rediscovers the newest installed `exec.py` and retries the interrupted runtime command once. Main chat polling also refreshes referenced Work and Verification state while a turn runs; transient refresh failures preserve the last known counts instead of resetting them to zero.
