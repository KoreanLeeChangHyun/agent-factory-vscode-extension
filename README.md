# Agent Factory Main Chat

Turn conversations into defined tasks, delegate them to AI agents, and review
results in VS Code.

## Core features

- **Main, Work, and Verification** — Work directly with Main or delegate tasks
  to Work with a separate Verification agent to check the results.
- **Work contracts** — Turn a conversation into a task list with clear scope
  and completion criteria, then submit it for Work or a Work–Verification loop.
- **Interviews** — Clarify requirements and decisions through guided questions.
- **Document migration and lessons learned** — Update project documents to
  Agent Factory conventions and turn lessons from completed work into reusable rules.
- **Goals** — Submit an objective and follow its progress in chat.
- **Conversation worktrees** — Work in a separate Git worktree for each
  conversation, then merge and return to the original workspace.
- **Reusable notes** — Save global or workspace notes and insert them into messages.
- **Conversation and task history** — Revisit earlier conversations and track
  tasks, agent activity, command output, and code diffs.
- **Files and images** — Attach context to requests and convert image formats
  while keeping the original files.

## Get started

Install Python 3.10+ and Codex CLI in your workspace environment, then run
**Agent Factory: Add Main Agent Chat** from the VS Code Command Palette.
The extension installs the matching Agent Factory companion plugin when needed.

## Claude models

Install and sign in to Claude Code in the same workspace environment. When its
`claude` executable is available, the model picker also offers the pinned model
versions `claude-opus-5-5`, `claude-sonnet-5`, `claude-fable-5-1` and
`claude-haiku-4-5-20251001`, plus the aliases `claude-opus`, `claude-sonnet` and
`claude-haiku`, which Claude Code resolves to the latest model of each family.
Availability depends on your account.

Start a new chat when changing between Codex and Claude, or clear the current
conversation first. Every execution mode works with Claude. Execution permissions
map to the nearest Claude permission mode: Full access and Full bypass use
`bypassPermissions`, Workspace uses `acceptEdits`, and CLI default follows
`permissions.defaultMode` in your Claude settings (read-only when unset). These are
Claude tool permissions, not an OS sandbox. Plan runs in Claude's plan mode and then
continues in the same session. Context usage is shown after each Claude turn.

Set `agentFactory.mainChat.claudePath` when `claude` is not on the workspace PATH or in
`~/.local/bin`. Without a Codex CLI, the extension runs with Claude only; the Agent
Factory plugin must already be installed (install it once with Codex) or
`agentFactory.mainChat.runtimeExecPath` must point to its `exec.py`. The companion bot
uses Claude Haiku when Codex is unavailable.

### Scoped agent defaults

The chat's **Agent settings** dialog changes only that chat. Open **Settings → Agent defaults** and select **Project** or **Global** to configure Main, Work and Verification models and reasoning levels. Values resolve independently in this order: chat → project → global → provider default. **Use parent setting** removes an override; the chat dialog shows the source and effective value.

Defaults use the six `agentFactory.agents.<role>.model` / `reasoningEffort` VS Code settings. Global values are stored in VS Code User settings; project values in the active runtime workspace folder's `.vscode/settings.json`. The extension currently uses the first workspace folder as its runtime project. Chat overrides stay in the existing chat state. Changing a chat no longer writes model defaults for future chats. Existing chats retain their saved explicit choices; new chats inherit scoped defaults.

The resolved model and reasoning values are captured with each submitted message, including queued messages. Later default changes affect future submissions, not already captured requests. Provider/session compatibility checks still apply.
