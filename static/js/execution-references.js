(function () {
  "use strict";

  function extract(text, markdown) {
    const unchanged = { text, references: [] };
    if (!markdown || typeof text !== "string" || !text.includes("실행 식별자")) return unchanged;
    const tokens = markdown.parse(text, {});
    const lines = text.split("\n");
    const candidates = [];
    for (let index = 0; index < tokens.length - 3; index += 1) {
      const heading = tokens[index];
      if (heading.type !== "paragraph_open" || heading.level !== 0 || !heading.map) continue;
      const inline = tokens[index + 1];
      if (inline.type !== "inline" || !/^실행 식별자[:：]$/.test(inline.content)) continue;
      const list = tokens[index + 3];
      if (tokens[index + 2].type !== "paragraph_close" || list.type !== "bullet_list_open" || list.level !== 0 || !list.map) continue;
      if (lines.slice(heading.map[1], list.map[0]).some(line => line.trim())) continue;
      const references = [];
      const seen = new Set();
      const rows = lines.slice(list.map[0], list.map[1]);
      while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
      for (const row of rows) {
        const match = /^[-*+] (Work Agent|Work Run|Work Session|예약된 Verification Agent|Loop)[:：]\s+(?:`([A-Za-z0-9][A-Za-z0-9._-]{0,127})`|([A-Za-z0-9][A-Za-z0-9._-]{0,127}))\s*$/.exec(row);
        if (!match || seen.has(match[1])) return unchanged;
        seen.add(match[1]);
        references.push({ label: match[1], id: match[2] || match[3] });
      }
      if (!references.length) return unchanged;
      candidates.push({ start: heading.map[0], end: list.map[1], references });
    }
    if (candidates.length !== 1) return unchanged;
    const block = candidates[0];
    const before = lines.slice(0, block.start).join("\n");
    const after = lines.slice(block.end).join("\n");
    return {
      text: [before, after].filter(Boolean).join("\n"),
      before,
      after,
      references: block.references
    };
  }

  globalThis.agentFactoryExecutionReferences = Object.freeze({ extract });
})();
