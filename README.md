# Agent Factory Main Chat

Agent Factory Main Agent sessions in VS Code editor tabs.

## Required companion plugin

This extension requires an installed and enabled Agent Factory Codex plugin with
the identical semantic base version. Extension `1.0.6` accepts plugin
`1.0.6+codex.<token>`, for example, but not another semantic base version.

During activation, the extension first checks the small installed-plugin list. Only
when the plugin is missing or mismatched does it request the bounded available catalog,
prefer the official `agent-factory` marketplace, and attempt one compatible plugin
installation. It rechecks the installed-plugin list to confirm that the required plugin is
installed and enabled before registering commands and views. If the requirement is
still unmet, activation blocks and reports the problem. Install or update the plugin
manually with:

```bash
codex plugin marketplace add KoreanLeeChangHyun/agent-factory-codex-plugin --ref main
codex plugin marketplace upgrade agent-factory
codex plugin add agent-factory@agent-factory
```

The plugin remains fully installable and usable without this extension. The plugin
and extension are released together and must stay on matching semantic base versions.
The extension invokes Codex plugin installation; it does not contain or bundle the
plugin.

## macOS setup

1. Install Python 3.10+ and Codex CLI on the **workspace extension host**, and
   configure the matching companion plugin described above. SSH/container windows
   use the remote host's tools and paths.
2. Ensure `codex` and its interpreter (for example, Node for an npm installation)
   are on the host's `PATH`. On macOS, child processes also search
   `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin` after inherited entries.
   Custom version-manager paths must be present in VS Code's environment; launch
   VS Code from the configured terminal if needed. Shell startup files are not executed
   by the extension to discover tools.
3. Set `agentFactory.mainChat.pythonPath` to your Python 3.10+ executable if
   `python3` resolves to an older system Python, for example
   `/opt/homebrew/bin/python3` on an Apple Silicon Homebrew installation or
   `/usr/local/bin/python3` on an Intel installation. Use the actual installed
   path, without shell arguments. Paths containing spaces are supported.
4. The plugin is normally discovered under `$CODEX_HOME/plugins/cache` or
   `~/.codex/plugins/cache`. `agentFactory.mainChat.runtimeExecPath` can select
   its `skills/agent/scripts/exec.py` explicitly. Run that script's `doctor`
   command with the selected Python before the first managed run.

The companion runtime's macOS backend uses kernel boot/process identity and private
process groups. Descendants that create another session can escape group cancellation;
this has weaker lifecycle containment than Linux cgroups. Codex sandbox policy remains
separate, and a sandbox failure never triggers a wider permission fallback. `doctor`
does not prove native sandbox readiness. Validate submit, follow-up, cancellation and
the intended permissions on the actual Mac; this change has not been validated on
Mac hardware. See the plugin's `skills/agent/references/home-runtime.md` for the
containment and host-readiness contract.

## Features

- Open Main Agent sessions in editor tabs; stream activity and resume sessions.
- Render Markdown code fences, Bash commands, ANSI command output, and file diffs.
- Submit, follow up, and cancel runs through the installed Agent Factory runtime.
- Deliver browser PNG, JPEG, GIF, and WebP attachments through the plugin's
  versioned image-input contract. The extension requires the runtime capability
  flag and stops the request instead of reducing an unsupported image to text metadata.
- Keep sent-image previews in restored chat history and open originals only through
  host-owned attachment identifiers and validated storage paths.

Image bytes are handled by the extension-host bundle that is already loaded for the
chat tab. Installing a newer VSIX changes files on disk but does not replace that
running bundle; reload the VS Code extension host before retrying an image attachment.
- Use native Fast/Goal controls and inspect Work/Verification status.
- Choose status information and drag to reorder it with **상태 표시줄 설정** in the chat footer; see [status bar customization](docs/status-bar.md).
- Organize Main Agent chats in the Agent Factory activity-bar sidebar, with workspace-local names and groups.
- Follow delegated Work and Verification runs in chat cards with live status, session links, and expandable command details.

## Agent sidebar

