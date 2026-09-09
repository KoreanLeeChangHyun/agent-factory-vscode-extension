# Agent Factory Main Chat

Agent Factory Main Agent sessions in VS Code editor tabs.

## Features

- Open Main Agent sessions in editor tabs; stream activity and resume sessions.
- Render Markdown code fences, Bash commands, ANSI command output, and file diffs.
- Submit, follow up, and cancel runs through the installed Agent Factory runtime.
- Use native Fast/Goal controls and inspect Work/Verification status.

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

## Rendering regression checks

- Unit tests: `npm test`.
- Browser tests: `node tests/browser/chat-rendering.cjs` after `npm run build`.
- Install Playwright and Chromium in your test environment. Set `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when using external installations.
- Packaging: `npm run package`; install the resulting VSIX in the workspace extension host.

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

## Runtime notes

- **바이패스** is an alias for **전체 접근**: it uses the same unrestricted sandbox and `never` execution approval policy; it does not bypass hook trust, Human scope decisions, or verification.
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
