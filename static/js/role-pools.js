(function () {
  "use strict";
  const profiles = ["workLight", "work", "verification"];
  globalThis.AgentFactoryRolePools = function ({ container, vscode, language }) {
    let projection, cursor = -1, version = -1, selectedChat, noticeText = "";
    const drafts = new Map(), commands = new Set(), outcomes = new Map();
    const ko = language.startsWith("ko");
    const label = (k, e) => ko ? k : e;
    const names = { workLight: label("작업자", "Worker"), work: label("전문가", "Expert"), verification: label("검증자", "Verifier"), explore: label("탐색자", "Explorer"), scribe: label("기록자", "Scribe") };
    const stages = { "not-requested": label("독립 검증 미요청", "Independent verification not requested"), "waiting-assignment": label("검증자 배정 대기", "Waiting for verifier"), "waiting-result": label("작업 결과 대기", "Waiting for Work result"), verifying: label("검증 중", "Verifying"), "revision-waiting": label("수정·재검증 대기", "Waiting for revision / verification"), pass: label("검증 통과", "Verification passed"), "skipped-by-human": label("사용자 결정으로 생략", "Skipped by Human decision") };
    function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
    function select(title, values, value) {
      const wrap = el("label", title), node = el("select");
      node.setAttribute("aria-label", title);
      for (const [id, text] of values) { const option = el("option", text); option.value = id; node.append(option); }
      node.value = value; wrap.append(node); return [wrap, node];
    }
    function remember(node, key) { node.dataset.poolField = key; if (drafts.has(key)) node.value = drafts.get(key); node.addEventListener("change", () => drafts.set(key, node.value)); }
    function send(fields) { const commandId = crypto.randomUUID(); commands.add(commandId); vscode.postMessage({ type: "role.pool.control", commandId, ...fields }); }
    function render() {
      if (!projection) return;
      const focusKey = document.activeElement?.dataset.poolField;
      const open = new Set([...container.querySelectorAll("details[open]")].map(n => n.dataset.id));
      container.replaceChildren(); container.hidden = false;
      container.append(el("h2", label("담당 영역과 역할", "Areas and roles")));
      const chats = projection.chats || [];
      const [chatWrap, chatSelect] = select(label("요청 정책", "Request policy"), chats.map(c => [c.id, c.title || c.id]), selectedChat || chats[0]?.id);
      chatSelect.addEventListener("change", () => { selectedChat = chatSelect.value; });
      container.append(chatWrap);
      if (projection.nativeObservation) container.append(el("p", `${label("기존 수행자 관측", "Existing worker observation")}: ${new Date(projection.nativeObservation.at * 1000).toLocaleTimeString()}`));
      const notice = el("p", chats.length ? noticeText : label("지휘자 채팅에서 요청을 먼저 접수해 처리 설정을 연결해 주세요.", "Accept a request in the conductor chat first to connect its processing settings.")); notice.id = "role-pool-notice"; notice.setAttribute("role", "status"); container.append(notice);
      function areaRow(area, parent) {
        const detail = el("details"); detail.dataset.id = area.id; detail.open = open.has(area.id);
        const summary = el("summary", area.name);
        for (const profile of profiles) { const count = area.counts[profile]; summary.append(el("span", `${names[profile]} ${count.hired} · ${label("실행", "active")} ${count.active} / ${label("유휴", "idle")} ${count.idle} / ${label("대기", "waiting")} ${count.waiting || 0}`)); }
        detail.append(summary);
        const [policyWrap, policy] = select(label("새 작업 기본 처리", "New task default"), [["work", label("작업", "Work")], ["work-verification", label("작업 + 독립 검증", "Work + independent verification")]], area.processing.route);
        policy.addEventListener("change", () => send({ action: "configure-area", chatId: chatSelect.value, areaId: area.id, route: policy.value }));
        policy.disabled = !chats.length;
        detail.append(policyWrap, el("p", area.processing.inheritedFrom === area.id ? label("이 영역 설정", "Set for this area") : area.processing.inheritedFrom ? label("상위 도메인에서 상속", "Inherited from domain") : label("기존 기본 처리", "Existing default")));
        const groups = el("div", undefined, "role-pool-groups");
        for (const group of [["workLight", "work", "explore", "scribe"], ["verification"]]) {
          const column = el("section"); column.append(el("h3", group.length === 1 ? names.verification : label("작업 역할", "Work roles")));
          const members = area.members.filter(m => group.includes(m.profile));
          if (!members.length) column.append(el("p", label("고용된 수행자 없음", "No hired members")));
          for (const m of members) {
            const member = el("details"); member.dataset.id = m.id; member.open = open.has(m.id);
            member.append(el("summary", `${names[m.profile]} · ${m.id} · ${m.state}`));
            member.append(el("p", `${label("담당 작업", "Assigned tasks")}: ${m.taskIds.join(", ") || "—"}`));
            if (m.settings) member.append(el("pre", JSON.stringify(m.settings, null, 2)));
            column.append(member);
          }
          groups.append(column);
        }
        detail.append(groups);
        if (!parent && !area.provisional) {
          const form = el("form"), name = el("input"), submit = el("button", label("서브도메인 추가", "Add subdomain"), "maestro-button");
          name.required = true; name.setAttribute("aria-label", label("서브도메인 이름", "Subdomain name")); remember(name, area.id + ":child-name");
          name.addEventListener("input", () => drafts.set(area.id + ":child-name", name.value)); submit.type = "submit"; submit.disabled = !chats.length;
          form.append(name, submit); form.addEventListener("submit", event => { event.preventDefault(); if (name.value.trim()) send({ action: "create-child", chatId: chatSelect.value, areaId: area.id, name: name.value, expectedRevision: projection.catalog.revision }); }); detail.append(form);
        }
        if (parent) {
          const areaValue = { domainId: parent.id, subdomainId: area.id };
          const controls = el("div", undefined, "role-pool-actions");
          const [roleWrap, role] = select(label("고용 역할", "Hire role"), profiles.map(p => [p, names[p]]), "work");
          remember(role, area.id + ":hire-role");
          const hire = el("button", label("수행자 고용 / 재사용", "Hire / reuse member"), "maestro-button"); hire.type = "button"; hire.disabled = !chats.length;
          hire.addEventListener("click", () => send({ action: "hire-role", chatId: chatSelect.value, area: areaValue, profile: role.value }));
          controls.append(roleWrap, hire); detail.append(controls);
          const form = el("form"), request = el("textarea");
          request.dataset.poolField = area.id + ":request"; request.value = drafts.get(request.dataset.poolField) || "";
          request.addEventListener("input", () => drafts.set(request.dataset.poolField, request.value));
          request.required = true; request.setAttribute("aria-label", label("작업 요청", "Task request"));
          const [workWrap, workRole] = select(label("작업 역할", "Work role"), [["workLight", names.workLight], ["work", names.work]], "work");
          const [routeWrap, route] = select(label("이번 요청 처리", "This request route"), [["", label("영역 기본값", "Area default")], ["work", label("작업", "Work")], ["work-verification", label("작업 + 독립 검증", "Work + independent verification")]], "");
          remember(workRole, area.id + ":work-role"); remember(route, area.id + ":route");
          const submit = el("button", label("작업 접수", "Accept task"), "maestro-button"); submit.type = "submit"; submit.disabled = !chats.length;
          form.append(request, workWrap, routeWrap, submit);
          form.addEventListener("submit", event => { event.preventDefault(); if (request.value.trim()) send({ action: "accept-area-task", chatId: chatSelect.value, area: areaValue, profile: workRole.value, text: request.value, ...(route.value ? { route: route.value } : {}) }); });
          detail.append(form);
        }
        return detail;
      }
      for (const domain of projection.areas.filter(a => !a.domainId)) {
        const row = areaRow(domain);
        for (const child of projection.areas.filter(a => a.domainId === domain.id)) row.append(areaRow(child, domain));
        container.append(row);
      }
      const tasks = el("section"); tasks.append(el("h2", label("작업별 구현과 검증", "Implementation and verification by task")));
      for (const task of projection.tasks) {
        const row = el("details"); row.dataset.id = task.id; row.open = open.has(task.id);
        row.append(el("summary", `${task.title} · ${stages[task.verificationState] || task.verificationState}`));
        row.append(el("p", `${label("구현", "Implementation")}: ${task.implementationState} · ${names[task.workProfile] || task.workProfile} · ${task.workAgentId || "—"}`));
        row.append(el("p", `${label("검증", "Verification")}: ${stages[task.verificationState] || task.verificationState} · ${task.verificationAgentId || "—"}`));
        if (task.waitReason) row.append(el("p", `${label("내부 대기", "Internal wait")}: ${task.waitReason}`));
        if (task.binding) row.append(el("pre", JSON.stringify(task.binding, null, 2)));
        for (const question of task.questions || []) {
          row.append(el("p", question.text));
          if (question.reason) row.append(el("p", `${label("이유", "Reason")}: ${question.reason}`));
          if (question.impact) row.append(el("p", `${label("영향", "Impact")}: ${typeof question.impact === "string" ? question.impact : JSON.stringify(question.impact)}`));
          const form = el("form"), answer = el("textarea"), submit = el("button", label("답변", "Answer"), "maestro-button");
          answer.required = true; answer.setAttribute("aria-label", label("질문 답변", "Question answer")); remember(answer, question.id);
          answer.addEventListener("input", () => drafts.set(question.id, answer.value)); submit.type = "submit";
          function respond(text) { vscode.postMessage({ type: "conductor.control", action: "answer-worker", chatId: task.chatId, delegationId: task.id, expectedVersion: task.version, questionId: question.id, text }); }
          for (const choice of Array.isArray(question.alternatives) ? question.alternatives : []) { const text = typeof choice === "string" ? choice : choice?.label; if (!text) continue; const button = el("button", text, "maestro-button"); button.type = "button"; button.addEventListener("click", () => respond(text)); row.append(button); }
          form.append(answer, submit); form.addEventListener("submit", event => { event.preventDefault(); if (answer.value.trim()) respond(answer.value); }); row.append(form);
        }
        tasks.append(row);
      }
      container.append(tasks);
      const responsibility = el("section"); responsibility.append(el("h2", label("필수 후속", "Required follow-ups")));
      for (const request of projection.responsibilities || []) for (const task of request.tasks) {
        const detail = el("details"); detail.dataset.id = task.id; detail.open = open.has(task.id);
        detail.append(el("summary", `${task.title} · ${task.state}`));
        if (task.waitReason) detail.append(el("p", `${task.waitKind}: ${task.waitReason}`));
        if (task.completionEvidence) detail.append(el("pre", JSON.stringify(task.completionEvidence, null, 2)));
        responsibility.append(detail);
      }
      container.append(responsibility);
      if (focusKey) container.querySelector(`[data-pool-field="${CSS.escape(focusKey)}"]`)?.focus();
    }
    function result(value) { const n = container.querySelector("#role-pool-notice"); noticeText = value.error || label("반영되었습니다.", "Applied."); if (n) n.textContent = noticeText; }
    return { receive(message) {
      if (message.type === "conductor.state" && message.enabled === false) { container.hidden = true; return; }
      const rows = message.type === "conductor.snapshot" ? message.snapshot.state || [] : message.type === "conductor.feed" ? message.entries || [] : [];
      for (const row of rows) {
        const payload = row.payload || {};
        if (!commands.has(payload.commandId)) continue;
        if (row.kind === "role-control" || row.key?.startsWith("role-control:")) { outcomes.set(payload.commandId, payload); result(payload); }
        else if (payload.status === "rejected") { const error = { error: payload.code || label("처리가 거부되었습니다.", "Control rejected.") }; outcomes.set(payload.commandId, error); result(error); }
      }
      if (message.type === "role.pool.result") { const n = container.querySelector("#role-pool-notice"); noticeText = message.error || (outcomes.has(message.commandId) ? outcomes.get(message.commandId).error || label("반영되었습니다.", "Applied.") : label("처리 중입니다.", "Processing.")); if (n) n.textContent = noticeText; return; }
      if (message.type === "conductor.snapshot" && message.snapshot.cursor >= cursor) { projection = message.snapshot.rolePools; cursor = message.snapshot.cursor; render(); }
      if (message.type === "conductor.feed") for (const row of message.entries || []) if (row.key === "role-pools" && row.id > cursor && row.version > version) { projection = row.payload; cursor = row.id; version = row.version; render(); }
    } };
  };
})();
