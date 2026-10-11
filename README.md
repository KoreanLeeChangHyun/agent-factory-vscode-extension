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
- `agentFactory.mainChat.pluginUpdateMode` chooses `auto` (the default: install or
  update when a CLI is newly detected or its path changes) or `manual` (only when you
  click **Update now** in **Settings → General**).
- Set `agentFactory.mainChat.codexPath`, `claudePath` or `antigravityPath` when a CLI is
  not found automatically, and `agentFactory.mainChat.pythonPath` to choose the Python
  3.10+ interpreter.

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
- Open a `*.archify.json`, `*.architecture.json` or `*.sequence.json` file to see its
  Archify architecture/sequence diagram immediately. Ordinary `*.json` files keep
  their normal text editor. The JSON content selects the official diagram type.
- **원문 편집** opens the same JSON in the text editor beside the diagram; saving
  refreshes the view. Invalid JSON and unsupported types show an error while keeping
  that source button available. **새로고침** retries a failed preview.
- This viewer requires a trusted workspace, Python 3.10+, Node.js 18+, and a matching
  companion plugin containing `scripts/archify.py`. On first use it downloads and
  verifies pinned official Archify v3.0.1 in system temporary storage. It runs on the
  workspace host, including Remote/SSH, without writing source JSON or project HTML.
- The editor displays the generated SVG as an isolated image with theme support.
  Its scripts and styles remain extension-local; standalone HTML viewer scripts are
  not executed inside it. Keep Document JSON in its package `assets/`; use the plugin
  render CLI separately when you need a retained HTML artifact.

### 2.2. Contracts → Work–Verification loop

- Turn a conversation into a work contract with six sections: contract information,
  hired workers and their IDs, task goals with assigned worker IDs and completion criteria,
  important constraints including task dependencies, a file tree showing each change
  operation and file-specific goal beside its task ID, and a task-level order diagram.
  The constraints table is the source for the diagram’s dependency arrows.
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
- Each new message defaults to **orchestrator mode**: Main converses, plans and routes,
  and delegates every change and research task to a Work profile: **Expert** (`work`),
  **Worker** (`workLight`) for bounded, already-decided changes, **Explorer** for
  read-only research and **Scribe** for documents. In **direct mode** Main implements
  directly.
- Main can recommend a Work model by task type from the project's `model-affinity.json`
  table, choosing only detected models and keeping any model you specified. Without a
  table, no recommendation is made.

  ```mermaid
  flowchart LR
    accTitle: Orchestrator mode routing
    accDescr: Main answers conversation and light lookups itself and delegates changes and research to Work. Work reports its own checks. Verification runs only when requested; its findings return to Work until it passes.
    U["Your message"] --> M{"Main"}
    M -->|"conversation, interview,<br/>light lookup"| A["Main answers"]
    M -->|"change or research"| W["Work agent"]
    W --> C["Own checks and receipt"]
    C -->|"Verification not requested"| R["Main reports"]
    C -->|"Verification requested"| V["Verification agent"]
    V -->|"findings"| W
    V -->|"pass"| R
  ```

- Choose another execution mode for a message when needed, such as Work-only
  execution or a route with separate Verification. A separate Verification agent
  runs only when the selected route calls for it.

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
- The runtime keeps observed facts for each run (tool failures, failed runs, rework,
  failed Verification and your corrections) and queues the run for lesson writing.

## 3. Chat workspace

### 3.1. Message actions

- An ordinary send goes to Main in the chat's current mode: **Orchestrate** is on by
  default, and turning it off switches the chat to direct mode. Open the submit menu to
  choose an action for that message only:

  | Group | Actions (default shortcut) |
  | --- | --- |
  | Document · Main | Planning (`Alt+Shift+P`), Interview (`Alt+Shift+I`), Document migration (`Alt+Shift+M`), Lessons learned to rules (`Alt+Shift+L`) |
  | Task workflow | Contract (`Alt+Shift+C`), Work (`Alt+Shift+W`), Work–Verification (`Alt+Shift+V`) |
  | Deployment | Create deployment pipeline (`Alt+Shift+D`) |
  | Goal | Goal (`Alt+Shift+G`) |

- **Isolation** runs delegated work in its own worktree and merges it automatically;
  when off, delegated work uses the shared checkout. **Fast** is chosen in the model menu.
  Both depend on runtime support.
- Messages sent while Main is running wait in the chat's queue and are sent in order.
- Attach files, folders, or images to a message.

### 3.2. Chats, agents, and notes

- Each Main chat opens in its own editor tab. Opening a chat that is already open
  focuses its existing tab instead of creating a duplicate. When a window reopens with
  a restored chat tab, startup does not open a second tab for the same chat.
- The **Agents** sidebar lists chats and their Work and Verification agents. Group,
  rename, or permanently delete them with their conversation and execution records, and
  restore previously archived agents.
- Earlier conversation history loads 50 runs at a time with **Load earlier messages**.
  Long conversations render a window of 200 events with **Earlier** and **Later**
  controls, and live assistant previews appear while a run streams.
- Instruction blocks that Agent Factory adds to a submitted message (execution mode,
  orchestrator, isolation, delegated model and permission guidance) are hidden from the
  displayed message.
