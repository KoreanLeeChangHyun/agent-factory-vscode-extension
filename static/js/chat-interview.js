globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.interview = function (host) {
  "use strict";

  const {
    indexedTimeline, state, submit, renderAll, persist
  } = host;

  function canAnswerInterview(event) {
    if (event.type === "interview") {
      const position = indexedTimeline().positions.get(event.id);
      if (position === undefined || state.timeline.slice(position + 1).some(item => item.type === "user" || item.type === "interview")) return false;
      return !event.choiceAnswer && !state.running && !state.pendingRequests?.length && state.runtimeAvailable;
    }
    return indexedTimeline().latestTurn === event && !event.choiceAnswer && !state.running && !state.pendingRequests?.length && state.runtimeAvailable;
  }

  function renderStructuredInterview(content, event) {
    const question = event.question;
    if (!question || !Array.isArray(question.options)) return;
    const korean = /[가-힣]/.test(question.text + question.options.map(option => option.label + option.pros + option.cons).join(""));
    const heading = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = (korean ? "질문" : "Question") + ` [${question.current}/${question.total}]: ` + question.text;
    heading.append(strong);
    const table = document.createElement("table");
    table.className = "interview-options";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of (korean ? ["선택지", "결정", "장점", "단점"] : ["Option", "Decision", "Advantages", "Disadvantages"])) {
      const cell = document.createElement("th");
      cell.textContent = label;
      headRow.append(cell);
    }
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    for (const [index, option] of question.options.entries()) {
      const row = document.createElement("tr");
      const choice = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "interview-choice";
      button.textContent = question.yesNo ? option.label : String(index + 1);
      button.setAttribute("aria-label", `${index + 1}: ${option.label}`);
      button.disabled = !canAnswerInterview(event);
      button.addEventListener("click", function () {
        if (!canAnswerInterview(event)) return;
        if (submit("direct", "normal", false, option.value)) {
          event.choiceAnswer = option.value;
          renderAll();
          persist();
        }
      });
      choice.append(button);
      row.append(choice);
      for (const value of [option.label, option.pros, option.cons]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    content.append(heading, table);
    const recommended = question.options.find(option => option.value === question.recommendedValue);
    if (recommended) {
      const note = document.createElement("p");
      const label = document.createElement("strong");
      label.textContent = korean ? "권고: " : "Recommendation: ";
      note.append(label, recommended.label);
      content.append(note);
    }
  }

  function renderInterviewChoices(content, event) {
    if (event.phase === "commentary") return;
    for (const table of content.querySelectorAll("table")) {
      // Explanatory paragraphs may separate an explicitly designated question and its table.
      let preceding = table.previousElementSibling;
      let designated = false;
      while (preceding && /^(?:P|H[1-6])$/.test(preceding.tagName)) {
        const heading = preceding.textContent.trim();
        if (/^(?:질문|Question)\s*\[\d+\s*\/\s*\d+(?:\s*,[^\]\n]+)?\]\s*:/i.test(heading)) {
          designated = true;
          break;
        }
        if (/^H[1-6]$/.test(preceding.tagName) || /^(?:권고|이전 결정|Recommendation|Previous decision)\s*:/i.test(heading)) break;
        preceding = preceding.previousElementSibling;
      }
      if (!designated) continue;
      if (!/^(?:선택지?|Option)$/i.test(table.querySelector("th")?.textContent.trim() || "")) continue;
      const rows = Array.from(table.querySelectorAll("tbody tr"));
      if (rows.length < 2 || rows.length > 3 || rows.some((row, index) => row.cells[0]?.textContent.trim() !== String(index + 1))) continue;
      table.classList.add("interview-options");
      const yesNo = rows.length === 2 && rows[0].cells[1]?.textContent.trim() === "Yes" && rows[1].cells[1]?.textContent.trim() === "No";
      for (const row of rows) {
        const number = row.cells[0].textContent.trim();
        const button = document.createElement("button");
        button.type = "button";
        button.className = "interview-choice";
        button.textContent = yesNo ? row.cells[1].textContent.trim() : number;
        button.setAttribute("aria-label", number + ": " + row.cells[1].textContent.trim());
        button.disabled = !canAnswerInterview(event);
        button.addEventListener("click", function () {
          if (!canAnswerInterview(event)) return;
          if (submit("direct", "normal", false, number)) {
            event.choiceAnswer = number;
            renderAll();
            persist();
          }
        });
        row.cells[0].replaceChildren(button);
      }
    }
  }

  return {
    canAnswerInterview, renderStructuredInterview, renderInterviewChoices
  };
};