Open the factory icon in the activity bar to browse Main Agent chats. Use **+** to create a chat, the folder button to create a group, and refresh to discover sessions created outside this window. Select an agent to open its chat; already-open chats are revealed without creating another tab.

Use an agent's context menu to rename it or change its group. Group menus support renaming and ungrouping; ungrouping preserves every agent. Names and groups persist in the current VS Code workspace. Running chats display a spinner. Work and Verification sessions remain accessible from their Main chat's agent list.

Drag one or more selected agents onto a group to move them. Dropping onto another agent uses that agent's group; dropping onto empty space removes the group assignment. These changes are saved automatically.

Opening a bound chat reconnects to its existing accepted or active run and follows progress and completion without submitting another request. The stop button cancels that run. Closing a chat detaches the display without cancelling the background runtime.

## Automatic transcript scrolling

The compact down-arrow toggle beside Send controls automatic scrolling. Its tooltip
shows **자동 스크롤 ON/OFF**, and its pressed state indicates ON. It defaults to ON.
Turning it OFF preserves the transcript scroll position during new messages,
streaming updates, rerenders, and queued-message acceptance. Unchanged messages stay
mounted; OFF does not write the transcript scroll position or switch browser scroll
anchoring. Changed messages are replaced in place without clearing the transcript. Turning it ON jumps
to the latest content and resumes following. With ON selected, scrolling upward
still pauses following until you return near the bottom, as before; submitting or
accepting a message can resume following. With OFF selected, these events never
re-enable automatic scrolling. Manual scrolling and question-list navigation remain
available. The preference is saved per webview panel and restored on reload.

## Syntax highlighting

- **Theme selection:** read `tui.theme` from `$CODEX_HOME/config.toml` (default: `~/.codex/config.toml`) on the workspace extension host, including SSH/container hosts.
- **Built-in themes:** support all 32 CLI theme names using the compiled two-face theme data. Built-in names take precedence over custom filenames.
- **Custom themes:** load `$CODEX_HOME/themes/<name>.tmTheme`; reload when the configuration/theme changes or the tab becomes active.
- **Fallback:** no selection uses Catppuccin Mocha/Latte according to the VS Code appearance. Invalid themes show a notice and restore the default. High-contrast modes use GitHub high-contrast themes for readability.
- **ANSI:** render standard/bright, 256-color and RGB foreground/background, bold, italic, underline and resets using safe text nodes. Terminal palette colors follow VS Code terminal colors. Cursor movement and other terminal controls are discarded; output is a transcript, not a terminal emulator.
- **Languages:** bundle 28 Shiki grammars with aliases such as `py`, `ts`, `js`, `sh` and `shell`. A missing fence language can be inferred from an explicit shebang; otherwise unrecognized code remains plain text.
- **Limits:** oversized blocks (over 512,000 characters or 10,000 lines), unsupported languages and highlighting failures preserve the source as plain text.
- **CLI differences:** Shiki/TextMate and CLI Syntect grammars can assign different scopes. Theme data is shared, but token boundaries, supported languages and high-contrast overrides are not identical. Syntax themes do not replace the editor background.

### Theme data maintenance

- Regenerate `src/webview/cli-themes.json` with `python3 scripts/generate-cli-themes.py`.
- The generator verifies the pinned two-face bundle hash before decoding it.
- Preserve/update the source and license notices in `static/vendor/cli-themes.LICENSE.txt` when changing the pin.

## Development

```sh
npm install
npm run check
```

## Installation requirement

Extension version 1.0.6 requires an installed and enabled Agent Factory plugin with the
same semantic base version, 1.0.6. A plugin cachebuster suffix such as
`1.0.6+codex.<token>` is accepted. During activation the extension checks configured
Codex marketplaces and, when necessary, installs one compatible available plugin before
registering its commands and views. The official `agent-factory` marketplace is preferred.

The coordinated deployment process must publish and configure the official marketplace
before distributing the VSIX. If no compatible plugin is available, activation stops and
shows an actionable error. Setting `agentFactory.mainChat.runtimeExecPath` does not waive
this plugin requirement.

## Rendering regression checks

