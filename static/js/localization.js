/* Shared UI messages. Keys are stable; arguments are opaque source data. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AgentFactoryI18n = api;
})(globalThis, function () {
  "use strict";
  const messages = {
  "ui.agent.defaults": {"en": "Agent defaults", "ko": "에이전트 기본값"},
  "ui.settings.scope": {"en": "Scope", "ko": "설정 범위"},
  "ui.project.defaults": {"en": "Project", "ko": "프로젝트"},
  "ui.global.defaults": {"en": "Global", "ko": "글로벌"},
  "ui.agent.defaults.help": {"en": "Priority: Chat > Project > Global. Values set at a narrower scope take precedence.", "ko": "우선순위: 채팅 > 프로젝트 > 글로벌. 좁은 범위에서 지정한 값이 우선합니다."},
  "ui.use.parent.setting": {"en": "Inherit defaults", "ko": "기본값 상속"},
  "ui.chat.override": {"en": "This chat", "ko": "현재 채팅"},
  "ui.inherited.project": {"en": "Inherited from project", "ko": "프로젝트에서 상속"},
  "ui.inherited.global": {"en": "Inherited from global", "ko": "글로벌에서 상속"},
  "ui.inherited.product": {"en": "Product default", "ko": "제품 기본값"},

  "sudo.title": {"en":"Administrator access requested for this command", "ko":"이 명령에 관리자 권한이 필요합니다"},
  "sudo.password": {"en":"Administrator password", "ko":"관리자 비밀번호"},
  "sudo.context": {"en":"Working directory: {0} · Requested by {1} ({2}). Check the command before entering your password.", "ko":"작업 디렉터리: {0} · 요청: {1} ({2}). 비밀번호를 입력하기 전에 명령을 확인하세요."},
  "sudo.run": {"en":"Authenticate and run", "ko":"인증 후 실행"},
  "sudo.cancel": {"en":"Cancel", "ko":"취소"},
  "sudo.encrypting": {"en":"Protecting password…", "ko":"비밀번호 보호 중…"},
  "sudo.running": {"en":"Running command…", "ko":"명령 실행 중…"},
  "sudo.encryption.failed": {"en":"Could not protect password. Try again.", "ko":"비밀번호를 보호하지 못했습니다. 다시 시도해 주세요."},
  "ui.claude.only.requires.installed.plugin": {"en":"Codex CLI was not found, so Agent Factory is running with Claude only. Claude-only mode needs an already installed Agent Factory plugin: {0} Install it once with Codex or set agentFactory.mainChat.runtimeExecPath, then retry.", "ko":"Codex CLI가 없어 Claude 전용으로 실행합니다. Claude 전용 모드는 이미 설치된 Agent Factory 플러그인이 필요합니다: {0} Codex로 한 번 설치하거나 agentFactory.mainChat.runtimeExecPath를 설정한 뒤 다시 시도하세요."},
  "sudo.unavailable": {"en":"Administrator command handoff is unavailable: {0}", "ko":"관리자 명령 전달을 사용할 수 없습니다: {0}"},
  "ui.clearing.conversation": {"en":"Clearing conversation… Previous records are being retained.", "ko":"대화를 초기화하고 있습니다… 이전 기록은 보존됩니다."},
  "attachment.convert.heading": {"en":"Convert image", "ko":"이미지 형식 변환"},
  "attachment.convert.source": {"en":"Original file", "ko":"원본 파일"},
  "attachment.convert.destination": {"en":"Save location", "ko":"저장 위치"},
  "attachment.convert.preserved": {"en":"Your original is preserved", "ko":"원본 파일은 그대로 보존됩니다"},
  "attachment.convert.loss.short": {"en":"Animation and metadata are removed. JPG fills transparent areas with white. JPG/WebP may lose quality.", "ko":"애니메이션·메타데이터는 제외됩니다. JPG는 투명 영역을 흰색으로 채우며, JPG·WebP는 화질이 달라질 수 있습니다."},
  "attachment.convert.close": {"en":"Close", "ko":"닫기"},
  "attachment.convert.format": {"en":"Output format", "ko":"변환할 형식"},
  "attachment.convert.busy": {"en":"Converting and saving…", "ko":"변환 및 저장 중…"},
  "attachment.convert.title": {"en":"Convert file format…", "ko":"파일 형식 변환…"},
  "attachment.convert.proceed": {"en":"Convert", "ko":"변환"},
  "attachment.convert.loss": {"en":"The result is a still image. Animation and metadata are not preserved. JPG uses a white background for transparency; JPG/WebP may lose quality. The original is kept.", "ko":"정지 이미지로 변환하며 애니메이션과 메타데이터는 보존되지 않습니다. JPG는 투명 영역을 흰색으로 채우며, JPG·WebP는 화질 손실이 있을 수 있습니다. 원본은 보존됩니다."},
  "attachment.convert.failed": {"en":"Could not convert this image. The original is unchanged.", "ko":"이미지를 변환하지 못했습니다. 원본은 그대로 보존됩니다."},
  "attachment.convert.workspace": {"en":"Open a project folder to save converted files.", "ko":"변환 파일을 저장할 프로젝트 폴더를 열어 주세요."},
  "attachment.convert.saved": {"en":"Converted file saved: {0}", "ko":"변환 파일 저장 완료: {0}"},
  "attachment.convert.reveal": {"en":"Show in Explorer", "ko":"탐색기에서 보기"},
  "worktree.status.home": {"en": "Home", "ko": "홈"},
  "worktree.status.tree": {"en": "Tree", "ko": "트리"},
  "worktree.create": {"en": "Create worktree", "ko": "워크트리 생성"},
  "worktree.merge": {"en": "Merge and return", "ko": "병합 후 복귀"},
  "worktree.refresh": {"en": "Refresh", "ko": "새로고침"},
  "worktree.isolated": {"en": "Worktree", "ko": "워크트리"},
  "worktree.workspace": {"en": "Workspace root", "ko": "워크스페이스 루트"},
  "worktree.conflicts": {"en": "Conflicts: {0}", "ko": "충돌: {0}"},
  "worktree.invalid": {"en": "The runtime returned invalid worktree information.", "ko": "런타임에서 잘못된 워크트리 정보를 반환했습니다."},
  "worktree.unsupported": {"en": "This runtime does not support conversation worktrees.", "ko": "이 런타임은 대화별 워크트리를 지원하지 않습니다."},
  "worktree.busy": {"en": "Finish the current run and queued messages before changing worktrees.", "ko": "실행 중인 작업과 대기 메시지를 처리한 뒤 워크트리를 변경해 주세요."},
  "worktree.failed": {"en": "Worktree operation failed: {0}", "ko": "워크트리 작업 실패: {0}"},
  "worktree.keep": {"en": "Keep uncommitted changes in the workspace", "ko": "미커밋 변경은 원본에 유지"},
  "worktree.copy": {"en": "Copy uncommitted changes; preserve the originals", "ko": "미커밋 변경 복사 · 원본 유지"},
  "worktree.changes": {"en": "Choose how to handle existing uncommitted changes", "ko": "기존 미커밋 변경 처리"},
  "worktree.default.path": {"en": "Project worktrees folder (default)", "ko": "프로젝트 전용 워크트리 폴더 (기본)"},
  "worktree.custom.path": {"en": "Choose another location", "ko": "다른 위치 지정"},
  "worktree.location": {"en": "Worktree location", "ko": "워크트리 생성 위치"},
  "worktree.path.prompt": {"en": "Enter an absolute path to a new directory outside the workspace.", "ko": "워크스페이스 바깥의 새 폴더 절대 경로를 입력해 주세요."},
  "worktree.conflict.notice": {"en": "Merge conflicts are preserved in the worktree. Ask Codex to resolve and commit them in this conversation, then select Merge and return again.", "ko": "충돌은 워크트리에 보존했습니다. 이 대화에서 코덱스에게 충돌 해결과 커밋을 요청한 뒤 병합 후 복귀를 다시 눌러 주세요."},
  "worktree.merged.notice": {"en": "Merge completed. This conversation now works in the original workspace.", "ko": "병합을 완료했습니다. 이 대화는 원래 워크스페이스에서 작업합니다."},
  "worktree.created.notice": {"en": "This conversation now works in its isolated worktree.", "ko": "이 대화는 격리된 워크트리에서 작업합니다."},

  "notes.resize": {"en":"Resize notes", "ko":"노트 너비 조절"},
  "notes.title": {"en": "Notes", "ko": "노트"},
  "notes.scope": {"en": "Storage scope", "ko": "저장 범위"},
  "notes.global": {"en": "Global", "ko": "글로벌"},
  "notes.workspace": {"en": "Workspace", "ko": "워크스페이스"},
  "notes.new": {"en": "New note", "ko": "새 노트"},
  "notes.back": {"en": "Back to list", "ko": "목록으로"},
  "notes.note.title": {"en": "Title", "ko": "제목"},
  "notes.body": {"en": "Note", "ko": "노트 본문"},
  "notes.placeholder": {"en": "Write freely…", "ko": "자유롭게 작성하세요…"},
  "notes.copy": {"en": "Copy", "ko": "복사"},
  "notes.insert": {"en": "Insert into input", "ko": "입력창에 넣기"},
  "notes.save.copy": {"en": "Save a copy", "ko": "사본으로 저장"},
  "notes.empty": {"en": "No notes yet.", "ko": "아직 노트가 없습니다."},
  "notes.untitled": {"en": "Untitled", "ko": "제목 없음"},
  "notes.saving": {"en": "Saving…", "ko": "저장 중…"},
  "notes.saved": {"en": "Saved", "ko": "저장됨"},
  "notes.loading": {"en": "Loading…", "ko": "불러오는 중…"},
  "notes.failed": {"en": "Could not save/load: {0}", "ko": "저장·불러오기 실패: {0}"},
  "notes.copied": {"en": "Copied", "ko": "복사했습니다"},
  "ui.wsl.project.opened": {"en":"This project was opened in a new WSL window. Continue using Agent Factory in that window.","ko":"이 프로젝트를 새 WSL 창으로 열었습니다. 해당 창에서 Agent Factory를 사용해 주세요."},
  "ui.wsl.extension.required": {"en":"Codex was found in WSL ({0}). Install the Microsoft WSL extension (ms-vscode-remote.remote-wsl), then Retry to open this project there automatically.","ko":"WSL({0})에서 Codex를 찾았습니다. Microsoft WSL 확장(ms-vscode-remote.remote-wsl)을 설치한 뒤 재시도하시면 해당 환경에서 프로젝트가 자동으로 열립니다."},
  "ui.disable.all.bots": {"en":"Turn off all bots (all chats)","ko":"모든 봇 끄기 (전체 채팅)"},
  "ui.attach.local.files": {"en":"Attach files from this computer","ko":"내 컴퓨터에서 파일 첨부"},
  "ui.local.file.limit": {"en":"Attach up to 100 files, 10 MiB per file and 20 MiB per selection.","ko":"파일은 최대 100개, 파일당 10 MiB, 한 번 선택 시 총 20 MiB까지 첨부할 수 있습니다."},
  "ui.local.file.read.failed": {"en":"Unable to read the selected file.","ko":"선택한 파일을 읽을 수 없습니다."},
  "ui.the.configured.codex.cli.path.must.be.an.absolute.executable.path.no.shell.arguments.are.allowed.0": {"en":"The configured Codex CLI path must be an absolute executable path without shell arguments: {0}","ko":"설정한 Codex CLI 경로는 셸 인자가 없는 절대 실행 파일 경로여야 합니다: {0}"},
  "ui.the.configured.codex.cli.path.is.not.an.executable.file.0.correct.agentfactory.mainchat.codexpath.then.retry": {"en":"The configured Codex CLI path is not an executable file: {0}. Correct agentFactory.mainChat.codexPath, then Retry.","ko":"설정한 Codex CLI 경로가 실행 파일이 아닙니다: {0}. agentFactory.mainChat.codexPath를 수정한 뒤 재시도해 주세요."},
  "ui.codex.cli.was.not.found.on.the.workspace.extension.host.path.or.in.nvm.install.codex.there.or.set.agentfactory.mainchat.codexpath.then.retry": {"en":"Codex CLI was not found on the workspace extension host PATH or in NVM. Install Codex there or set agentFactory.mainChat.codexPath, then Retry.","ko":"workspace 익스텐션 호스트의 PATH 또는 NVM에서 Codex CLI를 찾지 못했습니다. 해당 호스트에 Codex를 설치하거나 agentFactory.mainChat.codexPath를 설정한 뒤 재시도해 주세요."},
  "ui.agent.factory.is.not.ready.0.correct.the.codex.cli.setting.or.workspace.extension.host.environment.then.retry": {"en":"Agent Factory is not ready. {0} Correct the Codex CLI setting or workspace extension host environment, then Retry.","ko":"Agent Factory가 준비되지 않았습니다. {0} Codex CLI 설정 또는 workspace 익스텐션 호스트 환경을 수정한 뒤 재시도해 주세요."},
  "ui.background.continuation.label": {"en":"Automatic workflow continuation", "ko":"백그라운드 작업 자동 후속 처리"},
  "bot.actions": {"en":"Bot companion", "ko":"봇 돌보기"},
  "bot.prompt.label": {"en": "Luna bot prompt", "ko": "루나 봇 프롬프트"},
  "bot.prompt.hint": {"en": "Applies to future bot conversations in all chats. Leave empty to use the default.", "ko": "모든 채팅의 다음 봇 대화부터 적용됩니다. 비워두면 기본값을 사용합니다."},
  "bot.prompt.save": {"en": "Save", "ko": "저장"},
  "bot.prompt.reset": {"en": "Use default", "ko": "기본값 사용"},
  "bot.prompt.saving": {"en": "Saving…", "ko": "저장 중…"},
  "bot.prompt.saved": {"en": "Saved.", "ko": "저장했습니다."},
  "bot.prompt.failed": {"en": "Could not save. Your edits are preserved.", "ko": "저장하지 못했습니다. 작성한 내용은 유지됩니다."},
  "bot.talk": {"en":"Talk to the bot", "ko":"봇에게 말하기"},
  "bot.thinking": {"en":"Thinking…", "ko":"생각 중…"},
  "bot.talk.failed": {"en":"Could not receive Luna's reply. Your draft has been kept. Please try again.", "ko":"루나의 답변을 받지 못했습니다. 작성한 글은 유지됩니다. 다시 시도해 주세요."},
  "bot.reply.close": {"en":"Close reply", "ko":"답변 닫기"},
  "bot.reply.expand": {"en":"Expand reply", "ko":"답변 펼치기"},
  "bot.reply.collapse": {"en":"Collapse reply", "ko":"답변 접기"},
  "bot.play": {"en":"Play together", "ko":"놀아주기"},
  "bot.fullness": {"en":"Fullness", "ko":"포만감"},
  "ui.the.configured.codex.cli.path.0.is.a.windows.path.but.the.extension.host.runs.on.1": {"en":"The configured Codex CLI path {0} is a Windows path, but the extension host runs on {1}. Clear agentFactory.mainChat.codexPath for this remote host (Remote settings) or set a path that exists on it, then retry.","ko":"설정한 Codex CLI 경로 {0}은 Windows 경로이지만 익스텐션 호스트는 {1}에서 실행 중입니다. 이 원격 호스트의 설정(원격 설정)에서 agentFactory.mainChat.codexPath를 비우거나 해당 호스트에 있는 경로로 바꾼 뒤 다시 시도하세요."},
  "bot.happiness": {"en":"Mood", "ko":"기분"},
  "bot.energy": {"en":"Energy", "ko":"에너지"},
  "bot.growth": {"en":"Friendship {0} · Care {1}", "ko":"친밀도 {0} · 돌봄 {1}회"},
  "bot.wave": {"en":"Say hello", "ko":"인사하기"},
  "bot.dance": {"en":"Dance", "ko":"춤추기"},
  "bot.stretch": {"en":"Stretch", "ko":"스트레칭"},
  "bot.coffee": {"en":"Drink coffee", "ko":"커피 마시기"},
  "bot.read": {"en":"Read a book", "ko":"책 읽기"},
  "bot.feed": {"en":"Feed the bot", "ko":"밥 주기"},
  "bot.bow": {"en":"Take a bow", "ko":"꾸벅 인사"},
  "bot.balance": {"en":"Balance", "ko":"균형 잡기"},
  "bot.sleep": {"en":"Sleep", "ko":"잠자기"},
  "bot.busy": {"en":"Available when the bot is idle.", "ko":"봇이 쉬고 있을 때 선택할 수 있습니다."},
  "flow.request.details": {"en":"Requested work", "ko":"요청 내용"},
  "activity.request.command.completed": {"en":"Request command completed", "ko":"요청 명령 완료"},
  "activity.request.accepted": {"en":"Request accepted", "ko":"작업 요청 접수됨"},
  "activity.request.pending": {"en":"Submitting request", "ko":"작업 요청 중"},
  "activity.request.unconfirmed": {"en":"Request acceptance unconfirmed", "ko":"작업 요청 접수 확인 전"},
  "activity.request.failed": {"en":"Request command failed", "ko":"작업 요청 명령 실패"},
  "ui.conversation.user": {"en":"You", "ko":"사용자"},
  "ui.conversation.history": {"en":"Conversation history", "ko":"대화 내역"},
  "ui.conversation.empty": {"en":"No conversation history.", "ko":"대화 내역이 없습니다."},
  "ui.task.history.empty": {"en":"No task history.", "ko":"작업 내역이 없습니다."},
  "ui.conversation.readonly": {"en":"Previous conversation · Read only", "ko":"이전 대화 · 읽기 전용"},
  "ui.conversation.entry": {"en":"{0} · {1} requests", "ko":"{0} · 요청 {1}개"},
  "ui.conversation.loading": {"en":"Loading conversation history…", "ko":"대화 내역을 불러오는 중입니다…"},
  "ui.conversation.failed": {"en":"Unable to load conversation history: {0}", "ko":"대화 내역을 불러오지 못했습니다: {0}"},
  "contracts.title": {"en":"Contracts", "ko":"계약 목록"},
  "contracts.empty": {"en":"No saved contracts.", "ko":"저장된 계약서가 없습니다."},
  "contracts.loading": {"en":"Loading contracts…", "ko":"계약 목록을 불러오는 중입니다…"},
  "contracts.failed": {"en":"Could not load contracts.", "ko":"계약 목록을 불러오지 못했습니다."},
  "flow.history": {"en":"Task history", "ko":"작업 내역"},
  "flow.stage.accepted": {"en":"Accepted", "ko":"접수"},
  "flow.stage.execution": {"en":"Execution", "ko":"실행"},
  "flow.stage.result": {"en":"Result", "ko":"결과"},
  "flow.task.status": {"en":"Task status", "ko":"작업 현황"},
  "flow.status.pending": {"en": "Pending", "ko": "대기"},
  "flow.status.running": {"en": "In progress", "ko": "진행 중"},
  "flow.status.verifying": {"en": "Verifying", "ko": "검증 중"},
  "flow.status.completed": {"en": "Completed", "ko": "완료"},
  "flow.status.failed": {"en": "Failed", "ko": "실패"},
  "flow.status.blocked": {"en": "Blocked", "ko": "막힘"},
  "flow.status.cancelled": {"en": "Cancelled", "ko": "취소"},
  "flow.task.count": {"en":"{0} tasks", "ko":"작업 {0}개"},
  "ui.history.previous": {"en":"Earlier messages", "ko":"이전 메시지"},
  "ui.history.next": {"en":"Later messages", "ko":"다음 메시지"},
  "ui.history.pages": {"en":"Conversation pages", "ko":"대화 페이지"},
  "ui.history.older": {"en":"Load earlier messages", "ko":"이전 대화 불러오기"},
  "ui.goal.active.send": {"en":"Goal active · Send message (Enter)", "ko":"Goal 활성 · 메시지 전송 (Enter)"},
  "ui.goal.active.queue": {"en":"Goal active · Add message to queue (Enter)", "ko":"Goal 활성 · 대기열에 메시지 추가 (Enter)"},
  "flow.close.failed": {"en":"Close failed workflow", "ko":"실패한 작업 흐름 종료"},
  "flow.summary.label": {"en":"Task summary", "ko":"업무 항목 요약"},
  "flow.summary.workers": {"en":"Workers: {0}", "ko":"작업자 {0}명"},
  "flow.summary.workers.unknown": {"en":"Workers: unconfirmed", "ko":"작업자 미확인"},
  "flow.summary.count": {"en":"{0}: {1}", "ko":"{0} {1}개"},
  "flow.summary.current": {"en":"Current task: {0}", "ko":"현재 수행 작업: {0}"},
  "flow.summary.current.task": {"en":"{0} ({1})", "ko":"{0} ({1})"},
  "flow.summary.current.none": {"en":"No task currently running", "ko":"현재 수행 중인 작업 없음"},
  "ui.background.continuation.failed": { "en": "Could not confirm background continuation acceptance for {0} / {1}. Automatic retries are paused. Ask Main to inspect this run and resume the existing workflow.", "ko": "{0} / {1}의 백그라운드 후속 요청 수락을 확인하지 못했습니다. 자동 재시도를 멈췄습니다. Main에 해당 실행을 확인하고 기존 작업 흐름을 재개하도록 요청해 주세요." },
  "ui.workflow.from.conversation": { "en": "Execute the selected workflow using the requirements agreed in this conversation.", "ko": "지금까지 대화에서 합의한 요구사항을 정리하여 선택한 작업 흐름을 실행해 주세요." },
  "ui.sidebar.archived.empty": { "en": "Agents are archived. Use Restore Archived Agent to bring them back.", "ko": "에이전트가 보관되어 있습니다. ‘보관한 에이전트 복원’으로 다시 표시할 수 있습니다." },
  "ui.sidebar.restore": { "en": "Restore Archived Agent", "ko": "보관한 에이전트 복원" },
  "ui.sidebar.restore.hint": { "en": "Choose an agent to return to the list. Conversation and execution records are preserved.", "ko": "목록에 다시 표시할 에이전트를 선택하세요. 대화·실행 기록은 보존됩니다." },
  "ui.settings": {
    "en": "Settings",
    "ko": "설정"
  },
  "ui.general": {
    "en": "General",
    "ko": "일반"
  },
  "ui.status.bar": {
    "en": "Status bar",
    "ko": "상태바"
  },
  "ui.bot": {
    "en": "Bot",
    "ko": "봇"
  },
  "ui.keyboard.shortcuts": {
    "en": "Keyboard shortcuts",
    "ko": "키보드 단축키"
  },
  "ui.close.settings": {
    "en": "Close settings",
    "ko": "설정 닫기"
  },
  "ui.settings.categories": {
    "en": "Settings categories",
    "ko": "설정 분류"
  },
  "ui.permissions": {
    "en": "Permissions",
    "ko": "실행 권한"
  },
  "ui.execution.permissions": {
    "en": "Execution permissions",
    "ko": "실행 권한"
  },
  "ui.display.language": {
    "en": "Display language",
    "ko": "화면 언어"
  },
  "ui.automatic.vs.code": {
    "en": "Automatic (VS Code)",
    "ko": "자동 (VS Code 언어)"
  },
  "ui.cli.default": {
    "en": "CLI default",
    "ko": "CLI 기본값"
  },
  "ui.keep.current.policy": {
    "en": "Keep current policy",
    "ko": "현재 정책 유지"
  },
  "ui.workspace.write": {
    "en": "Workspace write",
    "ko": "작업 공간 쓰기"
  },
  "ui.full.access": {
    "en": "Full access",
    "ko": "전체 접근"
  },
  "ui.read.only": {
    "en": "Read-only",
    "ko": "읽기 전용"
  },
  "ui.bypass": {
    "en": "Bypass",
    "ko": "승인 생략 (Bypass)"
  },
  "ui.inherit.the.current.session.or.cli.permission.policy": {
    "en": "Inherit the current session or CLI permission policy.",
    "ko": "현재 세션 또는 CLI의 권한 정책을 따릅니다."
  },
  "ui.allow.writes.within.the.workspace.other.actions.follow.the.host.approval.policy": {
    "en": "Allow writes within the workspace; other actions follow the host approval policy.",
    "ko": "작업 공간 내 쓰기를 허용하며, 그 외 작업은 호스트 승인 정책을 따릅니다."
  },
  "ui.allow.filesystem.access.outside.the.workspace.approvals.still.follow.the.host.policy": {
    "en": "Allow filesystem access outside the workspace; approvals still follow the host policy.",
    "ko": "작업 공간 밖의 파일 접근을 허용하며, 승인은 호스트 정책을 따릅니다."
  },
  "ui.agent.settings": {
    "en": "Agent settings",
    "ko": "에이전트 설정"
  },
  "ui.models.and.reasoning": {
    "en": "Models and reasoning",
    "ko": "모델 및 추론"
  },
  "ui.close.agent.settings": {
    "en": "Close agent settings",
    "ko": "에이전트 설정 닫기"
  },
  "ui.agent": {
    "en": "Agent",
    "ko": "에이전트"
  },
  "ui.model": {
    "en": "Model",
    "ko": "모델"
  },
  "ui.reasoning": {
    "en": "Reasoning",
    "ko": "추론"
  },
  "ui.context.compaction": {
    "en": "Context compaction",
    "ko": "컨텍스트 압축"
  },
  "ui.context.compaction.started": {
    "en": "Compacting context",
    "ko": "컨텍스트 압축 중"
  },
  "ui.context.compaction.completed": {
    "en": "Context compaction completed",
    "ko": "컨텍스트 압축 완료"
  },
  "ui.main": {
    "en": "Main",
    "ko": "메인"
  },
  "ui.copy.question": {
    "en": "Copy question",
    "ko": "질문 복사"
  },
  "flow.open.work.session": { "en": "Open worker session", "ko": "작업자 세션 열기" },
  "flow.open.verification.session": { "en": "Open verifier session", "ko": "검증자 세션 열기" },
  "ui.work": {
    "en": "Work",
    "ko": "작업"
  },
  "ui.task.name.unavailable": {
    "en": "Task name not recorded",
    "ko": "작업 이름 미기록"
  },
  "ui.verification": {
    "en": "Verification",
    "ko": "검증"
  },
  "ui.default": {
    "en": "Default",
    "ko": "기본값"
  },
  "ui.available": {
    "en": "Available",
    "ko": "사용 가능"
  },
  "ui.restore.defaults": {
    "en": "Restore defaults",
    "ko": "기본값 복원"
  },
  "ui.show.bot": {
    "en": "Show bot",
    "ko": "봇 표시"
  },
  "ui.animate.bot": {
    "en": "Animate bot",
    "ko": "봇 애니메이션"
  },
  "ui.show.the.companion.above.the.message.box.this.only.changes.its.visibility": {
    "en": "Show the companion above the message box. This only changes its visibility.",
    "ko": "메시지 입력창 위에 봇을 표시합니다. 표시 여부만 변경합니다."
  },
  "ui.your.system.s.reduced.motion.preference.takes.priority.these.preferences.are.saved.for.this.chat": {
    "en": "Your system’s reduced motion preference takes priority. These preferences are saved for this chat.",
    "ko": "시스템의 동작 줄이기 설정을 우선합니다. 이 설정은 현재 채팅에 저장됩니다."
  },
  "ui.keyboard.controls.in.this.chat": {
    "en": "Keyboard controls in this chat",
    "ko": "현재 채팅에서 사용할 수 있는 키 조작"
  },
  "ui.send.message": {
    "en": "Send message",
    "ko": "메시지 보내기"
  },
  "ui.new.line": {
    "en": "New line",
    "ko": "줄바꿈"
  },
  "ui.close.settings.or.an.open.menu": {
    "en": "Close settings or an open menu",
    "ko": "설정 또는 열린 메뉴 닫기"
  },
  "ui.move.between.controls": {
    "en": "Move between controls",
    "ko": "컨트롤 사이 이동"
  },
  "ui.switch.settings.tabs": {
    "en": "Switch settings tabs",
    "ko": "설정 탭 전환"
  },
  "ui.run.status": {
    "en": "Run status",
    "ko": "실행 상태"
  },
  "ui.active.agents": {
    "en": "Active agents",
    "ko": "실행 중인 에이전트"
  },
  "ui.project": {
    "en": "Project",
    "ko": "프로젝트"
  },
  "ui.git.branch": {
    "en": "Git branch",
    "ko": "Git 브랜치"
  },
  "ui.content.remaining.percentage": {
    "en": "Content remaining percentage",
    "ko": "남은 컨텍스트 비율"
  },
  "ui.queued.messages": {
    "en": "Queued messages",
    "ko": "대기 메시지"
  },
  "ui.chat.name": {
    "en": "Chat name",
    "ko": "채팅 이름"
  },
  "ui.agent.role": {
    "en": "Agent role",
    "ko": "에이전트 역할"
  },
  "ui.elapsed.time": {
    "en": "Elapsed time",
    "ko": "경과 시간"
  },
  "ui.runtime.connection": {
    "en": "Runtime connection",
    "ko": "런타임 연결"
  },
  "ui.selected.model": {
    "en": "Selected model",
    "ko": "선택한 모델"
  },
  "ui.selected.reasoning.effort": {
    "en": "Selected reasoning effort",
    "ko": "선택한 추론 수준"
  },
  "ui.fast.setting": {
    "en": "Fast setting",
    "ko": "빠른 모드"
  },
  "ui.task.mode": {
    "en": "Task mode",
    "ko": "작업 모드"
  },
  "ui.content.tokens.used": {
    "en": "Content tokens used",
    "ko": "사용한 컨텍스트 토큰"
  },
  "ui.content.tokens.remaining": {
    "en": "Content tokens remaining",
    "ko": "남은 컨텍스트 토큰"
  },
  "ui.content.used.percentage": {
    "en": "Content used percentage",
    "ko": "사용한 컨텍스트 비율"
  },
  "ui.content.window.tokens": {
    "en": "Content window tokens",
    "ko": "컨텍스트 크기"
  },
  "ui.weekly.usage": {
    "en": "Weekly usage",
    "ko": "주간 사용량"
  },
  "ui.weekly.remaining": {
    "en": "Weekly remaining",
    "ko": "남은 주간 사용량"
  },
  "ui.total.agent.calls": {
    "en": "Total agent calls",
    "ko": "전체 에이전트 호출"
  },
  "ui.goal.status": {
    "en": "Goal status",
    "ko": "목표 상태"
  },
  "ui.goal.tokens.used": {
    "en": "Goal tokens used",
    "ko": "목표 사용 토큰"
  },
  "ui.goal.time.used": {
    "en": "Goal time used",
    "ko": "목표 사용 시간"
  },
  "ui.goal.token.budget": {
    "en": "Goal token budget",
    "ko": "목표 토큰 예산"
  },
  "ui.displayed.information.updated": {
    "en": "Displayed information updated.",
    "ko": "표시 항목을 변경했습니다."
  },
  "ui.default.status.items.and.order.restored": {
    "en": "Default status items and order restored.",
    "ko": "기본 상태바 항목과 순서를 복원했습니다."
  },
  "ui.earlier.move": {
    "en": "Earlier · Move",
    "ko": "앞으로 이동"
  },
  "ui.later.move": {
    "en": "Later · Move",
    "ko": "뒤로 이동"
  },
  "ui.fast.mode.on": {
    "en": "Fast mode on",
    "ko": "빠른 모드 켜짐"
  },
  "ui.fast.mode.off": {
    "en": "Fast mode off",
    "ko": "빠른 모드 꺼짐"
  },
  "ui.attach.files": {
    "en": "Attach files",
    "ko": "파일 첨부"
  },
  "ui.stop": {
    "en": "Stop",
    "ko": "중지"
  },
  "ui.send": {
    "en": "Send",
    "ko": "보내기"
  },
  "ui.close": {
    "en": "Close",
    "ko": "닫기"
  },
  "ui.medium": {
    "en": "MEDIUM",
    "ko": "보통"
  },
  "ui.low": {
    "en": "LOW",
    "ko": "낮음"
  },
  "ui.high": {
    "en": "HIGH",
    "ko": "높음"
  },
  "ui.xhigh": {
    "en": "XHIGH",
    "ko": "매우 높음"
  },
  "ui.none": {
    "en": "NONE",
    "ko": "없음"
  },
  "ui.fast": {
    "en": "Fast",
    "ko": "빠른 모드"
  },
  "ui.scroll": {
    "en": "Scroll",
    "ko": "스크롤"
  },
  "ui.attach.files.or.folders": {
    "en": "Attach files or folders",
    "ko": "파일 또는 폴더 첨부"
  },
  "ui.ask.agent.factory": {
    "en": "Ask Agent Factory",
    "ko": "Agent Factory에 질문하세요"
  },
  "ui.message.to.main.agent": {
    "en": "Message to Main Agent",
    "ko": "메인 에이전트에 보낼 메시지"
  },
  "ui.send.enter": {
    "en": "Send (Enter)",
    "ko": "보내기 (Enter)"
  },
  "ui.stop.current.run": {
    "en": "Stop current run",
    "ko": "현재 실행 중지"
  },
  "ui.user.questions": {
    "en": "User questions",
    "ko": "사용자 질문"
  },
  "ui.more.ways.to.submit": {
    "en": "Agent Factory",
    "ko": "Agent Factory"
  },
  "ui.submit.draft": {
    "en": "Agent Factory",
    "ko": "Agent Factory"
  },
  "ui.jump.to.latest.message": {
    "en": "Jump to latest message",
    "ko": "최신 메시지로 이동"
  },
  "ui.following.latest.messages": {
    "en": "Following latest messages",
    "ko": "최신 메시지를 따라가는 중"
  },
  "ui.auto.scroll.on.click.to.turn.off": {
    "en": "Auto-scroll ON · Click to turn off",
    "ko": "자동 스크롤 켜짐 · 클릭하여 끄기"
  },
  "ui.auto.scroll.off.click.to.turn.on": {
    "en": "Auto-scroll OFF · Click to turn on",
    "ko": "자동 스크롤 꺼짐 · 클릭하여 켜기"
  },
  "ui.document.main": {
    "en": "Document · Main",
    "ko": "문서 · 메인"
  },
  "ui.migration": { "en": "Document migration", "ko": "문서 마이그레이션" },
  "ui.lessons": { "en": "Lessons learned to rules", "ko": "교훈 수집 및 규칙화" },
  "ui.contract": { "en": "Contract", "ko": "계약" },
  "submission.work.verification.label": { "en": "Work–Verification", "ko": "작업-검증" },
  "submission.contract.request": { "en": "Create a work contract from the current conversation. If context is missing, ask the necessary questions to begin.", "ko": "현재 대화를 바탕으로 작업 계약을 만들어 주세요. 문맥이 부족하면 필요한 질문부터 시작해 주세요." },
  "submission.work.request": { "en": "Submit work for the current work contract.", "ko": "현재 작업 계약에 대한 작업을 제출해 주세요." },
  "submission.work.verification.request": { "en": "Submit a Work–Verification loop for the current work contract.", "ko": "현재 작업 계약에 대한 작업-검증 루프를 제출해 주세요." },
  "ui.task.workflow": {
    "en": "Task workflow",
    "ko": "작업 흐름"
  },
  "ui.goal.on.applies.to.the.next.message": {
    "en": "Goal on · Applies to the next message",
    "ko": "목표 켜짐 · 다음 메시지에 적용"
  },
  "ui.goal.off.enable.for.the.next.message": {
    "en": "Goal off · Enable for the next message",
    "ko": "목표 꺼짐 · 다음 메시지에 적용하려면 켜기"
  },
  "ui.goal": {
    "en": "Goal",
    "ko": "목표"
  },
  "ui.submit.as.goal": {
    "en": "Submit as Goal",
    "ko": "목표로 전송"
  },
  "ui.interview": {
    "en": "Interview",
    "ko": "인터뷰"
  },
  "ui.planning": {
    "en": "Planning",
    "ko": "기획"
  },
  "ui.design": {
    "en": "Design",
    "ko": "설계"
  },
  "ui.plan": {
    "en": "Plan",
    "ko": "계획"
  },
  "ui.plan.work": {
    "en": "Plan · Work",
    "ko": "계획 · 작업"
  },
  "ui.work.verification": {
    "en": "Work · Verification",
    "ko": "작업 · 검증"
  },
  "ui.plan.work.verification": {
    "en": "Plan · Work · Verification",
    "ko": "계획 · 작업 · 검증"
  },
  "ui.current.running.queued.or.decision.status": {
    "en": "Current running, queued, or decision status",
    "ko": "현재 실행·대기·결정 상태"
  },
  "ui.number.of.main.agent.work.and.verification.agents": {
    "en": "Number of Main Agent work and verification agents",
    "ko": "메인 에이전트의 작업·검증 에이전트 수"
  },
  "ui.current.vs.code.workspace.name": {
    "en": "Current VS Code workspace name",
    "ko": "현재 VS Code 작업 공간 이름"
  },
  "ui.current.project.branch.or.when.unknown": {
    "en": "Current project branch, or — when unknown",
    "ko": "현재 프로젝트 브랜치이며, 알 수 없으면 —로 표시합니다"
  },
  "ui.remaining.percentage.of.the.content.window.unavailable.without.usage.or.window.size": {
    "en": "Remaining percentage of the Content window; unavailable without usage or window size",
    "ko": "남은 컨텍스트 비율이며, 사용량이나 크기를 모르면 제공되지 않습니다"
  },
  "ui.number.of.messages.waiting.to.send.in.this.chat": {
    "en": "Number of messages waiting to send in this chat",
    "ko": "현재 채팅에서 전송 대기 중인 메시지 수"
  },
  "ui.current.chat.tab.name": {
    "en": "Current chat tab name",
    "ko": "현재 채팅 탭 이름"
  },
  "ui.main.work.or.verification.role": {
    "en": "Main, work, or verification role",
    "ko": "메인·작업·검증 역할"
  },
  "ui.time.observed.for.the.current.run.in.this.view.shown.only.while.running": {
    "en": "Time observed for the current run in this view; shown only while running",
    "ko": "현재 화면에서 관찰한 실행 시간이며, 실행 중에만 표시합니다"
  },
  "ui.current.runtime.connection.status": {
    "en": "Current runtime connection status",
    "ko": "현재 런타임 연결 상태"
  },
  "ui.selection.for.the.next.message.may.differ.from.the.actual.server.model": {
    "en": "Selection for the next message; may differ from the actual server model",
    "ko": "다음 메시지에 사용할 선택이며, 실제 서버 모델과 다를 수 있습니다"
  },
  "ui.selection.for.the.next.message": {
    "en": "Selection for the next message",
    "ko": "다음 메시지에 사용할 선택"
  },
  "ui.fast.selection.for.the.next.message.subject.to.support": {
    "en": "Fast selection for the next message, subject to support",
    "ko": "지원되는 경우 다음 메시지에 빠른 모드를 적용합니다"
  },
  "ui.task.mode.for.the.next.main.agent.message": {
    "en": "Task mode for the next Main Agent message",
    "ko": "다음 메인 에이전트 메시지의 작업 모드"
  },
  "ui.permission.settings.reported.by.the.current.host": {
    "en": "Permission settings reported by the current host",
    "ko": "현재 호스트가 보고한 권한 설정"
  },
  "ui.current.content.tokens.used.input.tokens.for.the.latest.turn.not.cumulative.usage": {
    "en": "Current Content tokens used; input tokens for the latest turn, not cumulative usage",
    "ko": "현재 사용한 컨텍스트 토큰으로, 누적 사용량이 아닌 최근 턴의 입력 토큰입니다"
  },
  "ui.content.window.size.minus.current.tokens.used.with.a.minimum.of.0": {
    "en": "Content window size minus current tokens used, with a minimum of 0",
    "ko": "컨텍스트 크기에서 현재 사용 토큰을 뺀 값으로, 최솟값은 0입니다"
  },
  "ui.current.usage.as.a.percentage.of.the.content.window": {
    "en": "Current usage as a percentage of the Content window",
    "ko": "컨텍스트 크기 대비 현재 사용 비율"
  },
  "ui.model.content.window.size.reported.by.the.runtime": {
    "en": "Model Content window size reported by the runtime",
    "ko": "런타임이 보고한 모델 컨텍스트 크기"
  },
  "ui.latest.reported.usage.percentage.of.the.7.day.account.limit.if.available": {
    "en": "Latest reported usage percentage of the 7-day account limit, if available",
    "ko": "제공되는 경우 최근 보고된 계정의 7일 한도 사용 비율"
  },
  "ui.100.minus.weekly.usage.an.absolute.token.count.is.not.provided": {
    "en": "100% minus Weekly usage; an absolute token count is not provided",
    "ko": "100%에서 주간 사용량을 뺀 값이며, 절대 토큰 수는 제공되지 않습니다"
  },
  "ui.number.of.work.and.verification.agents.called.by.main.agent": {
    "en": "Number of work and verification agents called by Main Agent",
    "ko": "메인 에이전트가 호출한 작업·검증 에이전트 수"
  },
  "ui.main.agent.goal.setting.and.latest.reported.goal.status": {
    "en": "Main Agent Goal setting and latest reported goal status",
    "ko": "메인 에이전트의 목표 설정과 최근 보고된 목표 상태"
  },
  "ui.cumulative.tokens.used.as.reported.by.the.goal": {
    "en": "Cumulative tokens used as reported by the goal",
    "ko": "목표에서 보고된 누적 사용 토큰"
  },
  "ui.cumulative.time.used.as.reported.by.the.goal": {
    "en": "Cumulative time used as reported by the goal",
    "ko": "목표에서 보고된 누적 사용 시간"
  },
  "ui.token.budget.assigned.to.the.goal.if.available": {
    "en": "Token budget assigned to the goal, if available",
    "ko": "제공되는 경우 목표에 할당된 토큰 예산"
  },
  "ui.normal": {
    "en": "Normal",
    "ko": "일반"
  },
  "ui.direct": {
    "en": "Direct",
    "ko": "직접 전송"
  },
  "ui.main.agent": {
    "en": "Main Agent",
    "ko": "메인 에이전트"
  },
  "ui.main.agent.chat": {
    "en": "Main Agent chat",
    "ko": "메인 에이전트 채팅"
  },
  "ui.conversation": {
    "en": "Conversation",
    "ko": "대화"
  },
  "ui.compose.message": {
    "en": "Compose message",
    "ko": "메시지 작성"
  },
  "ui.work.and.verification.details": {
    "en": "Work and verification details",
    "ko": "작업 및 검증 상세"
  },
  "ui.drop.files.or.folders.to.attach": {
    "en": "Drop files or folders to attach",
    "ko": "파일 또는 폴더를 끌어 놓아 첨부하세요"
  },
  "ui.attachments": {
    "en": "Attachments",
    "ko": "첨부"
  },
  "ui.main.agent.sessions": {
    "en": "Main Agent sessions",
    "ko": "메인 에이전트 세션"
  },
  "ui.ongoing.goal": {
    "en": "Ongoing goal",
    "ko": "진행 중인 목표"
  },
  "ui.refresh.status": {
    "en": "Refresh status",
    "ko": "상태 새로고침"
  },
  "ui.pause": {
    "en": "Pause",
    "ko": "일시 중지"
  },
  "ui.resume": {
    "en": "Resume",
    "ko": "재개"
  },
  "ui.cancel": {
    "en": "Cancel",
    "ko": "취소"
  },
  "ui.cancel.goal": {
    "en": "Cancel goal",
    "ko": "목표 취소"
  },
  "ui.turn.off.goal": {
    "en": "Turn off Goal",
    "ko": "목표 끄기"
  },
  "ui.called.work.and.verification.agents": {
    "en": "Called work and verification agents",
    "ko": "호출된 작업 및 검증 에이전트"
  },
  "ui.agent.status": {
    "en": "Agent status",
    "ko": "에이전트 상태"
  },
  "ui.starting.main.agent": {
    "en": "Starting Main Agent",
    "ko": "메인 에이전트 시작 중"
  },
  "ui.main.agent.running": {
    "en": "Main Agent running",
    "ko": "메인 에이전트 실행 중"
  },
  "ui.attachments.c53076": {
    "en": "Attachments: ",
    "ko": "첨부: "
  },
  "ui.enter.what.you.want.help.with.include.the.target.and.desired.result.for.example.fix.the.login.error.in.this.file": {
    "en": "Enter what you want help with. Include the target and desired result, for example: ‘Fix the login error in this file.’",
    "ko": "도움이 필요한 내용을 입력하세요. 대상과 원하는 결과를 포함해 주세요. 예: ‘이 파일의 로그인 오류를 수정해 주세요.’"
  },
  "ui.shorten.the.goal.to.4.000.characters": {
    "en": "Shorten the goal to 4,000 characters.",
    "ko": "목표를 4,000자 이하로 줄여 주세요."
  },
  "ui.describe.the.goal.you.want.to.achieve.for.example.make.the.attached.page.usable.on.mobile": {
    "en": "Describe the goal you want to achieve, for example: ‘Make the attached page usable on mobile.’",
    "ko": "달성하려는 목표를 설명해 주세요. 예: ‘첨부한 페이지를 모바일에서 사용할 수 있게 해 주세요.’"
  },
  "ui.preparing.image.attachments.please.send.again.shortly": {
    "en": "Preparing image attachments. Please send again shortly.",
    "ko": "이미지 첨부를 준비하고 있습니다. 잠시 후 다시 보내 주세요."
  },
  "ui.the.run.was.cancelled": {
    "en": "The run was cancelled.",
    "ko": "실행이 취소되었습니다."
  },
  "ui.attach.up.to.8.png.jpeg.gif.or.webp.images.with.a.maximum.of.10.mib.each.and.20.mib.total": {
    "en": "Attach up to 8 PNG, JPEG, GIF, or WebP images, with a maximum of 10 MiB each and 20 MiB total.",
    "ko": "PNG, JPEG, GIF, WebP 이미지를 최대 8개 첨부할 수 있습니다. 개별 10 MiB, 전체 20 MiB 이하여야 합니다."
  },
  "ui.unable.to.read.the.image": {
    "en": "Unable to read the image.",
    "ko": "이미지를 읽을 수 없습니다."
  },
  "ui.invalid.image": {
    "en": "invalid image",
    "ko": "유효하지 않은 이미지"
  },
  "ui.image.read.failed": {
    "en": "image read failed",
    "ko": "이미지 읽기 실패"
  },
  "ui.respond.to.the.proposal.above": {
    "en": "Respond to the proposal above",
    "ko": "위 제안에 응답"
  },
  "ui.proceed.as.proposed": {
    "en": "Proceed as proposed",
    "ko": "제안대로 진행"
  },
  "ui.reply.directly": {
    "en": "Reply directly",
    "ko": "직접 답변"
  },
  "ui.check.execution.environment": {
    "en": "Check execution environment",
    "ko": "실행 환경 확인"
  },
  "ui.check.supported.features": {
    "en": "Check supported features",
    "ko": "지원 기능 확인"
  },
  "ui.submit.task": {
    "en": "Submit task",
    "ko": "작업 제출"
  },
  "ui.send.follow.up": {
    "en": "Send follow-up",
    "ko": "후속 메시지 보내기"
  },
  "ui.check.task.status": {
    "en": "Check task status",
    "ko": "작업 상태 확인"
  },
  "ui.read.task.result": {
    "en": "Read task result",
    "ko": "작업 결과 읽기"
  },
  "ui.start.task": {
    "en": "Request task",
    "ko": "작업 요청"
  },
  "ui.plan.work.agent": {
    "en": "Plan · Work agent",
    "ko": "계획 · 작업 에이전트"
  },
  "ui.verification.agent": {
    "en": "Verification agent",
    "ko": "검증 에이전트"
  },
  "ui.work.agent": {
    "en": "Work agent",
    "ko": "작업 에이전트"
  },
  "ui.in.progress": {
    "en": "In progress",
    "ko": "진행 중"
  },
  "ui.runtime.error": {
    "en": "Runtime error",
    "ko": "런타임 오류"
  },
  "ui.no.separate.verification.requested": {
    "en": " · No separate verification requested",
    "ko": " · 별도 검증 요청 없음"
  },
  "ui.submit.run": {
    "en": "Submit run",
    "ko": "실행 제출"
  },
  "ui.start.work": {
    "en": "Request work",
    "ko": "작업 요청"
  },
  "ui.check.status": {
    "en": "Check status",
    "ko": "상태 확인"
  },
  "ui.get.result": {
    "en": "Get result",
    "ko": "결과 가져오기"
  },
  "ui.get.updates": {
    "en": "Get updates",
    "ko": "업데이트 가져오기"
  },
  "ui.reconcile.work": {
    "en": "Reconcile work",
    "ko": "작업 상태 조정"
  },
  "ui.recover.run": {
    "en": "Recover run",
    "ko": "실행 복구"
  },
  "ui.skip.verification": {
    "en": "Skip verification",
    "ko": "검증 생략"
  },
  "ui.check.run": {
    "en": "Check run",
    "ko": "실행 확인"
  },
  "ui.failed": {
    "en": " failed",
    "ko": " 실패"
  },
  "ui.in.progress.3d921e": {
    "en": " in progress",
    "ko": " 진행 중"
  },
  "ui.acceptance.unconfirmed": {
    "en": " · Acceptance unconfirmed",
    "ko": " · 접수 미확인"
  },
  "ui.processed": {
    "en": " processed",
    "ko": " 처리됨"
  },
  "ui.open.chat": {
    "en": "Open chat",
    "ko": "채팅 열기"
  },
  "ui.command.and.run.history": {
    "en": "Command and run history · ",
    "ko": "명령 및 실행 기록 · "
  },
  "ui.plan.work.f294a9": {
    "en": "Plan → Work",
    "ko": "계획 → 작업"
  },
  "ui.work.verification.6a0009": {
    "en": "Work → Verification",
    "ko": "작업 → 검증"
  },
  "ui.plan.work.verification.d02a66": {
    "en": "Plan → Work → Verification",
    "ko": "계획 → 작업 → 검증"
  },
  "ui.submission.method": {
    "en": "Submission method",
    "ko": "전송 방식"
  },
  "ui.view.delivered.guidance": {
    "en": "View delivered guidance",
    "ko": "전달한 지침 보기"
  },
  "ui.application.added.guidance.for.this.request.this.is.not.the.full.provider.prompt": {
    "en": "Application-added guidance for this request. This is not the full provider prompt.",
    "ko": "이 요청에 앱이 추가한 지침입니다. 공급자 프롬프트 전체는 아닙니다."
  },
  "ui.paused.jump.to.the.bottom.to.resume": {
    "en": "Paused · Jump to the bottom to resume",
    "ko": "일시 중지됨 · 맨 아래로 이동하여 재개"
  },
  "ui.auto.scroll.on": {
    "en": "Auto-scroll ON · ",
    "ko": "자동 스크롤 켜짐 · "
  },
  "ui.click.to.turn.off": {
    "en": " · Click to turn off",
    "ko": " · 클릭하여 끄기"
  },
  "ui.auto.scroll.off.click.to.jump.to.the.latest.content.and.turn.on": {
    "en": "Auto-scroll OFF · Click to jump to the latest content and turn on",
    "ko": "자동 스크롤 꺼짐 · 클릭하여 최신 내용으로 이동하고 켜기"
  },
  "ui.git.changes": {
    "en": "Git changes",
    "ko": "Git 변경 사항"
  },
  "ui.tool.execution": {
    "en": "Tool execution",
    "ko": "도구 실행"
  },
  "ui.succeeded": {
    "en": "Succeeded",
    "ko": "성공"
  },
  "ui.failed.09fef5": {
    "en": "Failed",
    "ko": "실패"
  },
  "ui.failed.0f4f56": {
    "en": "Failed ",
    "ko": "실패: "
  },
  "ui.ran": {
    "en": "Command finished: ",
    "ko": "명령 실행 완료: "
  },
  "ui.running": {
    "en": "Running ",
    "ko": "실행 중: "
  },
  "ui.expand.full.command": {
    "en": "Expand full command",
    "ko": "전체 명령 펼치기"
  },
  "ui.collapse.command": {
    "en": "Collapse command",
    "ko": "명령 접기"
  },
  "ui.no.output": {
    "en": "(no output)",
    "ko": "(출력 없음)"
  },
  "ui.view.run.result": {
    "en": "View run result",
    "ko": "실행 결과 보기"
  },
  "ui.edited": {
    "en": "Edited ",
    "ko": "수정됨: "
  },
  "ui.view.git.diff": {
    "en": "View Git diff",
    "ko": "Git 변경 비교 보기"
  },
  "ui.more.lines": {
    "en": " more lines",
    "ko": "줄 더 보기"
  },
  "ui.execution.identifiers": {
    "en": "Execution identifiers",
    "ko": "실행 식별자"
  },
  "ui.chat.with.session": {
    "en": " · Chat with session",
    "ko": " · 세션에서 채팅"
  },
  "ui.reserved.verification.agent": {
    "en": "Reserved Verification Agent",
    "ko": "예약된 검증 에이전트"
  },
  "ui.copy": {
    "en": "Copy",
    "ko": "복사"
  },
  "ui.copy.fafe60": {
    "en": " · Copy",
    "ko": " · 복사"
  },
  "ui.working": {
    "en": "Working",
    "ko": "작업 중"
  },
  "ui.move.with.alt.left.right": {
    "en": " · Move with Alt+Left/Right",
    "ko": " · Alt+Left/Right로 이동"
  },
  "ui.work.274b31": {
    "en": "Work ",
    "ko": "작업 "
  },
  "ui.verification.59257e": {
    "en": " · Verification ",
    "ko": " · 검증 "
  },
  "ui.active": {
    "en": " active",
    "ko": "개 실행 중"
  },
  "ui.called": {
    "en": " called",
    "ko": "개 호출됨"
  },
  "ui.preparing": {
    "en": "Preparing",
    "ko": "준비 중"
  },
  "ui.no.work.or.verification.agents.have.been.called.yet": {
    "en": "No work or verification agents have been called yet.",
    "ko": "아직 호출된 작업 또는 검증 에이전트가 없습니다."
  },
  "ui.open.session": {
    "en": " · Open session",
    "ko": " · 세션 열기"
  },
  "ui.open.original": {
    "en": " · Open original",
    "ko": " · 원본 열기"
  },
  "ui.remove.attachment": {
    "en": " · Remove attachment",
    "ko": " · 첨부 제거"
  },
  "ui.no.user.questions.yet": {
    "en": "No user questions yet.",
    "ko": "아직 사용자 질문이 없습니다."
  },
  "ui.message.with.attachments": {
    "en": "Message with attachments",
    "ko": "첨부가 있는 메시지"
  },
  "ui.loading.sessions": {
    "en": "Loading sessions…",
    "ko": "세션을 불러오는 중…"
  },
  "ui.no.main.agent.sessions.to.load": {
    "en": "No Main Agent sessions to load.",
    "ko": "불러올 메인 에이전트 세션이 없습니다."
  },
  "ui.user.questions.2eec27": {
    "en": "User questions (",
    "ko": "사용자 질문 ("
  },
  "ui.getting.sleepy": {
    "en": "Getting sleepy",
    "ko": "졸리는 중"
  },
  "ui.sleeping": {
    "en": "Sleeping",
    "ko": "자는 중"
  },
  "ui.ready": {
    "en": "Ready",
    "ko": "준비됨"
  },
  "ui.waiting.for.your.reply": {
    "en": "Waiting for your reply",
    "ko": "답변 대기 중"
  },
  "ui.completed": {
    "en": "Completed",
    "ko": "완료"
  },
  "ui.needs.attention": {
    "en": "Needs attention",
    "ko": "확인 필요"
  },
  "ui.resting.runtime.offline": {
    "en": "Resting · Runtime offline",
    "ko": "쉬는 중 · 런타임 오프라인"
  },
  "ui.factory.bot": {
    "en": "Factory Bot · ",
    "ko": "Factory Bot · "
  },
  "ui.factory.bot.ready": {
    "en": "Factory Bot · Ready",
    "ko": "Factory Bot · 준비됨"
  },
  "ui.luna.none": {
    "en": " · Luna (none)",
    "ko": " · Luna (추론 없음)"
  },
  "ui.local.animation.luna.unavailable": {
    "en": " · Local animation (Luna unavailable)",
    "ko": " · 로컬 애니메이션 (Luna 사용 불가)"
  },
  "ui.active.agent.tasks": {
    "en": "Active agent tasks ",
    "ko": "실행 중인 에이전트 작업 "
  },
  "ui.total.calls": {
    "en": " · Total calls ",
    "ko": " · 전체 호출 "
  },
  "ui.agent.status.unavailable.click.to.refresh": {
    "en": "Agent status unavailable · Click to refresh",
    "ko": "에이전트 상태를 알 수 없음 · 클릭하여 새로고침"
  },
  "ui.loading.called.agents": {
    "en": "Loading called agents…",
    "ko": "호출된 에이전트를 불러오는 중…"
  },
  "ui.click.to.chat": {
    "en": " · Click to chat",
    "ko": " · 클릭하여 채팅"
  },
  "ui.queued": {
    "en": "Queued",
    "ko": "대기 중"
  },
  "ui.starting": {
    "en": "Starting",
    "ko": "시작 중"
  },
  "ui.running.73989d": {
    "en": "Running",
    "ko": "실행 중"
  },
  "ui.cancelling": {
    "en": "Cancelling",
    "ko": "취소 중"
  },
  "ui.cancelled": {
    "en": "Cancelled",
    "ko": "취소됨"
  },
  "ui.user.decision.required": {
    "en": "User decision required",
    "ko": "사용자 결정 필요"
  },
  "ui.status.unknown": {
    "en": "Status unknown",
    "ko": "상태를 알 수 없음"
  },
  "ui.position.updated": {
    "en": " position updated.",
    "ko": " 위치를 변경했습니다."
  },
  "ui.visible": {
    "en": "Visible · ",
    "ko": "표시 중 · "
  },
  "ui.earlier": {
    "en": "Earlier",
    "ko": "앞으로"
  },
  "ui.later": {
    "en": "Later",
    "ko": "뒤로"
  },
  "ui.move": {
    "en": " · Move",
    "ko": " · 이동"
  },
  "ui.active.a733b8": {
    "en": "Active",
    "ko": "활성"
  },
  "ui.paused": {
    "en": "Paused",
    "ko": "일시 중지됨"
  },
  "ui.awaiting.input": {
    "en": "Awaiting input",
    "ko": "입력 대기 중"
  },
  "ui.usage.limit": {
    "en": "Usage limit",
    "ko": "사용량 한도"
  },
  "ui.budget.limit": {
    "en": "Budget limit",
    "ko": "예산 한도"
  },
  "ui.done": {
    "en": "Done",
    "ko": "완료"
  },
  "ui.workspace": {
    "en": "Workspace",
    "ko": "작업 공간"
  },
  "ui.full.bypass": {
    "en": "Full · Bypass",
    "ko": "전체 접근 · 승인 생략"
  },
  "ui.idle": {
    "en": "Idle",
    "ko": "대기"
  },
  "ui.offline": {
    "en": "Offline",
    "ko": "오프라인"
  },
  "ui.verify": {
    "en": "Verify",
    "ko": "검증"
  },
  "ui.verify.57f501": {
    "en": " · Verify ",
    "ko": " · 검증 "
  },
  "ui.agents": {
    "en": "Agents —",
    "ko": "에이전트 —"
  },
  "ui.agents.main.only": {
    "en": "Agents: Main only",
    "ko": "에이전트: 메인 전용"
  },
  "ui.calls": {
    "en": "Calls ",
    "ko": "호출 "
  },
  "ui.calls.main.only": {
    "en": "Calls: Main only",
    "ko": "호출: 메인 전용"
  },
  "ui.project.f7d911": {
    "en": "Project —",
    "ko": "프로젝트 —"
  },
  "ui.ctx.window": {
    "en": "Ctx window ",
    "ko": "컨텍스트 크기 "
  },
  "ui.tokens": {
    "en": " tokens",
    "ko": " 토큰"
  },
  "ui.wk.used": {
    "en": "Wk used ",
    "ko": "주간 사용 "
  },
  "ui.wk.left": {
    "en": "Wk left ",
    "ko": "주간 잔여 "
  },
  "ui.elapsed": {
    "en": "Elapsed ",
    "ko": "경과 "
  },
  "ui.elapsed.54e60c": {
    "en": "Elapsed —",
    "ko": "경과 —"
  },
  "ui.queue": {
    "en": "Queue ",
    "ko": "대기 "
  },
  "ui.runtime.online": {
    "en": "Runtime online",
    "ko": "런타임 온라인"
  },
  "ui.runtime.offline": {
    "en": "Runtime offline",
    "ko": "런타임 오프라인"
  },
  "ui.model.b32422": {
    "en": "Model ",
    "ko": "모델 "
  },
  "ui.unknown": {
    "en": "Unknown",
    "ko": "알 수 없음"
  },
  "ui.reasoning.529e9c": {
    "en": "Reasoning ",
    "ko": "추론 "
  },
  "ui.fast.314aef": {
    "en": "Fast ",
    "ko": "빠른 모드 "
  },
  "ui.on": {
    "en": "On",
    "ko": "켜짐"
  },
  "ui.off": {
    "en": "Off",
    "ko": "꺼짐"
  },
  "ui.task": {
    "en": "Task ",
    "ko": "작업 "
  },
  "ui.task.main.only": {
    "en": "Task: Main only",
    "ko": "작업: 메인 전용"
  },
  "ui.perms": {
    "en": "Perms ",
    "ko": "권한 "
  },
  "ui.goal.main.only": {
    "en": "Goal: Main only",
    "ko": "목표: 메인 전용"
  },
  "ui.goal.0c4444": {
    "en": "Goal —",
    "ko": "목표 —"
  },
  "ui.goal.8c9d70": {
    "en": "Goal ",
    "ko": "목표 "
  },
  "ui.on.unknown": {
    "en": "On · Unknown",
    "ko": "켜짐 · 알 수 없음"
  },
  "ui.goal.used": {
    "en": "Goal used ",
    "ko": "목표 사용 "
  },
  "ui.goal.budget": {
    "en": "Goal budget ",
    "ko": "목표 예산 "
  },
  "ui.goal.time": {
    "en": "Goal time ",
    "ko": "목표 시간 "
  },
  "ui.queued.ae6ff9": {
    "en": "Queued ",
    "ko": "대기 "
  },
  "ui.queued.0": {
    "en": "Queued 0",
    "ko": "대기 0"
  },
  "ui.queued.messages.691bc5": {
    "en": "Queued messages ",
    "ko": "대기 메시지 "
  },
  "ui.items": {
    "en": " items",
    "ko": "개"
  },
  "ui.items.expand.collapse.list": {
    "en": " items · Expand/collapse list",
    "ko": "개 · 목록 펼치기/접기"
  },
  "ui.queued.messages.will.run.together.after.your.decision": {
    "en": "Queued messages will run together after your decision",
    "ko": "사용자 결정 후 대기 메시지를 함께 실행합니다"
  },
  "ui.queued.messages.retain.their.execution.action.only.matching.actions.run.together": {
    "en": "Queued messages retain their execution action. Only matching actions run together.",
    "ko": "대기 메시지는 각 실행 방식을 유지합니다. 같은 방식의 메시지만 함께 실행합니다."
  },
  "ui.check.run.status.and.resume.queue": {
    "en": "Check run status and resume queue",
    "ko": "실행 상태 확인 및 대기열 재개"
  },
  "ui.submission.unconfirmed.restore.to.input": {
    "en": "Submission unconfirmed · Restore to input",
    "ko": "제출 미확인 · 입력창으로 복원"
  },
  "ui.add.message.to.queue": {
    "en": "Add message to queue",
    "ko": "메시지를 대기열에 추가"
  },
  "ui.add.to.queue.enter": {
    "en": "Add to queue (Enter)",
    "ko": "대기열에 추가 (Enter)"
  },
  "ui.stop.current.run.esc": {
    "en": "Stop current run (Esc)",
    "ko": "현재 실행 중지 (Esc)"
  },
  "ui.input.required": {
    "en": "Input required",
    "ko": "입력 필요"
  },
  "ui.goal.budget.limit": {
    "en": "Goal budget limit",
    "ko": "목표 예산 한도"
  },
  "ui.goal.completed": {
    "en": "Goal completed",
    "ko": "목표 완료"
  },
  "ui.ultra.max.reasoning.effort": {
    "en": "Ultra · max reasoning effort",
    "ko": "Ultra · 최대 추론 수준"
  },
  "ui.start.a.fresh.codex.thread.here.agent.settings.and.historical.run.records.are.retained": {
    "en": "Start a fresh Codex thread here. Agent settings and historical run records are retained.",
    "ko": "여기서 새 Codex 대화를 시작합니다. 에이전트 설정과 이전 실행 기록은 유지됩니다."
  },
  "ui.clear.conversation": {
    "en": "Clear conversation",
    "ko": "대화 초기화"
  },
  "ui.requires.a.compatible.runtime": {
    "en": "Requires a compatible runtime.",
    "ko": "호환되는 런타임이 필요합니다."
  },
  "ui.send.draft": {
    "en": "Send draft: ",
    "ko": "작성한 메시지 전송: "
  },
  "ui.use.the.host.permission.policy": {
    "en": "Use the host permission policy.",
    "ko": "호스트 권한 정책을 사용합니다."
  },
  "ui.ctx.left": {
    "en": "Ctx left —",
    "ko": "컨텍스트 잔여 —"
  },
  "ui.ctx.left.350cbf": {
    "en": "Ctx left ",
    "ko": "컨텍스트 잔여 "
  },
  "ui.ctx.used": {
    "en": "Ctx used ",
    "ko": "컨텍스트 사용 "
  },
  "ui.ctx.left.tokens": {
    "en": "Ctx left — tokens",
    "ko": "컨텍스트 잔여 — 토큰"
  },
  "ui.none.71f8e7": {
    "en": "none",
    "ko": "없음"
  },
  "ui.low.36a883": {
    "en": "low",
    "ko": "낮음"
  },
  "ui.medium.20af41": {
    "en": "medium",
    "ko": "보통"
  },
  "ui.high.9235af": {
    "en": "high",
    "ko": "높음"
  },
  "ui.xhigh.dace18": {
    "en": "xhigh",
    "ko": "매우 높음"
  },
  "ui.max": {
    "en": "max",
    "ko": "최대"
  },
  "ui.loading.animation.samples": {
    "en": "Loading Animation Samples",
    "ko": "로딩 애니메이션 예시"
  },
  "ui.loading.animations": {
    "en": "Loading Animations",
    "ko": "로딩 애니메이션"
  },
  "ui.compare.six.options.at.the.size.and.theme.used.by.the.run.status.bar": {
    "en": "Compare six options at the size and theme used by the run status bar.",
    "ko": "실행 상태바의 크기와 테마에서 여섯 가지 방식을 비교합니다."
  },
  "ui.animation.controls": {
    "en": "Animation controls",
    "ko": "애니메이션 제어"
  },
  "ui.replay": {
    "en": "Replay",
    "ko": "다시 재생"
  },
  "ui.loading.animation.options": {
    "en": "Loading animation options",
    "ko": "로딩 애니메이션 선택지"
  },
  "ui.text.shimmer": {
    "en": "Text shimmer",
    "ko": "텍스트 반짝임"
  },
  "ui.current": {
    "en": "Current",
    "ko": "현재"
  },
  "ui.a.highlight.moves.across.the.status.text.for.a.subtle.information.focused.effect": {
    "en": "A highlight moves across the status text for a subtle, information-focused effect.",
    "ko": "상태 텍스트를 따라 은은한 강조 효과가 이동합니다."
  },
  "ui.text.shimmer.loading.animation": {
    "en": "Text shimmer loading animation",
    "ko": "텍스트 반짝임 로딩 애니메이션"
  },
  "ui.verifying.work.results": {
    "en": "Verifying work results",
    "ko": "작업 결과 검증 중"
  },
  "ui.work.2.verification.1": {
    "en": "Work 2 · Verification 1",
    "ko": "작업 2 · 검증 1"
  },
  "ui.18s": {
    "en": "18s",
    "ko": "18초"
  },
  "ui.soft.pulse": {
    "en": "Soft pulse",
    "ko": "부드러운 맥박"
  },
  "ui.a.small.dot.gently.pulses.keeping.long.running.work.easy.on.the.eyes": {
    "en": "A small dot gently pulses, keeping long-running work easy on the eyes.",
    "ko": "작은 점이 부드럽게 깜박여 긴 작업 중에도 눈이 편안합니다."
  },
  "ui.soft.pulse.loading.animation": {
    "en": "Soft pulse loading animation",
    "ko": "부드러운 맥박 로딩 애니메이션"
  },
  "ui.orbit": {
    "en": "Orbit",
    "ko": "궤도"
  },
  "ui.small.particles.orbit.the.center.to.show.that.the.agent.is.still.working": {
    "en": "Small particles orbit the center to show that the agent is still working.",
    "ko": "작은 입자가 중심을 돌며 에이전트의 작업 진행을 표시합니다."
  },
  "ui.orbit.loading.animation": {
    "en": "Orbit loading animation",
    "ko": "궤도 로딩 애니메이션"
  },
  "ui.thinking.dots": {
    "en": "Thinking dots",
    "ko": "생각하는 점"
  },
  "ui.three.dots.rise.in.sequence.for.a.familiar.conversational.effect": {
    "en": "Three dots rise in sequence for a familiar conversational effect.",
    "ko": "세 개의 점이 차례로 올라가며 익숙한 대화 효과를 냅니다."
  },
  "ui.thinking.dots.loading.animation": {
    "en": "Thinking dots loading animation",
    "ko": "생각하는 점 로딩 애니메이션"
  },
  "ui.signal": {
    "en": "Signal",
    "ko": "신호"
  },
  "ui.short.bars.rise.and.fall.suggesting.multiple.agents.working.in.parallel": {
    "en": "Short bars rise and fall, suggesting multiple agents working in parallel.",
    "ko": "짧은 막대가 오르내리며 여러 에이전트의 동시 작업을 나타냅니다."
  },
  "ui.signal.loading.animation": {
    "en": "Signal loading animation",
    "ko": "신호 로딩 애니메이션"
  },
  "ui.progress.track": {
    "en": "Progress track",
    "ko": "진행 트랙"
  },
  "ui.a.highlight.moves.along.the.bottom.to.show.progress.across.the.run.area": {
    "en": "A highlight moves along the bottom to show progress across the run area.",
    "ko": "하단을 따라 강조 효과가 이동하며 실행 진행을 표시합니다."
  },
  "ui.progress.track.loading.animation": {
    "en": "Progress track loading animation",
    "ko": "진행 트랙 로딩 애니메이션"
  },
  "ui.animations.appear.still.when.reduced.motion.is.enabled.in.your.system.settings": {
    "en": "Animations appear still when reduced motion is enabled in your system settings.",
    "ko": "시스템에서 동작 줄이기를 켜면 애니메이션이 정지합니다."
  },
  "ui.select.the.main.agent.chat.tab.to.rename.first": {
    "en": "Select the Main Agent chat tab to rename first.",
    "ko": "먼저 이름을 변경할 메인 에이전트 채팅 탭을 선택하세요."
  },
  "ui.rename.main.agent": {
    "en": "Rename Main Agent",
    "ko": "메인 에이전트 이름 변경"
  },
  "ui.enter.the.name.to.display.on.this.chat.tab": {
    "en": "Enter the name to display on this chat tab.",
    "ko": "이 채팅 탭에 표시할 이름을 입력하세요."
  },
  "ui.enter.a.name": {
    "en": "Enter a name.",
    "ko": "이름을 입력하세요."
  },
  "ui.the.name.must.be.no.more.than.80.characters": {
    "en": "The name must be no more than 80 characters.",
    "ko": "이름은 80자 이하여야 합니다."
  },
  "ui.enter.no.more.than.80.characters": {
    "en": "Enter no more than 80 characters.",
    "ko": "80자 이하로 입력하세요."
  },
  "ui.select.the.main.agent.chat.tab.to.clear.first": {
    "en": "Select the Main Agent chat tab to clear first.",
    "ko": "먼저 초기화할 메인 에이전트 채팅 탭을 선택하세요."
  },
  "ui.received.an.invalid.message.from.the.chat.view": {
    "en": "The chat screen request could not be processed. See the Extension Host log for details.",
    "ko": "채팅 화면의 동작 요청을 처리하지 못했습니다. 자세한 내용은 Extension Host 로그를 확인해 주세요."
  },
  "ui.queue.resume.failed": {
    "en": "Could not resume queued messages. See the Extension Host log for details, then try again.",
    "ko": "대기 메시지 재개 요청을 처리하지 못했습니다. Extension Host 로그를 확인한 후 다시 시도해 주세요."
  },
  "ui.unable.to.check.the.active.run.0": {
    "en": "Unable to check the active run: {0}",
    "ko": "진행 중인 실행을 확인할 수 없습니다: {0}"
  },
  "ui.this.request.has.already.been.answered.or.has.expired.reply.directly.in.the.current.conversation": {
    "en": "This request has already been answered or has expired. Reply directly in the current conversation.",
    "ko": "이미 응답했거나 만료된 요청입니다. 현재 대화에 직접 답변하세요."
  },
  "ui.another.session.is.loading": {
    "en": "Another session is loading.",
    "ko": "다른 세션을 불러오고 있습니다."
  },
  "ui.unable.to.open.the.link.0": {
    "en": "Unable to open the link: {0}",
    "ko": "링크를 열 수 없습니다: {0}"
  },
  "ui.unable.to.find.the.work.or.verification.session.called.by.main.agent": {
    "en": "Unable to find the work or verification session called by Main Agent.",
    "ko": "메인 에이전트가 호출한 작업 또는 검증 세션을 찾을 수 없습니다."
  },
  "ui.other.main.agent.sessions.can.only.be.loaded.from.a.main.agent.panel": {
    "en": "Other Main Agent sessions can only be loaded from a Main Agent panel.",
    "ko": "다른 메인 에이전트 세션은 메인 에이전트 패널에서만 불러올 수 있습니다."
  },
  "ui.load.another.session.after.the.current.run.finishes": {
    "en": "Load another session after the current run finishes.",
    "ko": "현재 실행이 끝난 후 다른 세션을 불러오세요."
  },
  "ui.the.selected.main.agent.session.was.not.found.in.the.current.project": {
    "en": "The selected Main Agent session was not found in the current project.",
    "ko": "현재 프로젝트에서 선택한 메인 에이전트 세션을 찾을 수 없습니다."
  },
  "ui.only.main.agent.conversations.can.be.cleared": {
    "en": "Only Main Agent conversations can be cleared.",
    "ko": "메인 에이전트 대화만 초기화할 수 있습니다."
  },
  "ui.wait.for.pending.messages.to.be.accepted.or.rejected.before.clearing.the.conversation": {
    "en": "Wait for pending messages to be accepted or rejected before clearing the conversation.",
    "ko": "대기 메시지의 접수 여부가 확정된 후 대화를 초기화하세요."
  },
  "ui.unable.to.confirm.child.agent.state.0": {
    "en": "Unable to confirm child Agent state: {0}",
    "ko": "하위 에이전트 상태를 확인할 수 없습니다: {0}"
  },
  "ui.wait.for.the.active.work.or.verification.agent.to.finish.before.clearing.the.conversation": {
    "en": "Wait for the active Work or Verification Agent to finish before clearing the conversation.",
    "ko": "실행 중인 작업 또는 검증 에이전트가 끝난 후 대화를 초기화하세요."
  },
  "ui.start.a.new.conversation.in.this.chat.the.main.agent.identity.settings.and.historical.run.records.will.be.retained": {
    "en": "Start a new conversation in this chat? The Main Agent identity, settings, and historical run records will be retained.",
    "ko": "이 채팅에서 새 대화를 시작하시겠습니까? 메인 에이전트 식별자, 설정과 이전 실행 기록은 유지됩니다."
  },
  "ui.a.message.is.now.pending.wait.for.it.to.be.accepted.or.rejected.before.clearing.the.conversation": {
    "en": "A message is now pending. Wait for it to be accepted or rejected before clearing the conversation.",
    "ko": "현재 대기 메시지가 있습니다. 접수 여부가 확정된 후 대화를 초기화하세요."
  },
  "ui.the.conversation.is.busy": {
    "en": "The conversation is busy.",
    "ko": "대화가 처리 중입니다."
  },
  "ui.started.a.new.conversation.historical.run.records.were.retained": {
    "en": "Started a new conversation. Historical run records were retained.",
    "ko": "새 대화를 시작했습니다. 이전 실행 기록은 유지되었습니다."
  },
  "ui.unable.to.clear.the.conversation.0": {
    "en": "Unable to clear the conversation: {0}",
    "ko": "대화를 초기화할 수 없습니다: {0}"
  },
  "ui.enter.a.chat.message.of.1.4.000.characters.or.turn.off.goal": {
    "en": "Enter a chat message of 1–4,000 characters or turn off Goal.",
    "ko": "1~4,000자의 채팅 메시지를 입력하거나 목표를 끄세요."
  },
  "ui.unable.to.connect.to.the.runtime.queued.messages.have.been.preserved": {
    "en": "Unable to connect to the runtime. Queued messages have been preserved.",
    "ko": "런타임에 연결할 수 없습니다. 대기 메시지는 보존되었습니다."
  },
  "ui.unable.to.locate.the.original.image.attachment.0": {
    "en": "Unable to locate the original image attachment: {0}",
    "ko": "첨부 이미지 원본을 찾을 수 없습니다: {0}"
  },
  "ui.unsupported.image.attachment.0": {
    "en": "Unsupported image attachment: {0}",
    "ko": "지원하지 않는 이미지 첨부입니다: {0}"
  },
  "ui.attach.files.to.chat": {
    "en": "Attach files to chat",
    "ko": "채팅에 파일 첨부"
  },
  "ui.attach.to.chat": {
    "en": "Attach to chat",
    "ko": "채팅에 첨부"
  },
  "ui.unable.to.prepare.attachments.0": {
    "en": "Unable to prepare attachments: {0}",
    "ko": "첨부를 준비할 수 없습니다: {0}"
  },
  "ui.excluded.0.images.due.to.attachment.limits.up.to.8.images.10.mib.each.20.mib.total": {
    "en": "Excluded {0} images due to attachment limits (up to 8 images, 10 MiB each, 20 MiB total).",
    "ko": "첨부 제한으로 이미지 {0}개를 제외했습니다 (최대 8개, 개별 10 MiB, 전체 20 MiB)."
  },
  "ui.unable.to.create.a.file.from.pasted.text.0": {
    "en": "Unable to create a file from pasted text: {0}",
    "ko": "붙여넣은 텍스트로 파일을 만들 수 없습니다: {0}"
  },
  "ui.image.attachment.limit.exceeded": {
    "en": "Image attachment limit exceeded.",
    "ko": "이미지 첨부 한도를 초과했습니다."
  },
  "ui.unable.to.save.the.image.attachment.0": {
    "en": "Unable to save the image attachment: {0}",
    "ko": "이미지 첨부를 저장할 수 없습니다: {0}"
  },
  "ui.the.image.is.unsupported.or.too.large": {
    "en": "The image is unsupported or too large.",
    "ko": "지원하지 않거나 크기가 너무 큰 이미지입니다."
  },
  "ui.the.original.image.no.longer.exists": {
    "en": "The original image no longer exists.",
    "ko": "이미지 원본이 더 이상 존재하지 않습니다."
  },
  "ui.unable.to.clean.up.temporary.image.files.0": {
    "en": "Unable to clean up temporary image files: {0}",
    "ko": "임시 이미지 파일을 정리할 수 없습니다: {0}"
  },
  "ui.unable.to.save.status.bar.settings.reloading.the.saved.settings": {
    "en": "Unable to save status bar settings. Reloading the saved settings.",
    "ko": "상태바 설정을 저장할 수 없습니다. 저장된 설정을 다시 불러옵니다."
  },
  "ui.no.workspace": {
    "en": "No workspace",
    "ko": "작업 공간 없음"
  },
  "ui.unsupported.image.format": {
    "en": "Unsupported image format.",
    "ko": "지원하지 않는 이미지 형식입니다."
  },
  "ui.symbolic.link.images.cannot.be.attached": {
    "en": "Symbolic link images cannot be attached.",
    "ko": "심볼릭 링크 이미지는 첨부할 수 없습니다."
  },
  "ui.image.size.is.outside.the.allowed.range": {
    "en": "Image size is outside the allowed range.",
    "ko": "이미지 크기가 허용 범위를 벗어났습니다."
  },
  "ui.the.image.changed.while.being.read": {
    "en": "The image changed while being read.",
    "ko": "이미지를 읽는 동안 파일이 변경되었습니다."
  },
  "ui.0.image.scope.is.invalid": {
    "en": "{0} image scope is invalid",
    "ko": "{0} 이미지 범위가 유효하지 않습니다"
  },
  "ui.unable.to.load.the.chat.view": {
    "en": "Unable to load the chat view.",
    "ko": "채팅 화면을 불러올 수 없습니다."
  },
  "ui.a.conversation.reset.is.already.processing": {
    "en": "A conversation reset is already processing.",
    "ko": "대화 초기화가 이미 진행 중입니다."
  },
  "ui.finish.or.cancel.the.current.run.first": {
    "en": "Finish or cancel the current run first.",
    "ko": "먼저 현재 실행을 완료하거나 취소하세요."
  },
  "ui.send.restore.or.remove.queued.messages.first": {
    "en": "Send, restore, or remove queued messages first.",
    "ko": "먼저 대기 메시지를 보내거나 복원 또는 제거하세요."
  },
  "ui.resolve.the.pending.human.decision.first": {
    "en": "Resolve the pending Human decision first.",
    "ko": "먼저 대기 중인 사용자 결정을 처리하세요."
  },
  "ui.wait.for.the.goal.control.request.to.finish": {
    "en": "Wait for the Goal control request to finish.",
    "ko": "목표 제어 요청이 완료될 때까지 기다려 주세요."
  },
  "ui.send.a.message.before.clearing.this.conversation": {
    "en": "Send a message before clearing this conversation.",
    "ko": "메시지를 보낸 후 대화를 초기화하세요."
  },
  "ui.reconnected.to.the.active.run": {
    "en": "Reconnected to the active run.",
    "ko": "진행 중인 실행에 다시 연결했습니다."
  },
  "ui.the.previous.goal.control.request.is.still.processing.send.again.after.it.finishes": {
    "en": "The previous Goal control request is still processing. Send again after it finishes.",
    "ko": "이전 목표 제어 요청을 아직 처리하고 있습니다. 완료 후 다시 보내 주세요."
  },
  "ui.queued.messages.will.run.together.after.the.current.run.finishes": {
    "en": "Queued messages will run together after the current run finishes.",
    "ko": "현재 실행이 끝나면 대기 메시지를 함께 실행합니다."
  },
  "ui.queued.messages.will.be.processed.together.after.your.decision": {
    "en": "Queued messages will be processed together after your decision.",
    "ko": "사용자 결정 후 대기 메시지를 함께 처리합니다."
  },
  "ui.submitting.0.queued.messages.as.one.request.task.mode.model.and.reasoning.use.the.first.message.settings.permissions.use.their.common.allowed.scope": {
    "en": "Submitting {0} queued messages as one request. Task mode, model, and reasoning use the first message settings; permissions use their common allowed scope.",
    "ko": "대기 메시지 {0}개를 하나의 요청으로 제출합니다. 작업 모드·모델·추론은 첫 메시지 설정을, 권한은 공통 허용 범위를 사용합니다."
  },
  "ui.the.previous.goal.control.request.is.still.processing": {
    "en": "The previous Goal control request is still processing.",
    "ko": "이전 목표 제어 요청을 아직 처리하고 있습니다."
  },
  "ui.reopen.goal.after.the.current.run.finishes": {
    "en": "Reopen Goal after the current run finishes.",
    "ko": "현재 실행이 끝난 후 목표를 재개하세요."
  },
  "ui.unable.to.connect.the.goal.run.while.another.run.is.active": {
    "en": "Unable to connect the Goal run while another run is active.",
    "ko": "다른 실행이 진행 중이므로 목표 실행에 연결할 수 없습니다."
  },
  "ui.requested.cancellation.as.soon.as.the.goal.run.is.accepted": {
    "en": "Requested cancellation as soon as the Goal run is accepted.",
    "ko": "목표 실행이 접수되는 즉시 취소하도록 요청했습니다."
  },
  "ui.requested.cancellation.as.soon.as.the.run.is.accepted": {
    "en": "Requested cancellation as soon as the run is accepted.",
    "ko": "실행이 접수되는 즉시 취소하도록 요청했습니다."
  },
  "ui.execution.environment.check.failed.after.the.run.finishes.select.the.required.permissions.and.retry.with.your.next.message": {
    "en": "Execution environment check failed. After the run finishes, select the required permissions and retry with your next message.",
    "ko": "실행 환경 확인에 실패했습니다. 실행이 끝난 후 필요한 권한을 선택하고 다음 메시지로 다시 시도하세요."
  },
  "ui.preserved.partial.result.completion.unconfirmed.0": {
    "en": "Preserved partial result (completion unconfirmed):\n{0}",
    "ko": "보존된 부분 결과 (완료 미확인):\n{0}"
  },
  "ui.0.preserved.partial.result.completion.unconfirmed.1": {
    "en": "{0}\n\nPreserved partial result (completion unconfirmed):\n{1}",
    "ko": "{0}\n\n보존된 부분 결과 (완료 미확인):\n{1}"
  },
  "ui.timed.out.checking.agent.factory.run.status.check.the.run.in.the.runtime.records": {
    "en": "Timed out checking Agent Factory run status. Check the run in the runtime records.",
    "ko": "Agent Factory 실행 상태 확인 시간이 초과되었습니다. 런타임 기록에서 실행을 확인하세요."
  },
  "ui.cannot.safely.merge.inherited.and.explicit.permissions.for.queued.messages.restore.them.to.the.input.and.resend.with.matching.execution.permissions": {
    "en": "Cannot safely merge inherited and explicit permissions for queued messages. Restore them to the input and resend with matching execution permissions.",
    "ko": "대기 메시지의 상속 권한과 명시 권한을 안전하게 합칠 수 없습니다. 입력창으로 복원한 후 실행 권한을 맞추어 다시 보내세요."
  },
  "ui.queued.messages.have.different.execution.owners.or.verification.targets.and.were.not.merged.restore.the.input.for.each.original.target": {
    "en": "Queued messages have different execution owners or verification targets and were not merged. Restore the input for each original target.",
    "ko": "대기 메시지의 실행 소유자 또는 검증 대상이 달라 합치지 않았습니다. 각 원래 대상에 맞게 입력을 복원하세요."
  },
  "ui.unable.to.prepare.the.image.attachment.as.a.safe.local.file.0": {
    "en": "Unable to prepare the image attachment as a safe local file: {0}",
    "ko": "첨부 이미지를 안전한 로컬 파일로 준비할 수 없습니다: {0}"
  },
  "ui.your.decision.is.required.to.continue.the.run": {
    "en": "Your decision is required to continue the run.",
    "ko": "실행을 계속하려면 사용자 결정이 필요합니다."
  },
  "ui.the.agent.factory.run.failed": {
    "en": "The Agent Factory run failed.",
    "ko": "Agent Factory 실행에 실패했습니다."
  },
  "ui.the.agent.factory.run.completed": {
    "en": "The Agent Factory run completed.",
    "ko": "Agent Factory 실행이 완료되었습니다."
  },
  "ui.use.the.button.to.start.a.new.agent.chat": {
    "en": "Use the ＋ button to start a new agent chat.",
    "ko": "＋ 버튼으로 새 에이전트 채팅을 시작하세요."
  },
  "ui.unable.to.load.the.list.refresh.to.try.again.0": {
    "en": "Unable to load the list. Refresh to try again. {0}",
    "ko": "목록을 불러올 수 없습니다. 새로고침하여 다시 시도하세요. {0}"
  },
  "ui.new.chat": {
    "en": "New chat",
    "ko": "새 채팅"
  },
  "ui.open.agent": {
    "en": "Open Agent",
    "ko": "에이전트 열기"
  },
  "ui.rename.agent": {
    "en": "Rename Agent",
    "ko": "에이전트 이름 변경"
  },
  "ui.new.agent.group": {
    "en": "New Agent Group",
    "ko": "새 에이전트 그룹"
  },
  "ui.rename.group": {
    "en": "Rename Group",
    "ko": "그룹 이름 변경"
  },
  "ui.no.group": {
    "en": "No group",
    "ko": "그룹 없음"
  },
  "ui.select.agent.group": {
    "en": "Select Agent Group",
    "ko": "에이전트 그룹 선택"
  },
  "ui.unable.to.read.the.extension.version": {
    "en": "Unable to read the extension version.",
    "ko": "익스텐션 버전을 읽을 수 없습니다."
  },
  "ui.checking.agent.factory.plugin.dependencies": {
    "en": "Checking Agent Factory plugin dependencies…",
    "ko": "Agent Factory 플러그인 의존성 확인 중…"
  },
  "ui.an.unknown.error.occurred": {
    "en": "An unknown error occurred.",
    "ko": "알 수 없는 오류가 발생했습니다."
  },
  "ui.unable.to.start.agent.factory.0.check.the.workspace.extension.host.ssh.wsl.or.container.when.remote.then.retry": {
    "en": "Unable to start Agent Factory. {0} Check the workspace extension host (SSH, WSL or container when remote), then Retry.",
    "ko": "Agent Factory를 시작할 수 없습니다. {0} 작업 공간 익스텐션 호스트 (원격 사용 시 SSH, WSL 또는 컨테이너)를 확인한 후 다시 시도하세요."
  },
  "ui.retry": {
    "en": "Retry",
    "ko": "다시 시도"
  },
  "ui.unable.to.install.agent.factory.plugin.version.0.the.configured.catalogs.do.not.offer.this.exact.version.refresh.the.official.marketplace.or.install.the.matching.extension.version.then.retry": {
    "en": "Unable to install Agent Factory plugin version {0}. The configured catalogs do not offer this exact version. Refresh the official marketplace or install the matching extension version, then Retry.",
    "ko": "Agent Factory 플러그인 {0} 버전을 설치할 수 없습니다. 구성된 카탈로그에 해당 버전이 없습니다. 공식 마켓플레이스를 새로고침하거나 일치하는 익스텐션 버전을 설치한 후 다시 시도하세요."
  },
  "ui.agent.factory.plugin.installation": {
    "en": "Agent Factory plugin installation",
    "ko": "Agent Factory 플러그인 설치"
  },
  "ui.agent.factory.plugin.installation.result": {
    "en": "Agent Factory plugin installation result",
    "ko": "Agent Factory 플러그인 설치 결과"
  },
  "ui.unable.to.confirm.that.agent.factory.plugin.0.is.active.after.installation.check.the.codex.plugin.settings": {
    "en": "Unable to confirm that Agent Factory plugin {0} is active after installation. Check the Codex plugin settings.",
    "ko": "설치 후 Agent Factory 플러그인 {0}의 활성 상태를 확인할 수 없습니다. Codex 플러그인 설정을 확인하세요."
  },
  "ui.register.official.agent.factory.marketplace": {
    "en": "Register official Agent Factory marketplace",
    "ko": "공식 Agent Factory 마켓플레이스 등록"
  },
  "ui.marketplace.registration.result": {
    "en": "Marketplace registration result",
    "ko": "마켓플레이스 등록 결과"
  },
  "ui.unable.to.confirm.official.agent.factory.marketplace.registration.retry.after.checking.codex.marketplace.settings": {
    "en": "Unable to confirm official Agent Factory marketplace registration. Retry after checking Codex marketplace settings.",
    "ko": "공식 Agent Factory 마켓플레이스 등록을 확인할 수 없습니다. Codex 마켓플레이스 설정을 확인한 후 다시 시도하세요."
  },
  "ui.list.codex.marketplaces": {
    "en": "List Codex marketplaces",
    "ko": "Codex 마켓플레이스 목록 조회"
  },
  "ui.codex.marketplace.list": {
    "en": "Codex marketplace list",
    "ko": "Codex 마켓플레이스 목록"
  },
  "ui.the.codex.marketplace.list.has.an.invalid.format": {
    "en": "The Codex marketplace list has an invalid format.",
    "ko": "Codex 마켓플레이스 목록 형식이 유효하지 않습니다."
  },
  "ui.marketplace.name.conflict.agent.factory.is.configured.with.a.different.or.unconfirmed.source.resolve.it.in.codex.marketplace.settings.then.retry.no.source.was.overwritten": {
    "en": "Marketplace name conflict: agent-factory is configured with a different or unconfirmed source. Resolve it in Codex marketplace settings, then Retry. No source was overwritten.",
    "ko": "마켓플레이스 이름 충돌: agent-factory가 다른 출처 또는 확인되지 않은 출처로 구성되어 있습니다. Codex 마켓플레이스 설정에서 해결한 후 다시 시도하세요. 기존 출처는 덮어쓰지 않았습니다."
  },
  "ui.the.plugin.version.is.empty.or.invalid": {
    "en": "The plugin version is empty or invalid.",
    "ko": "플러그인 버전이 비어 있거나 유효하지 않습니다."
  },
  "ui.list.available.codex.plugins": {
    "en": "List available Codex plugins",
    "ko": "사용 가능한 Codex 플러그인 목록 조회"
  },
  "ui.list.installed.codex.plugins": {
    "en": "List installed Codex plugins",
    "ko": "설치된 Codex 플러그인 목록 조회"
  },
  "ui.0.returned.a.non.string.result": {
    "en": "{0} returned a non-string result.",
    "ko": "{0} 결과가 문자열이 아닙니다."
  },
  "ui.0.output.exceeded.the.size.limit": {
    "en": "{0} output exceeded the size limit.",
    "ko": "{0} 출력이 크기 한도를 초과했습니다."
  },
  "ui.0.failed.the.codex.cli.executable.was.not.found.check.its.installation.and.path": {
    "en": "{0} failed. The Codex CLI executable was not found. Check its installation and PATH.",
    "ko": "{0} 실패. Codex CLI 실행 파일을 찾을 수 없습니다. 설치 상태와 PATH를 확인하세요."
  },
  "ui.0.timed.out.please.try.again.shortly": {
    "en": "{0} timed out. Please try again shortly.",
    "ko": "{0} 시간이 초과되었습니다. 잠시 후 다시 시도하세요."
  },
  "ui.0.failed.check.the.codex.cli.installation.and.execution.environment": {
    "en": "{0} failed. Check the Codex CLI installation and execution environment.",
    "ko": "{0} 실패. Codex CLI 설치 상태와 실행 환경을 확인하세요."
  },
  "ui.the.codex.plugin.list.is.not.valid.json": {
    "en": "The Codex plugin list is not valid JSON.",
    "ko": "Codex 플러그인 목록이 유효한 JSON이 아닙니다."
  },
  "ui.the.codex.plugin.list.json.is.missing.the.0.array": {
    "en": "The Codex plugin list JSON is missing the {0} array.",
    "ko": "Codex 플러그인 목록 JSON에 {0} 배열이 없습니다."
  },
  "ui.codex.plugin.list.record.0.has.an.invalid.format": {
    "en": "Codex plugin list record {0} has an invalid format.",
    "ko": "Codex 플러그인 목록의 {0}번째 레코드 형식이 유효하지 않습니다."
  },
  "ui.0.is.not.valid.json": {
    "en": "{0} is not valid JSON.",
    "ko": "{0}이(가) 유효한 JSON이 아닙니다."
  },
  "ui.0.is.not.a.json.object": {
    "en": "{0} is not a JSON object.",
    "ko": "{0}이(가) JSON 객체가 아닙니다."
  },
  "ui.local.development.plugin.must.match.extension.version.0.1": {
    "en": "Local development plugin must match extension version {0}: {1}",
    "ko": "로컬 개발 플러그인은 익스텐션 {0} 버전과 일치해야 합니다: {1}"
  },
  "ui.missing.local.development.plugin.file.0": {
    "en": "Missing local development plugin file: {0}",
    "ko": "로컬 개발 플러그인 파일이 없습니다: {0}"
  },
  "ui.image.attachment.data.size.does.not.match": {
    "en": "Image attachment data size does not match.",
    "ko": "이미지 첨부 데이터 크기가 일치하지 않습니다."
  },
  "ui.image.content.does.not.match.its.media.type": {
    "en": "Image content does not match its media type.",
    "ko": "이미지 내용과 미디어 유형이 일치하지 않습니다."
  },
  "ui.the.configured.agent.factory.exec.py.is.not.a.valid.regular.file.0": {
    "en": "The configured Agent Factory exec.py is not a valid regular file: {0}",
    "ko": "설정된 Agent Factory exec.py가 유효한 일반 파일이 아닙니다: {0}"
  },
  "ui.unable.to.find.the.agent.factory.plugin.cache.0": {
    "en": "Unable to find the Agent Factory plugin cache: {0}",
    "ko": "Agent Factory 플러그인 캐시를 찾을 수 없습니다: {0}"
  },
  "ui.matching.extension.version.0": {
    "en": " matching extension version {0}",
    "ko": " (익스텐션 {0} 버전과 일치)"
  },
  "ui.unable.to.find.0.in.the.agent.factory.plugin.1.installed.from.the.marketplace": {
    "en": "Unable to find {0} in the Agent Factory plugin{1} installed from the marketplace.",
    "ko": "마켓플레이스에서 설치한 Agent Factory 플러그인{1}에서 {0}을(를) 찾을 수 없습니다."
  },
  "ui.invalid.agent.factory.storage.location.response": {
    "en": "Invalid Agent Factory storage location response.",
    "ko": "Agent Factory 저장 위치 응답이 유효하지 않습니다."
  },
  "ui.agent.factory.storage.home.binding.does.not.match": {
    "en": "Agent Factory storage home binding does not match.",
    "ko": "Agent Factory 저장 홈 바인딩이 일치하지 않습니다."
  },
  "ui.invalid.agent.factory.managed.path": {
    "en": "Invalid Agent Factory managed path.",
    "ko": "Agent Factory 관리 경로가 유효하지 않습니다."
  },
  "ui.update.to.an.agent.factory.runtime.that.provides.native.capability.information": {
    "en": "Update to an Agent Factory runtime that provides native capability information.",
    "ko": "기본 기능 정보를 제공하는 Agent Factory 런타임으로 업데이트하세요."
  },
  "ui.invalid.codex.capability.response.format": {
    "en": "Invalid Codex capability response format.",
    "ko": "Codex 기능 응답 형식이 유효하지 않습니다."
  },
  "ui.agent.factory.goal.control.accepted.an.unexpected.run": {
    "en": "Agent Factory Goal control accepted an unexpected run.",
    "ko": "Agent Factory 목표 제어에서 예상하지 않은 실행이 접수되었습니다."
  },
  "ui.the.agent.factory.runtime.returned.an.invalid.conversation.reset.response": {
    "en": "The Agent Factory runtime returned an invalid conversation reset response.",
    "ko": "Agent Factory 런타임의 대화 초기화 응답이 유효하지 않습니다."
  },
  "ui.update.the.agent.factory.plugin.and.codex.to.versions.that.support.the.selected.task.mode": {
    "en": "Update the Agent Factory plugin and Codex to versions that support the selected task mode.",
    "ko": "선택한 작업 모드를 지원하는 버전으로 Agent Factory 플러그인과 Codex를 업데이트하세요."
  },
  "ui.the.current.agent.factory.runtime.has.an.incompatible.0.image.transfer.contract": {
    "en": "The current Agent Factory runtime has an incompatible {0} image transfer contract. ",
    "ko": "현재 Agent Factory 런타임의 {0} 이미지 전송 계약이 호환되지 않습니다. "
  },
  "ui.install.or.update.the.agent.factory.plugin.to.a.version.compatible.with.this.extension.then": {
    "en": "Install or update the Agent Factory plugin to a version compatible with this extension, then ",
    "ko": "이 익스텐션과 호환되는 Agent Factory 플러그인을 설치하거나 업데이트한 후 "
  },
  "ui.reload.the.vs.code.extension.host.and.try.attaching.the.images.again": {
    "en": "reload the VS Code extension host and try attaching the images again.",
    "ko": "VS Code 익스텐션 호스트를 다시 로드하고 이미지를 다시 첨부하세요."
  },
  "ui.the.current.runtime.0.command.does.not.support.these.settings.1": {
    "en": "The current runtime {0} command does not support these settings: {1}.",
    "ko": "현재 런타임의 {0} 명령은 다음 설정을 지원하지 않습니다: {1}."
  },
  "ui.unable.to.run.agent.factory.exec.py": {
    "en": "Unable to run Agent Factory exec.py.",
    "ko": "Agent Factory exec.py를 실행할 수 없습니다."
  },
  "ui.you.can.attach.up.to.8.images": {
    "en": "You can attach up to 8 images.",
    "ko": "이미지는 최대 8개 첨부할 수 있습니다."
  },
  "ui.image.file.size.is.outside.the.allowed.range": {
    "en": "Image file size is outside the allowed range.",
    "ko": "이미지 파일 크기가 허용 범위를 벗어났습니다."
  },
  "ui.the.image.file.changed.while.being.read": {
    "en": "The image file changed while being read.",
    "ko": "이미지 파일을 읽는 동안 변경되었습니다."
  },
  "ui.total.image.size.must.not.exceed.20.mib": {
    "en": "Total image size must not exceed 20 MiB.",
    "ko": "전체 이미지 크기는 20 MiB 이하여야 합니다."
  },
  "ui.invalid.agent.factory.progress.event.request": {
    "en": "Invalid Agent Factory progress event request.",
    "ko": "Agent Factory 진행 이벤트 요청이 유효하지 않습니다."
  },
  "ui.the.agent.factory.event.file.is.missing.or.exceeds.the.size.limit": {
    "en": "The Agent Factory event file is missing or exceeds the size limit.",
    "ko": "Agent Factory 이벤트 파일이 없거나 크기 한도를 초과했습니다."
  },
  "ui.the.agent.factory.event.file.exceeds.the.size.limit": {
    "en": "The Agent Factory event file exceeds the size limit.",
    "ko": "Agent Factory 이벤트 파일이 크기 한도를 초과했습니다."
  },
  "ui.invalid.agent.factory.session.list.response": {
    "en": "Invalid Agent Factory session list response.",
    "ko": "Agent Factory 세션 목록 응답이 유효하지 않습니다."
  },
  "ui.invalid.main.agent.identifier": {
    "en": "Invalid Main Agent identifier.",
    "ko": "메인 에이전트 식별자가 유효하지 않습니다."
  },
  "ui.invalid.main.agent.run.identifier": {
    "en": "Invalid Main Agent run identifier.",
    "ko": "메인 에이전트 실행 식별자가 유효하지 않습니다."
  },
  "ui.the.current.agent.factory.runtime.does.not.support.execution.permission.selection.update.the.plugin.and.try.again": {
    "en": "The current Agent Factory runtime does not support execution permission selection. Update the plugin and try again.",
    "ko": "현재 Agent Factory 런타임은 실행 권한 선택을 지원하지 않습니다. 플러그인을 업데이트한 후 다시 시도하세요."
  },
  "ui.the.agent.factory.runtime.did.not.return.a.valid.json.response": {
    "en": "The Agent Factory runtime did not return a valid JSON response.",
    "ko": "Agent Factory 런타임이 유효한 JSON 응답을 반환하지 않았습니다."
  },
  "ui.the.agent.factory.runtime.command.failed.with.exit.code.0": {
    "en": "The Agent Factory runtime command failed with exit code {0}.",
    "ko": "Agent Factory 런타임 명령이 종료 코드 {0}(으)로 실패했습니다."
  },
  "ui.agent.factory.exec.py.is.not.a.regular.file": {
    "en": "Agent Factory exec.py is not a regular file.",
    "ko": "Agent Factory exec.py가 일반 파일이 아닙니다."
  },
  "ui.the.agent.factory.runtime.returned.a.result.path.outside.the.expected.scope": {
    "en": "The Agent Factory runtime returned a result path outside the expected scope.",
    "ko": "Agent Factory 런타임의 결과 경로가 예상 범위를 벗어났습니다."
  },
  "ui.the.agent.factory.result.file.is.missing.or.exceeds.the.size.limit": {
    "en": "The Agent Factory result file is missing or exceeds the size limit.",
    "ko": "Agent Factory 결과 파일이 없거나 크기 한도를 초과했습니다."
  },
  "ui.invalid.execution.permissions": {
    "en": "Invalid execution permissions.",
    "ko": "실행 권한이 유효하지 않습니다."
  },
  "ui.goal.status.needs.attention": {
    "en": "Goal status needs attention",
    "ko": "목표 상태 확인 필요"
  },
  "ui.the.goal.is.active.codex.will.continue.with.the.next.turn": {
    "en": "The goal is active. Codex will continue with the next turn.",
    "ko": "목표가 활성화되어 있습니다. Codex가 다음 턴을 계속 진행합니다."
  },
  "ui.main.agent.connected": {
    "en": "Main Agent connected",
    "ko": "메인 에이전트 연결됨"
  },
  "ui.main.agent.is.analyzing.the.request": {
    "en": "Main Agent is analyzing the request",
    "ko": "메인 에이전트가 요청 분석 중"
  },
  "ui.finalizing.response": {
    "en": "Finalizing response",
    "ko": "응답 마무리 중"
  },
  "ui.no.command.details": {
    "en": "No command details",
    "ko": "명령 상세 없음"
  },
  "ui.checking.command.failure": {
    "en": "Checking command failure",
    "ko": "명령 실패 확인 중"
  },
  "ui.analyzing.results": {
    "en": "Analyzing results",
    "ko": "결과 분석 중"
  },
  "ui.running.command": {
    "en": "Running command",
    "ko": "명령 실행 중"
  },
  "ui.checking.response.record": {
    "en": "Checking response record",
    "ko": "응답 기록 확인 중"
  },
  "ui.recording.response": {
    "en": "Recording response",
    "ko": "응답 기록 중"
  },
  "ui.no.changed.file.details": {
    "en": "No changed file details",
    "ko": "변경된 파일 상세 없음"
  },
  "ui.checking.git.changes": {
    "en": "Checking Git changes",
    "ko": "Git 변경 사항 확인 중"
  },
  "ui.applying.git.changes": {
    "en": "Applying Git changes",
    "ko": "Git 변경 사항 적용 중"
  },
  "ui.no.tool.details": {
    "en": "No tool details",
    "ko": "도구 상세 없음"
  },
  "ui.checking.connected.tool.failure": {
    "en": "Checking connected tool failure",
    "ko": "연결된 도구 실패 확인 중"
  },
  "ui.web.search": { "en": "Web search", "ko": "웹 검색" },
  "ui.web.page.open": { "en": "Open webpage", "ko": "웹페이지 열기" },
  "ui.web.page.opening": { "en": "Opening webpage", "ko": "웹페이지 여는 중" },
  "ui.web.page.open.failed": { "en": "Failed to open webpage", "ko": "웹페이지 열기 실패" },
  "ui.searching.the.web": { "en": "Searching the web", "ko": "웹 검색 중" },
  "ui.web.search.failed": { "en": "Web search failed", "ko": "웹 검색 실패" },
  "ui.running.connected.tool": {
    "en": "Running connected tool",
    "ko": "연결된 도구 실행 중"
  },
  "ui.invalid.native.goal.state": {
    "en": "Invalid native Goal state.",
    "ko": "기본 목표 상태가 유효하지 않습니다."
  },
  "ui.read.skill.0": {
    "en": "Read Skill · {0}",
    "ko": "스킬 읽기 · {0}"
  },
  "ui.read.run.request": {
    "en": "Read run request",
    "ko": "실행 요청 읽기"
  },
  "ui.read.run.result": {
    "en": "Read run result",
    "ko": "실행 결과 읽기"
  },
  "ui.agent.factory.runtime.output.exceeded.the.size.limit": {
    "en": "Agent Factory runtime output exceeded the size limit.",
    "ko": "Agent Factory 런타임 출력이 크기 한도를 초과했습니다."
  },
  "ui.unable.to.start.the.agent.factory.runtime.process.0": {
    "en": "Unable to start the Agent Factory runtime process: {0}",
    "ko": "Agent Factory 런타임 프로세스를 시작할 수 없습니다: {0}"
  },
  "ui.the.agent.factory.runtime.command.timed.out": {
    "en": "The Agent Factory runtime command timed out.",
    "ko": "Agent Factory 런타임 명령 시간이 초과되었습니다."
  },
  "ui.the.agent.factory.runtime.did.not.return.a.valid.run.acceptance.response": {
    "en": "The Agent Factory runtime did not return a valid run acceptance response.",
    "ko": "Agent Factory 런타임이 유효한 실행 접수 응답을 반환하지 않았습니다."
  },
  "ui.invalid.agent.factory.runtime.execution.status": {
    "en": "Invalid Agent Factory runtime execution status.",
    "ko": "Agent Factory 런타임 실행 상태가 유효하지 않습니다."
  },
  "ui.invalid.agent.factory.0.format": {
    "en": "Invalid Agent Factory {0} format.",
    "ko": "Agent Factory {0} 형식이 유효하지 않습니다."
  },
  "ui.unsafe.link.or.file.type.in.an.agent.factory.managed.path": {
    "en": "Unsafe link or file type in an Agent Factory managed path.",
    "ko": "Agent Factory 관리 경로에 안전하지 않은 링크 또는 파일 유형이 있습니다."
  },
  "ui.unsafe.agent.factory.file.path.or.size": {
    "en": "Unsafe Agent Factory file path or size.",
    "ko": "Agent Factory 파일 경로 또는 크기가 안전하지 않습니다."
  },
  "ui.the.agent.factory.file.was.replaced.while.being.read": {
    "en": "The Agent Factory file was replaced while being read.",
    "ko": "Agent Factory 파일을 읽는 동안 교체되었습니다."
  },
  "status.agents": {
    "en": "Work {0} · Verification {1}",
    "ko": "작업 {0} · 검증 {1}"
  },
  "status.runningAgents": {
    "en": "Work {0} · Verification {1} in progress",
    "ko": "작업 {0} · 검증 {1} 진행 중"
  },
  "status.activeCount": {
    "en": "{0} active",
    "ko": "{0}개 실행 중"
  },
  "status.calledCount": {
    "en": "{0} called",
    "ko": "{0}개 호출됨"
  },
  "queue.count": {
    "en": "Queued {0}",
    "ko": "대기 {0}"
  },
  "queue.items": {
    "en": "Queued messages {0} items",
    "ko": "대기 메시지 {0}개"
  },
  "queue.expand": {
    "en": "Queued messages {0} items · Expand/collapse list",
    "ko": "대기 메시지 {0}개 · 목록 펼치기/접기"
  },
  "toolbar.questions": {
    "en": "User questions ({0})",
    "ko": "사용자 질문 ({0})"
  },
  "submission.send": {
    "en": "Send draft: {0}",
    "ko": "작성한 메시지 전송: {0}"
  },
  "attachment.open": {
    "en": "{0} · Open original",
    "ko": "{0} · 원본 열기"
  },
  "attachment.remove": {
    "en": "{0} · Remove attachment",
    "ko": "{0} · 첨부 제거"
  },
  "diff.more": {
    "en": "… {0} more lines",
    "ko": "… {0}줄 더 보기"
  },
  "goal.summary": {
    "en": "{0} · {1} tokens · {2}\n{3}",
    "ko": "{0} · {1} 토큰 · {2}\n{3}"
  },
  "duration.seconds": {
    "en": "{0}s",
    "ko": "{0}초"
  },
  "duration.minutes": {
    "en": "{0}m {1}s",
    "ko": "{0}분 {1}초"
  },
  "duration.hours": {
    "en": "{0}h {1}m {2}s",
    "ko": "{0}시간 {1}분 {2}초"
  },
  "activity.skill.read": {
    "en": "Read Skill · {0}",
    "ko": "스킬 읽기 · {0}"
  },
  "activity.skill.reading": {
    "en": "Reading Skill · {0}",
    "ko": "스킬 읽는 중 · {0}"
  },
  "activity.result.read": {
    "en": "Read run result",
    "ko": "실행 결과 읽기"
  },
  "activity.result.reading": {
    "en": "Reading run result",
    "ko": "실행 결과 읽는 중"
  },
  "activity.command.completed": {
    "en": "Command completed",
    "ko": "명령 완료"
  },
  "reference.work.agent": {
    "en": "Work Agent",
    "ko": "작업 에이전트"
  },
  "reference.work.run": {
    "en": "Work Run",
    "ko": "작업 실행"
  },
  "reference.work.session": {
    "en": "Work Session",
    "ko": "작업 세션"
  },
  "reference.loop": {
    "en": "Loop",
    "ko": "반복 실행"
  },
  "diff.files": {
    "en": "{0} files",
    "ko": "파일 {0}개"
  },
  "image.unavailable": {
    "en": "{0} (Unable to load image)",
    "ko": "{0} (이미지를 불러올 수 없습니다)"
  },
  "image.default": {
    "en": "Image",
    "ko": "이미지"
  },
  "host.workspace.required": {
    "en": "Open a VS Code workspace to run Main Agent.",
    "ko": "메인 에이전트를 실행하려면 VS Code 작업 공간을 여세요."
  },
  "host.setting.model": {
    "en": "model changes",
    "ko": "모델 변경"
  },
  "host.setting.reasoning": {
    "en": "reasoning effort",
    "ko": "추론 수준"
  },
  "message.lines.2": {
    "en": "{0}\n{1}",
    "ko": "{0}\n{1}"
  },
  "message.lines.3": {
    "en": "{0}\n{1}\n{2}",
    "ko": "{0}\n{1}\n{2}"
  },
  "message.lines.4": {
    "en": "{0}\n{1}\n{2}\n{3}",
    "ko": "{0}\n{1}\n{2}\n{3}"
  }
};
  function locale(selection, host) {
    return selection === "ko" || selection === "en" ? selection : /^ko(?:-|$)/i.test(host || "") ? "ko" : "en";
  }
  const renderedMessages = new Map();
  function describe(value) { return renderedMessages.get(value); }
  function format(key, language, ...values) {
    const message = messages[key];
    const template = message?.[locale(language)] || message?.en || key;
    const text = template.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? (typeof values[index] === "object" ? resolve(values[index], language, "") : String(values[index])) : match);
    renderedMessages.set(text, { key, values });
    if (renderedMessages.size > 2048) renderedMessages.delete(renderedMessages.keys().next().value);
    return text;
  }
  // Only explicitly marked template nodes are translated. Never walk message content.
  function apply(container, language) {
    for (const element of container.querySelectorAll("[data-i18n]")) {
      element.textContent = format(element.dataset.i18n, language);
    }
    for (const attribute of ["title", "aria-label", "aria-description", "placeholder"]) {
      for (const element of container.querySelectorAll("[data-i18n-" + attribute + "]")) {
        element.setAttribute(attribute, format(element.getAttribute("data-i18n-" + attribute), language));
      }
    }
  }
  function validDescriptor(descriptor, depth = 0) {
    return depth < 8 && descriptor && typeof descriptor.key === "string" && Object.hasOwn(messages, descriptor.key) &&
      Array.isArray(descriptor.values) && descriptor.values.length <= 100 && descriptor.values.every(value =>
        ["string", "number", "boolean"].includes(typeof value) || validDescriptor(value, depth + 1));
  }
  function resolve(descriptor, language, fallback) {
    return validDescriptor(descriptor) ? format(descriptor.key, language, ...descriptor.values) : fallback;
  }
  return { messages, locale, format, apply, describe, resolve };
});
