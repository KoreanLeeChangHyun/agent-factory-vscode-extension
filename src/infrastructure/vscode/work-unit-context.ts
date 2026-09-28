/** Strip runtime envelopes before carrying conversation text into a new chat. */
export function workUnitContextText(source: string): string {
  let text = source;
  try {
    const result = JSON.parse(text);
    if (typeof result.resultText === "string") text = result.resultText;
  } catch { /* Ordinary conversation text. */ }
  const request = text.match(/<agent-factory-request>([\s\S]*?)<\/agent-factory-request>/);
  if (request) text = request[1]!;
  else if (text.startsWith("These are the current Agent Factory fixed instructions.")) return "";
  text = text.split("[Agent Factory administrator command handoff]")[0]!;
  return text.replace(/<agent-factory-(?:role-prompt|communication-contract)>[\s\S]*?<\/agent-factory-(?:role-prompt|communication-contract)>/g, "").trim();
}

export function workUnitBranch(name: string): string {
  return name.trim().normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "work";
}
