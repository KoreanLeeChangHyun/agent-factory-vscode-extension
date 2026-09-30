# Agent Factory Main Chat

Turn conversations into defined tasks, delegate them to AI agents, and review
results in VS Code.

## 1. Get started

- Requires Python 3.10+ and at least one of the Codex CLI, Claude Code or the Antigravity
  CLI in the workspace environment.
  Installed runtimes are detected automatically.
- Official installation guides: [Codex CLI](https://developers.openai.com/codex/cli/) · [Claude Code](https://code.claude.com/docs/en/setup) · [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli).

1. Run **Agent Factory: Add Main Agent Chat** from the VS Code Command Palette.
2. Work directly with Main, or submit a task for delegated execution.

- The extension installs or updates the matching Agent Factory companion plugin for each
  available runtime: Codex, Claude Code (`claude`) and Antigravity (`agy`).

## 2. Core features

### 2.1. Document system

- Keep project knowledge in a structured, searchable collection that agents can
  consult across tasks. Maintain one editable source for each document.
- Separate source references (**Original**), investigations and working knowledge
  (**Refined**), accepted facts and rules (**Specification**), execution records
  (**Progress**), and experience from previous work (**Lessons Learned**).
- Preserve the distinction between evidence, assumptions, and accepted decisions.
  Writing or summarizing a document does not automatically make it a project rule.
- When you request migration, organize existing documents into the project structure
  while preserving their content and references. Accepted Specification documents
  can be synchronized into project Skills for agents to use in later work.

### 2.2. Contracts → Work–Verification loop

- Turn a conversation into a work contract with four sections: the **goal** with its
  boundary and observable completion criteria, the **structure** of exact file changes
  shown as a tree with add/modify/delete markers, the **workers** assigned to each task,
  and the execution **order** with dependencies.
- Each contract version at `docs/progress/<contract-id>/contract-v<N>.md` also holds
  its execution record: runs, agents, Work and Verification status, and evidence per
  task. Revisions create a new version and preserve earlier ones.
- In a Work–Verification loop, the agents have distinct responsibilities:

  | Agent | Responsibility |
  | --- | --- |
  | Main | Consolidate the request, coordinate execution, and report results. |
  | Work | Carry out the contracted tasks and perform its own checks. |
  | Verification | Independently check the completed work against its requirements. |

- Verification findings return to Work for correction, and revised work returns
  to Verification for another check. A passing result completes the verification
  stage; unresolved findings remain visible.
- Choose the execution mode for the task. Direct Main work and Work-only execution
  are also available; a separate Verification agent runs only when the selected
  route calls for it.

### 2.3. Interviews

- Resolve missing requirements and decisions through guided questions in the
  conversation. The agent uses existing context first and asks about gaps that
  could materially change the outcome.
- Address one decision at a time, with meaningful options, their advantages and
  disadvantages, and a recommendation. Your answers guide the next question.
- Skip, defer, correct, or narrow a question as needed. Recommendations and
  assumptions remain distinct from your decisions.
- Finish with a summary of the decisions and any remaining gaps. Save the interview
  as a document when requested or required by the workflow, and use it to inform
  a work contract or further planning.

### 2.4. Lessons learned

- Preserve errors, including recovered failures, alongside differences between
  your judgment and the agent's. Record the context, known causes, attempted
  solutions, and actual outcomes.
- Retrieve relevant lessons before related work so earlier findings can inform
  the approach. Keep unknown causes and unresolved issues explicit.
- Record how a lesson was applied and whether it helped, needed correction, or
  failed again. Recurrences add evidence without erasing the earlier record.
- When you request consolidation, turn supported lessons into reusable project
  rules. Lesson records remain evidence; they do not automatically become accepted
  Specifications or trigger background changes.

## 3. Chat workspace

### 3.1. Message actions

- Each message is handled directly by Main by default. Open the submit menu to
  choose an action for that message only:

  | Group | Actions |
  | --- | --- |
  | Document | Document · Main, Document migration, Lessons learned to rules |
  | Task workflow | Contract, Interview, Planning, Design |
  | Delegated execution | Work, Plan, Verification, Plan · Work, Work · Verification, Plan · Work · Verification |

- **Goal** and **Fast** toggles apply to the next message when the runtime supports them.
- Messages sent while Main is running wait in the chat's queue and are sent in order.
- Attach files, folders, or images to a message.

### 3.2. Chats, agents, and notes

- Each Main chat opens in its own editor tab. The **Agents** sidebar lists chats and
  their Work and Verification agents; group, rename, archive, and restore them.
- Earlier conversation history loads page by page, and live assistant previews
  appear while a run streams.
- **Notes** keep global or workspace notes in folders beside the chat.
- Customize keyboard shortcuts in **Settings → Keyboard shortcuts**.

### 3.3. Status bar

- Choose and reorder the items shown below the chat with
  `agentFactory.mainChat.statusItems`: run status, active agents, project, Git branch,
  context remaining, and queued messages.
- Claude runs also report context usage and weekly usage and remaining.
- 5-hour usage and remaining (`fiveHour`, `fiveHourRemaining`) are available for both Codex
  and Claude runs when the provider reports the 5-hour limit.

### 3.4. Work Units

- Create a Work Unit to isolate a task in its own Git worktree and branch, managed
  under `~/.agent-factory`. The new chat receives an editable summary of the
  requirements and decisions from the current conversation; uncommitted changes
  stay in the original folder.
- Review the changed files and merge the work branch into a target branch. After a
  normal merge, the worktree and branch are cleaned up when safe.
- When you work directly on `main` or `master`, a notice suggests creating a Work
  Unit. Turn it off with `agentFactory.workUnits.warnDefaultBranch`.

### 3.5. Companion bots

- Choose **Lumi** or **Factory Bot** as the companion shown above the message box in
  all chats, and talk to it from the input box.
- `agentFactory.mainChat.botModel` sets the shared conversation model. When empty,
  Codex Luna is used, with Claude Haiku as a fallback when Codex is not installed.
- Customize each bot's prompt, or turn off all bots with
  `agentFactory.mainChat.botsEnabled`. Your system's reduced-motion preference is respected.

## 4. Agent settings

### 4.1. Scope and inheritance

- Open the chat's **Agent settings** panel to configure Main, Work and Verification
  models and reasoning levels, and select the scope to edit: **Global**, **Project**,
  or **This chat**. The panel opens on **Project**; without an open workspace folder,
  it uses **Global**.
- Each value resolves independently: **chat → project → global → provider default**.
- **Use parent setting** removes an override. The panel shows each value's
  source and effective setting.
- Existing chats retain their saved explicit choices. New chats inherit scoped
  defaults; changing one chat does not change defaults for future chats.

### 4.2. Storage and submitted messages

| Scope | Storage |
| --- | --- |
| Chat | Existing chat state |
| Project | Active runtime workspace folder's `.vscode/settings.json` |
| Global | VS Code User settings |

- Project and global defaults use six VS Code settings:
  `agentFactory.agents.<role>.model` and
  `agentFactory.agents.<role>.reasoningEffort`, where `<role>` is `main`, `work`
  or `verification`.
- The extension uses the first workspace folder as its runtime project.
- Each submitted message captures the resolved model and reasoning values,
  including queued messages. Later default changes affect future submissions only.
- Provider and session compatibility checks still apply.

### 4.3. Presets

- Save the current models and reasoning levels as a named set, then apply, update,
  or delete it across the global and project scopes. One set can be the default.
- On first use, unset global models are initialized from the detected runtimes.
  Explicit settings are preserved.

### 4.4. Model selection and sessions

- The model picker groups models by vendor tabs (**OpenAI**, **Anthropic**, **Google**)
  and by runtime (Codex, Claude Code, Antigravity) within each vendor. In a started
  conversation, models from other runtimes are locked.

- When `claude` is available, the model picker lists the Claude models from Claude
  Code's own account-specific model catalog (`~/.claude/cache/model-catalog/`, or
  `$CLAUDE_CONFIG_DIR`). The list is read again each time the picker opens, so it
  follows your account without an extension update. If Claude Code has not written
  a catalog yet, no Claude models are listed.
- Start a new chat or clear the current conversation before switching between
  Codex and Claude.
- Every execution mode works with Claude. Plan runs in Claude's plan mode and
  continues in the same session.
- Context usage is shown after each Claude turn.
- When the Antigravity CLI (`agy`) is signed in, its subscription models are also listed.
  `gemini-*` models appear by base ID and take the reasoning level as effort; other
  families appear as `antigravity/<id>`. Antigravity runs are text-only.

### 4.5. Execution permissions

- Extension permissions map to Claude tool permissions as follows. These modes
  do not provide an OS sandbox.

| Extension setting | Claude permission mode |
| --- | --- |
| Full access or Full bypass | `bypassPermissions` |
| Workspace | `acceptEdits` |
| CLI default | `permissions.defaultMode` in Claude settings; read-only when unset |
