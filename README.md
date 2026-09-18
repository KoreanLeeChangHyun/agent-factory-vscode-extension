# Agent Factory Main Chat

Use Agent Factory Main Agent sessions in VS Code editor tabs.

## Features

- Stream conversations, resume sessions, and follow Work and Verification activity.
- Organize chats into workspace-local groups.
- Attach files and images; view Markdown, command output, and diffs.
- Enter/send always runs directly through Main, including after restoring old saved modes.
- Send the current draft with one of six one-message actions: Work, Plan, Verification,
  Plan · Work, Work · Verification, or Plan · Work · Verification. Actions do not persist.
- Plan only returns a plan using actual Work Plan collaboration mode. Standalone
  Verification dispatches a managed verifier for the explicit target, otherwise prior
  completed work in this chat; Main asks if no target is available.
- Workflow choices immediately submit the current draft once; ordinary sends use Normal.
- Goal immediately submits the current draft as a goal and sits before Fast. Fast remains a persistent toggle.
- Permissions and attachments remain available.
- **Plan · Work** runs actual Codex Plan then implementation in the same Work
  session, followed by Main checks without separate Verification. It requires
  runtime support; queued inputs retain their action and different actions never merge.

## Setup

1. Install Python 3.10+ and Codex CLI on the workspace extension host. For
   SSH/container workspaces, install them on the remote host.
2. Install the extension and run **Agent Factory: Add Main Agent Chat** from the
   Command Palette. On first activation, the extension checks Codex and installs
   the matching companion plugin if needed. SSH, WSL and container workspaces use
   the workspace extension host's Codex installation and home.
3. If startup fails, follow the error guidance and select **Retry** to rerun setup.
   If you dismiss the notification, reload the extension host to try again.
   Reload the extension host after updating the VSIX.

For standalone plugin use or manual repair:

```sh
codex plugin marketplace add KoreanLeeChangHyun/agent-factory-codex-plugin --ref main
codex plugin marketplace upgrade agent-factory
codex plugin add agent-factory@agent-factory
```

### Companion plugin requirement

- The plugin must be installed and enabled with the identical semantic base version.
  Extension `1.0.11` accepts plugin `1.0.11+codex.<token>`.
- An already compatible installed plugin requires only a local installed-list check.
- If the plugin is missing, disabled or mismatched, activation registers the
  official `agent-factory` marketplace from the source above when absent, then
  checks the available catalog and will attempt one compatible plugin installation.
  It prefers the official source and still supports compatible configured alternatives.
  A different or unconfirmed source under the official name produces a conflict
  error; existing sources are never overwritten or automatically upgraded.
- Setup confirms the installed plugin is enabled and matches the extension after
  installation. If the exact version is unavailable or setup fails, activation blocks
  and offers **Retry**. No arbitrary latest version is substituted. Retry repeats
  the checks; concurrent requests share setup and chat bootstrap happens once.
- The plugin is fully installable and usable without this extension. Both are
  released together; the extension does not contain or bundle the plugin.
- Set `agentFactory.mainChat.pythonPath` if Python is not found. Use
  `agentFactory.mainChat.runtimeExecPath` only for an explicit installed `exec.py`
  path; it does not waive the matching-plugin requirement.

## Development

```sh
npm install
npm run check
```

- Press **F5** to launch the Extension Development Host.
- Use `npm run package` to build a VSIX.
- Release tooling is in [scripts/release.mjs](scripts/release.mjs). Publish the
  matching companion plugin first. The default extension release workflow prepares
  the VSIX and hands off Marketplace upload to Playwright; preparation is not
  publication success.
