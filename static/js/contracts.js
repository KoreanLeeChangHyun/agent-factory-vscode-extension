(() => {
  const api = acquireVsCodeApi();
  const md = window.markdownit({ html: false, linkify: false });
  // Keep contract content inert; file navigation is separate from document rendering.
  md.renderer.rules.link_open = () => '<span class="document-link">';
  md.renderer.rules.link_close = () => '</span>';
  md.renderer.rules.image = (tokens, i) => md.utils.escapeHtml(tokens[i].content || '[이미지]');
  const app = document.getElementById('contract-app');
  let data, workflowError, workflows = [], version, runId, tab = '계약서';
  let diagramQueue = Promise.resolve(), diagramSequence = 0;
  const recordMarker = '<!-- contract-execution-record -->';
  const contractText = value => String(value || '').split(recordMarker, 1)[0].trim();
  const executionText = value => {
    const text = String(value || '');
    const index = text.indexOf(recordMarker);
    return index < 0 ? '' : text.slice(index + recordMarker.length).trim();
  };
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, action) => { const n = el('button', text); n.type = 'button'; n.onclick = action; return n; };
  const markdown = text => {
    const n = el('article', undefined, 'markdown');
    n.innerHTML = md.render(text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
    for (const table of n.querySelectorAll('table')) {
      const wrapper = el('div', undefined, 'table-scroll');
      wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', '계약 표');
      table.before(wrapper); wrapper.append(table);
      for (const [index, cell] of Array.from(table.querySelectorAll('thead th')).entries()) {
        if (/^(ID|작업 ID|Task ID)$/i.test(cell.textContent.trim())) {
          for (const row of table.rows) row.cells[index]?.classList.add('identifier-cell');
        }
      }
    }
    for (const code of n.querySelectorAll('pre > code.language-mermaid')) {
      const source = code.textContent;
      diagramQueue = diagramQueue.then(async () => {
        if (!globalThis.mermaid || !code.isConnected) return;
        const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
        mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme:light ? 'default' : 'dark', htmlLabels:false, flowchart:{htmlLabels:false}});
        const {svg} = await mermaid.render('contract-diagram-' + ++diagramSequence, source);
        const element = new DOMParser().parseFromString(svg,'image/svg+xml').documentElement;
        if (element.localName !== 'svg' || !code.isConnected) return;
        const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(element));
        let binary = '';
        for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index,index + 8192));
        const image = el('img'); image.alt = source; image.src = 'data:image/svg+xml;base64,' + btoa(binary);
        const figure = el('figure',undefined,'task-diagram'); figure.append(image); code.parentElement.replaceWith(figure);
      }).catch(() => { /* Keep the source diagram readable when rendering fails. */ });
    }
    return n;
  };
  const status = value => ({pending:'대기',running:'진행 중',completed:'완료',failed:'실패',cancelled:'취소',blocked:'중단', 'needs-human-decision':'사용자 결정 대기',skipped:'검증 생략'}[value] || value || '미확인');
  function choose(label, items, selected, changed) {
    const opener = document.activeElement;
    const dialog = el('dialog', undefined, 'version-dialog');
    dialog.setAttribute('aria-label', label + ' 선택');
    dialog.append(el('h2', label + ' 선택'));
    for (const item of items) {
      const row = button('', () => { dialog.close(); changed(item.value); });
      row.className = 'version-option';
      row.setAttribute('aria-pressed', String(item.value === selected));
      row.append(el('strong', item.title + (item.value === selected ? ' · 선택됨' : '')));
      if (item.description) row.append(el('span',item.description));
      if (item.detail) row.append(el('small',item.detail,'muted'));
      dialog.append(row);
    }
    dialog.append(button('닫기',()=>dialog.close()));
    dialog.addEventListener('close',()=>{dialog.remove(); if (opener?.isConnected) opener.focus();});
    dialog.addEventListener('keydown',event=>{
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      const rows = [...dialog.querySelectorAll('.version-option')];
      if (!rows.length) return;
      event.preventDefault();
      const index = rows.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length-1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next].focus();
    });
    app.append(dialog); dialog.showModal();
    dialog.querySelector('[aria-pressed="true"]')?.focus();
  }
  function select(label, values, selected, changed) {
    const wrap = el('span', undefined, 'selection-control');
    const title = value => values.find(item=>item[0] === value)?.[1] || value;
    const trigger = button(title(selected) + ' ▾', () => choose(label, values.map(([value,text])=>({value,title:text})), selected, value=>{
      selected=value; trigger.textContent=title(value)+' ▾'; changed(value);
    }));
    trigger.setAttribute('aria-haspopup','dialog');
    trigger.setAttribute('aria-label',label+' 선택');
    wrap.append(el('span',label),trigger); return wrap;
  }
  function contractOf(flow) { return flow.contract || flow.workflow?.contract; }
  function boundFlows() { return workflows.filter(f => contractOf(f)?.id === data.id); }
  function render() {
    if (!data) return;
    const focused = document.activeElement?.dataset.focus;
    const current = data.versions.find(v => v.version === version) || data.versions[0]; version = current.version;
    const flows = boundFlows();
    const flow = flows.find(f => f.loopId === runId) || flows[0]; runId = flow?.loopId;
    const header = el('header');
    const identity = el('div', undefined, 'contract-identity');
    const heading = el('h1', current.title); heading.title = current.title;
    const identifier = el('span', data.id, 'contract-id muted'); identifier.title = data.id;
    const summary = el('span', flow ? status(flow.status) : '연결된 실행 없음', 'header-status muted');
    summary.title = `조회 시각: ${data.observedAt} · 실행 상태: ${summary.textContent}`;
    summary.setAttribute('aria-label', summary.title);
    identity.append(heading, identifier, summary); header.append(identity);
    const controls = el('div', undefined, 'controls');
    controls.append(button('v' + version + ' ▾', openVersions), button('새로고침', () => api.postMessage({type:'refresh'})));
    if (flows.length) controls.append(select('실행', flows.map(f => [f.loopId, `${f.loopId} · v${contractOf(f)?.version ?? '?'} 기준`]), runId, id => {runId = id; render();}));
    if (flow && String(contractOf(flow)?.version) !== version) header.append(el('p', `보고 있는 계약은 v${version}, 선택 실행은 v${contractOf(flow)?.version} 기준입니다.`, 'notice'));
    if (workflowError) header.append(el('p','실행 상태 갱신 실패: ' + workflowError, 'notice'));
    const nav = el('nav'); nav.setAttribute('aria-label','계약 상세');
    for (const name of ['계약서','실행 기록','변경 이력']) { const b = button(name, () => {tab = name; render();}); b.setAttribute('aria-pressed', String(tab === name)); b.dataset.focus = name; nav.append(b); }
    const toolbar = el('div', undefined, 'contract-toolbar');
    toolbar.append(nav, controls);
    header.append(toolbar);
    const content = el('section');
    content.tabIndex = 0; content.setAttribute('aria-label', '계약 본문');
    if (tab === '계약서') {
      content.append(markdown(contractText(current.content)));
      // New contracts carry their own file-structure section; keep historical CSV-only contracts readable.
      if (current.operations?.length && !/^#{2,4}\s*(?:5[.)]\s*)?파일 구조\s*$/m.test(contractText(current.content))) {
        content.append(el('h2','파일 구조','file-plan-heading')); renderFiles(content, current);
      }
    } else if (tab === '실행 기록') {
      renderProgress(content, flow);
      renderAgents(content, flow);
      const bound = data.versions.find(v => String(v.version) === String(contractOf(flow)?.version)) || current;
      const saved = executionText(bound.content);
      if (saved) { content.append(el('h2',`계약서 v${bound.version}에 저장된 실행 기록`), markdown(saved)); }
      else if (data.progress) { content.append(el('h2','기존 진행 기록'), markdown(data.progress)); }
    } else renderHistory(content, current);
    app.replaceChildren(header, content);
    if (focused) app.querySelector(`[data-focus="${focused}"]`)?.focus();
  }
  function openVersions() {
    choose('계약 버전',data.versions.map(v=>({value:v.version,title:'v'+v.version,description:v.title,detail:'파일 수정: '+v.modifiedAt})),version,v=>{version=v;render();});
  }
  function renderComparison(content, current) {
    if (data.versions.length < 2) {content.append(el('p','비교할 이전 버전이 없습니다.')); return;}
    let other = data.versions.find(v => v.version !== version);
    const output = el('div');
    const draw = () => {
      const before = new Set(contractText(other.content).split('\n')), after = new Set(contractText(current.content).split('\n'));
      const columns = el('div', undefined, 'columns');
      for (const [v, opposite, label, cls] of [[other,after,'비교 기준','removed'],[current,before,'선택 버전','added']]) {
        const box = el('div'); box.append(el('h2', `${label} v${v.version}`));
        const pre = el('pre');
        for (const line of contractText(v.content).split('\n')) { const n = el('div', (opposite.has(line) ? '  ' : cls === 'added' ? '+ ' : '− ') + line, opposite.has(line) ? '' : cls); pre.append(n); }
        box.append(pre); columns.append(box);
      }
      output.replaceChildren(columns);
    };
    content.append(el('p','줄 내용 기준 비교입니다. 추가·삭제된 내용을 강조하며 줄 이동은 별도로 판정하지 않습니다.', 'muted'), select('비교 기준', data.versions.filter(v => v.version !== version).map(v => [v.version, 'v'+v.version]), other.version, v => {other = data.versions.find(x => x.version === v); draw();}), output); draw();
  }
  function fileOperation(value) {
    const key = String(value || '').trim().toLowerCase();
    if (['add','create','new','생성','추가'].includes(key)) return ['add','+','생성'];
    if (['modify','update','edit','수정'].includes(key)) return ['modify','+/-','수정'];
    if (['delete','remove','삭제'].includes(key)) return ['delete','-','삭제'];
    if (['move','rename','이동','이름 변경'].includes(key)) return ['rename','→','이동·이름 변경'];
    return ['unknown','?',value || '미기재'];
  }
  function renderFiles(content, current) {
    const rows = current.operations;
    if (!rows.length) {content.append(el('p','이 버전의 파일 작업 목록이 없습니다. 계약 본문을 확인해 주세요.')); return;}
    const wrap=el('div',undefined,'table-scroll file-plan');
    wrap.tabIndex=0; wrap.setAttribute('role','region'); wrap.setAttribute('aria-label','파일 구조와 작업 목표');
    const table=el('table'), head=el('thead'), headings=el('tr'), body=el('tbody');
    for (const title of ['파일 구조','변경','작업 ID','파일별 목표']) { const cell=el('th',title); cell.scope='col'; headings.append(cell); }
    head.append(headings);
    const root = {folders:new Map(), entries:[]};
    for (const row of rows) {
      const path = row.path || row.source || row.destination || row.target || '';
      const parts = path.split('/').filter(Boolean); let parent = root;
      for (const part of parts.slice(0,-1)) {
        if (!parent.folders.has(part)) { const folder={name:part,folders:new Map(),entries:[]}; parent.folders.set(part,folder); parent.entries.push(folder); }
        parent = parent.folders.get(part);
      }
      parent.entries.push({row,path,name:parts.at(-1) || '(경로 미지정)'});
    }
    const draw = (node,depth) => {
      for (const entry of node.entries) {
        if (entry.folders) {
          const cell=el('th',entry.name+'/', 'folder-name'); cell.colSpan=4; cell.scope='rowgroup'; cell.style.paddingLeft=(8 + depth*14)+'px';
          const tr=el('tr',undefined,'file-folder'); tr.append(cell); body.append(tr); draw(entry,depth+1);
          continue;
        }
        const {row,path,name}=entry;
        const target=row.destination && row.destination !== '미기재' ? row.destination : row.target;
        const [kind,code,label]=fileOperation(row.operation);
        const file=el('th',target && target !== path ? `${name} → ${target}` : name);
        file.scope='row'; file.title=path; file.style.paddingLeft=(8 + depth*14)+'px';
        const operation=el('td',`${code} ${label}`,'op-'+kind);
        const taskIds=row.taskIds || row.task_ids || row.taskId || row.task_id || '—';
        const goal=row.purpose || row.goal || row.description || '—';
        const tr=el('tr',undefined,'file-row'); tr.append(file,operation,el('td',taskIds),el('td',goal)); body.append(tr);
      }
    };
    draw(root,0);
    table.append(head,body); wrap.append(table); content.append(wrap);
  }
  function renderProgress(content, flow) {
    content.append(el('p','선택한 실행에서 마지막으로 수신한 작업별 상태입니다. 새로고침으로 갱신하며, 저장된 결과는 아래 계약서 실행 기록에서 확인합니다.', 'muted'));
    if (!flow) { content.append(el('p','이 계약에 연결된 실행 기록이 없습니다. 작업 상태를 추정하지 않습니다.')); return; }
    content.append(el('p',`${flow.loopId} · ${status(flow.status)} · 기록 시각: ${flow.updatedAt || '미확인'}`, 'muted'));
    const tasks = flow.workflow?.tasks || flow.tasks || [];
    if (!tasks.length) { content.append(el('p','수신된 작업 목록이 없습니다.')); return; }
    const wrap = el('div',undefined,'table-scroll execution-table');
    wrap.tabIndex=0; wrap.setAttribute('role','region'); wrap.setAttribute('aria-label','작업별 실행 현황');
    const table=el('table'), head=el('thead'), headings=el('tr'), body=el('tbody');
    for (const name of ['작업','작업 상태','검증 상태','완료 기준','실행 근거']) {
      const cell=el('th',name); cell.scope='col'; headings.append(cell);
    }
    head.append(headings);
    for (const task of tasks) {
      const row=el('tr'), name=el('td');
      name.append(el('strong',`${task.id} · ${task.title || '작업'}`));
      name.append(el('p',`작업자: ${task.workAgentId || '미배정'}`, 'muted'),el('p',`검증자: ${task.verificationAgentId || '미배정'}`, 'muted'));
      const noVerify=['work','plan-work','direct'].includes(flow.taskMode);
      const verification=noVerify ? '별도 검증 미요청' : flow.humanSkip && task.verificationStatus !== 'completed' ? '검증 생략' : status(task.verificationStatus);
      const evidence=el('td');
      if (task.workRunId) evidence.append(el('p','작업: '+task.workRunId));
      if (task.verificationRunId) evidence.append(el('p','검증: '+task.verificationRunId));
      if (!task.workRunId && !task.verificationRunId) evidence.append(el('span','실행 기록 없음'));
      row.append(name,el('td',status(task.workStatus)),el('td',verification),el('td',task.completionCriteria || '미기재'),evidence); body.append(row);
    }
    table.append(head,body); wrap.append(table); content.append(wrap);
  }
  function renderAgents(content, flow) {
    if (!flow) {
      content.append(el('p','이 계약에 연결된 실행 기록이 없어 요청 Main·작업자·검증자를 확인할 수 없습니다.'));
      return;
    }
    content.append(el('p', `선택 실행: ${flow.loopId} · 계약 v${contractOf(flow)?.version ?? '?'} 기준`, 'muted'));
    const card = (label, id, run, state) => {
      const box = el('article', undefined, 'agent-card');
      box.append(el('h3',label));
      if (id) { box.append(el('code',id),button('대화 열기',()=>api.postMessage({type:'agent.open',agentId:id}))); }
      else box.append(el('p','연결 정보 없음', 'muted'));
      if (run) box.append(el('p','실행: '+run,'muted'));
      if (state) box.append(el('p',state));
      return box;
    };
    content.append(card('요청한 Main', flow.parentAgentId, flow.parentRunId));
    for (const task of flow.workflow?.tasks || []) {
      const group = el('section', undefined, 'agent-task');
      group.append(el('h2', `${task.id} · ${task.title || ''}`));
      const chain = el('div', undefined, 'agent-chain');
      const noVerify = ['work','plan-work','direct'].includes(flow.taskMode);
      chain.append(card('작업자',task.workAgentId,task.workRunId,status(task.workStatus)),el('span','→','agent-arrow'),card('검증자',task.verificationAgentId,task.verificationRunId,noVerify ? '별도 검증 미요청' : flow.humanSkip && task.verificationStatus !== 'completed' ? '검증 생략' : status(task.verificationStatus)));
      group.append(chain); content.append(group);
    }
    content.append(el('p','대화 열기는 기존 에이전트 화면으로 이동합니다. 새 작업을 제출하거나 실행을 재시작하지 않습니다.', 'muted'));
  }
  function renderHistory(content, current) {
    content.append(el('p','계약 버전의 변경 이력입니다. 실행·검증 결과는 실행 기록에서 확인합니다. 파일 수정 시각은 승인 시각이 아닙니다.', 'notice'));
    renderComparison(content, current);
    const list = el('ol');
    for (const v of data.versions) {const item = el('li'); item.append(button(`계약 v${v.version} · 파일 수정 ${v.modifiedAt}`, () => {version=v.version;tab='계약서';render();}));list.append(item);}
    content.append(list);
  }
  window.addEventListener('message', ({data: message}) => {
    if (message.type === 'detail') {data = message.data; workflows = message.workflows || []; workflowError = message.workflowError; render();}
    if (message.type === 'error') {const warning=el('p','갱신 실패: ' + message.message + ' · 기존 표시는 마지막 조회 결과입니다.','notice');warning.setAttribute('role','alert');app.prepend(warning);}
  });
  app.append(el('p','계약을 불러오는 중입니다…')); api.postMessage({type:'ready'});
})();
