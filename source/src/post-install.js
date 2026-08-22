import { canonicalNmsName } from "./completion.js";

function normalized(value) {
  return String(value ?? "").toLowerCase();
}

export function saveSetIdentity(slot) {
  if (!slot) throw new Error("The installed save identity is unavailable.");
  return {
    platform: normalized(slot.platform || slot.adapter),
    directory: normalized(slot.directory),
    profileName: normalized(slot.profileName),
    logicalSlot: Number(slot.logicalSlot),
    storageOrdinal: Number(slot.storageOrdinal),
    saveName: canonicalNmsName(slot.save?.name || slot.save?.originalName || "")
      .toLowerCase(),
  };
}

export function findMatchingSaveSet(slots, identity) {
  if (!identity) return null;
  const candidates = (slots || []).filter((slot) => {
    const candidate = saveSetIdentity(slot);
    return candidate.platform === identity.platform &&
      candidate.directory === identity.directory &&
      candidate.profileName === identity.profileName &&
      candidate.logicalSlot === identity.logicalSlot &&
      candidate.storageOrdinal === identity.storageOrdinal &&
      candidate.saveName === identity.saveName;
  });
  if (candidates.length !== 1) return null;
  return candidates[0];
}

const reloadableRecordRoles = [
  "save",
  "saveMeta",
  "account",
  "accountMeta",
  "platformSettings",
];

export function prepareTargetedReload(slot, changedRoles = reloadableRecordRoles) {
  if (!slot) throw new Error("The installed save is unavailable for verification.");
  const roles = new Set(changedRoles);
  const refreshed = { ...slot };
  delete refreshed._inspection;
  // Older discovery builds nested the other physical save point here. Keeping
  // that object would also keep its decoded bytes and inspection cache alive,
  // and could make post-install verification inspect stale in-memory data.
  delete refreshed.alternateSnapshots;
  delete refreshed.snapshotCount;

  for (const role of reloadableRecordRoles) {
    const record = slot[role];
    if (!record || !roles.has(role)) continue;
    refreshed[role] = {
      ...record,
      size: 0,
      lastModified: Date.now(),
    };
    delete refreshed[role].bytes;
  }

  return refreshed;
}

export function completionReloadDifferences(expectedAnalysis, actualAnalysis) {
  const expected = expectedAnalysis?.missing || {};
  const actual = actualAnalysis?.missing || {};
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const differences = [];
  for (const key of [...keys].sort()) {
    const expectedCount = Number(expected[key] || 0);
    const actualCount = Number(actual[key] || 0);
    if (expectedCount !== actualCount) {
      differences.push({ key, expected: expectedCount, actual: actualCount });
    }
  }
  return differences;
}

export function assertCompletionReloaded(expectedAnalysis, actualAnalysis) {
  const differences = completionReloadDifferences(expectedAnalysis, actualAnalysis);
  if (!differences.length) return true;
  const summary = differences
    .slice(0, 6)
    .map(({ key, expected, actual }) => `${key}: expected ${expected}, reopened ${actual}`)
    .join("; ");
  throw new Error(
    `Files were written, but the installed save did not pass the completion reload check (${summary}). ` +
    "The automatic backup is still available in Recovery.",
  );
}