- Unit tests: `npm test`.
- Browser tests: `node tests/browser/chat-rendering.cjs` after `npm run build`.
- Install Playwright and Chromium in your test environment. Set `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when using external installations.
- Packaging: `npm run package`; install the resulting VSIX in the workspace extension host.

## F5 manual test

1. Configure a marketplace that provides Agent Factory plugin semantic version 1.0.6.
   Activation installs the compatible plugin when needed. Confirm
   `skills/agent/scripts/exec.py` is present in the Codex plugin cache; if it is elsewhere,
   set `agentFactory.mainChat.runtimeExecPath` to its absolute path after satisfying the
   plugin requirement.
2. Open this extension folder in VS Code, run `npm install`, and press `F5`.
3. When prompted, enter the absolute path of the project to test. The Extension Development
   Host opens that project directly while keeping this extension loaded from
   `extensionDevelopmentPath`; do not use **Open Folder** after launch.
4. Run **Agent Factory: Main Agent 채팅 추가** from the Command Palette.
5. Enter a request. The footer should show the runtime as connected, the stop control should
   appear while the turn is running, and the final Main result should appear as assistant
   text.
6. Start another request and press `Esc` or the stop button to exercise cancellation.

## Runtime notes

- **바이패스** uses the same unrestricted sandbox and `never` execution approval policy as **전체 접근**, and additionally authorizes Main to pass the delegation gate without asking the Human to approve its plan again. Main proceeds with the best bounded interpretation of the request, while missing credentials or genuinely unresolved required Human decisions may still require input. The captured task mode remains unchanged.
- New chats default to **전체 접근**: full filesystem and network access with approval policy `never` (no additional execution approval). Between runs, use **권한** to choose workspace write or CLI defaults instead. The selection is saved in the machine-scoped `agentFactory.mainChat.executionMode` setting; previously configured alternatives are preserved. Workspace write also uses `never`; CLI defaults use Codex settings for new sessions and are labeled **현재 정책 유지** in existing sessions, preserving the stored policy. Changes apply to the next message, including in existing sessions; active runs are unchanged. Resumed sessions preserve their stored policy until you explicitly choose a mode in that panel.

- Attachments are passed as textual references. Browser-only pasted files need a filesystem path before the runtime can use them.
- Plugin installation and VS Code extension installation are separate; reinstalling the plugin does not update these webview assets.

Fast and Goal controls use Agent Factory's native local Codex app-server
adapter. Goal status and usage appear separately from run completion; the
composer offers a goal objective plus refresh, pause, reopen, cancel, and off
controls. Both initial messages and exact-session follow-ups carry on/off
settings. See the installed plugin's `skills/agent/SKILL.md` for runtime requirements and role boundaries. Goal continuation belongs to
Main; Work and Verification remain bounded.

The workspace extension host initializes and discovers the private runtime through `exec.py init`, then pins the returned home/project binding. On SSH/container hosts this uses the executing host’s `AGENT_FACTORY_HOME` or `~/.agent-factory`, not the UI machine’s home. Restart the connection after explicit project rebind. The extension no longer builds checkout-local runtime paths.

If a plugin reinstall replaces the versioned cache directory while a chat tab is open, the client rediscovers the newest installed `exec.py` and retries the interrupted runtime command once. Main chat polling also refreshes referenced Work and Verification state while a turn runs; transient refresh failures preserve the last known counts instead of resetting them to zero.

### Task modes

The selector beside the composer offers **직접 수정**, **작업** (default),
**작업 · 검증**, and **계획 · 작업 · 검증**. Selection persists and applies to
the next submitted message, including queued messages. Running tasks retain
their captured mode. Conversation always stays with Main.

Direct mode uses Main; Work mode delegates implementation and ends after Main’s
appropriate checks without separate Verification. Verification modes reuse the
same Work and Verification sessions after findings. Plan mode uses actual Codex
Plan/default collaboration turns in one Work session before Verification, with
automatic transition. Human approval and execution permissions remain separate.
Unsupported modes are disabled and dispatch fails with an update diagnostic;
older plugins are never silently treated as supporting these routes.