- **Settings → General** chooses whether startup restores the last chat or opens a new
  one, notifications for completed, failed and response-needed work (optionally only
  while you view another screen, with sound), and a **Periodic documents check** (off,
  daily or weekly) that reviews `docs/` read-only while idle and reports the result.
- **Notes** keep global or workspace notes in folders beside the chat.
- Customize keyboard shortcuts in **Settings → Keyboard shortcuts**.

### 3.3. Status bar

- Choose and reorder the items shown below the chat with
  `agentFactory.mainChat.statusItems`. The default set is run status, active agents,
  project, Git branch, context remaining, and queued messages.
- Other items cover the agent, role, runtime, model, reasoning, Fast, Goal and its token,
  time and budget use, task, execution mode, elapsed time, context use, 5-hour and weekly
  usage with remaining amounts and reset times, and the total number of agents.
- An item appears only when its data is available for the current run.
- The run status line above the message box keeps running, queued, failed and
  response-needed states visible. Completed, ended and cancelled states disappear
  after a few seconds.

### 3.4. Work Units

- Create a Work Unit to isolate a task in its own Git worktree and branch, managed
  under `~/.agent-factory`. The new chat receives an editable summary of the
  requirements and decisions from the current conversation; uncommitted changes
  stay in the original folder.
- Review the changed files and merge the work branch into a target branch. After a
  normal merge, the worktree and branch are cleaned up when safe.
- When you work directly on `main` or `master`, a notice suggests creating a Work
  Unit. Turn it off with `agentFactory.workUnits.warnDefaultBranch`.

### 3.5. Control Center

- Run **Control Center** from the chat title bar or the **Agents** view to open one
  control tab per project beside the chat. Opening it again focuses the existing tab.
- **Workers** lists each worker with its title, status and task history, grouped by
  domain and by attention, in progress, the last 24 hours and earlier. Create, rename
  and assign domains, and drag workers to reorder them.
- **Tasks** shows a board with Waiting, Running, Verifying, Decision needed · Blocked,
  Completed and Failed · Cancelled columns; Unconfirmed appears when it has records.
  Search tasks, workers and results, and filter by status, conversation and domain.
- A task's detail shows its request and interpretation, success criteria, write
  boundary, dependencies, sources, result, artifacts, own checks and recorded
  Verification, and opens its request, result, records or session. **Add feedback
  reference** inserts a reference to the task into the Main chat's message box.
- Talk to a worker directly with **Instruction to this worker**: it adds an instruction
  to the running task, or starts a new task in the same session when the worker is idle.
  **Rework instruction** starts a linked task in the worker's session when it is not busy.
  **Force stop** and **Remove worker** ask for confirmation.
- **Provider handoff** moves the current task to a new session on another detected model,
  with a reason, after confirmation. **Supervision report** classifies unfinished tasks as
  on track, delayed, stuck or decision-needed and lists alerts and records that could not
  be read.

### 3.6. Companion bots

- Choose **Lumi** or **Factory Bot** as the companion shown above the message box in
  all chats, and talk to it from the input box.
- `agentFactory.mainChat.botModel` sets the shared conversation model. When empty,
  Codex Luna is used, with Claude Haiku as a fallback when Codex is not installed.
- Customize each bot's prompt, or turn off all bots with
  `agentFactory.mainChat.botsEnabled`. Your system's reduced-motion preference is respected.

## 4. Agent settings

### 4.1. Roles and sets

- Each chat's **Agent settings** panel has model, reasoning and supported Fast controls
  for the Orchestrator (`main`), Expert (`work`), Worker (`workLight`), Explorer
  (`explore`), Scribe (`scribe`) and Validator (`verification`). Explorer and Scribe start
  from the Worker setting.
- A chat keeps its own settings or applies a saved set. Set selection is unavailable once
  the conversation is bound to a model provider.
- Manage sets in **Settings → Agents**. Built-in sets (Codex, Claude, Antigravity,
  Agent Factory and Super Factory) cannot be changed or deleted; duplicate one to
  customize it. Custom sets can be renamed, updated or deleted, and **Use as project
  default** chooses the set that supplies the project's default settings.

### 4.2. Storage and submitted messages

- All sets live in one library in the extension's global storage (`agent-sets-v3.json`).
  Earlier `agentFactory.agents.<role>.model` and `agentFactory.agents.<role>.reasoningEffort`
  values and project or global presets are read once for migration and are no longer
  written.
- The extension uses the first workspace folder as its runtime project.
- Each submitted message, including queued messages, captures that chat's saved
  model, reasoning and Fast settings. Provider and session compatibility checks
  still apply to changes in the current chat.

### 4.3. Model selection and sessions

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
- Every execution route works with Claude. Plan steps run in Claude's plan mode and
  continue in the same session.
- Context usage is shown after each Claude turn.
- When the Antigravity CLI (`agy`) is signed in, its subscription models are also listed.
  `gemini-*` models appear by base ID and take the reasoning level as effort; other
  families appear as `antigravity/<id>`. Antigravity runs are text-only.

### 4.4. Execution permissions

- Extension permissions map to Claude tool permissions as follows. These modes
  do not provide an OS sandbox.

| Extension setting | Claude permission mode |
| --- | --- |
| Full access or Full bypass | `bypassPermissions` |
| Workspace | `acceptEdits` |
| CLI default | `permissions.defaultMode` in Claude settings; read-only when unset |
