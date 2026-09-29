// Pi's leaf ID advances as messages are added. It is not a stable branch ID.
export function isBranchSwitch(previous, next) {
  if (previous.sessionId == null) return false;
  if (previous.sessionId !== next.sessionId) return true;
  if (previous.branchId === next.branchId) return false;
  const before = previous.entries, after = next.entries;
  // An appended entry means the active branch simply advanced. A shorter or
  // divergent history means Pi navigated to another point in the tree.
  return after.length <= before.length || before.some((entry, i) => entry?.id == null || entry.id !== after[i]?.id);
}
