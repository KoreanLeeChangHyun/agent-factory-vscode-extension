/** Only identities present in a runtime snapshot bound to this contract may be opened. */
export function contractAgentIds(contractId: string, snapshots: readonly Record<string, unknown>[]): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) ids.add(value); };
  for (const snapshot of snapshots) {
    const contract = snapshot.contract as {id?: string} | undefined;
    if (contract?.id !== contractId) continue;
    add(snapshot.parentAgentId);
    const workflow = snapshot.workflow as {tasks?: Record<string, unknown>[]} | undefined;
    for (const task of workflow?.tasks ?? []) { add(task.workAgentId); add(task.verificationAgentId); }
  }
  return ids;
}
