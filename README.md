# Agent Factory Main Chat

Turn conversations into defined tasks, delegate them to AI agents, and review
results in VS Code.

## 1. Get started

- Requires Python 3.10+ and an available Codex or Claude runtime in the workspace environment.
- Official installation guides: [Codex CLI](https://developers.openai.com/codex/cli/) · [Claude Code](https://code.claude.com/docs/en/setup).

1. Run **Agent Factory: Add Main Agent Chat** from the VS Code Command Palette.
2. Work directly with Main, or submit a task for delegated execution.

- The extension installs the matching Agent Factory companion plugin when needed.

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

- Turn a conversation into a work contract with an intended outcome, individual
  tasks, and observable completion criteria. For file changes, identify the exact
  paths and operations so the execution boundary is clear before work begins.
- Keep each task linked to its scope and results. Contract revisions preserve
  earlier versions and record confirmed scope changes.
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

## 3. Agent settings

### 3.1. Scope and inheritance

- Use the chat's **Agent settings** dialog to change only that chat.
- Open **Settings → Agent defaults**, then select **Project** or **Global**, to
  configure Main, Work and Verification models and reasoning levels.
- Each value resolves independently: **chat → project → global → provider default**.
- **Use parent setting** removes an override. The chat dialog shows each value's
  source and effective setting.
- Existing chats retain their saved explicit choices. New chats inherit scoped
  defaults; changing one chat does not change defaults for future chats.

### 3.2. Storage and submitted messages

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

### 3.3. Model selection and sessions

- When `claude` is available, the model picker offers these identifiers:

  | Selection | Model identifiers |
  | --- | --- |
  | Pinned versions | `claude-opus-5-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5-20251001` |
  | Family aliases | `claude-opus`, `claude-sonnet`, `claude-haiku` |

- Claude Code resolves family aliases to the latest model in each family.
  Availability depends on your account.
- Start a new chat or clear the current conversation before switching between
  Codex and Claude.
- Every execution mode works with Claude. Plan runs in Claude's plan mode and
  continues in the same session.
- Context usage is shown after each Claude turn.

### 3.4. Execution permissions

- Extension permissions map to Claude tool permissions as follows. These modes
  do not provide an OS sandbox.

| Extension setting | Claude permission mode |
| --- | --- |
| Full access or Full bypass | `bypassPermissions` |
| Workspace | `acceptEdits` |
| CLI default | `permissions.defaultMode` in Claude settings; read-only when unset |
