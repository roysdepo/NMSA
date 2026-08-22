const HISTORY_KEY = "atlas-complete-history-v2";
const MAX_HISTORY = 30;

export function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(value) ? value.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

export function addHistory(entry) {
  const safeEntry = {
    id: String(entry.id || crypto.randomUUID()),
    generatedAt: String(entry.generatedAt || new Date().toISOString()),
    action: String(entry.action || "completion"),
    platform: String(entry.platform || "unknown"),
    slot: Number(entry.slot || 0),
    context: String(entry.context || "unknown"),
    additions: Number(entry.additions || 0),
    healthBefore: Number(entry.healthBefore || 0),
    healthAfter: Number(entry.healthAfter || 0),
    installed: Boolean(entry.installed),
    backupId: entry.backupId ? String(entry.backupId) : null,
  };
  const history = [safeEntry, ...loadHistory().filter((item) => item.id !== safeEntry.id)]
    .slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  return history;
}

export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

export function createSafeDiagnostic(loaded, master) {
  const analysis = loaded.analysis;
  return {
    generatedAt: new Date().toISOString(),
    tool: "NMSA — No Man's Sky Atlas",
    toolVersion: master.toolVersion,
    dataPackage: master.activePackage,
    baseline: master.gameBaseline,
    platform: loaded.compatibility.platform,
    platformLabel: loaded.compatibility.platformLabel,
    logicalSlot: loaded.selectedSlot.logicalSlot,
    storageOrdinal: loaded.selectedSlot.storageOrdinal,
    context: {
      type: loaded.context.type,
      activeTag: loaded.context.activeTag,
      seasonNumber: loaded.context.seasonNumber,
      availableTypes: loaded.context.available.map((item) => item.type),
    },
    compatibility: {
      status: loaded.compatibility.status,
      saveFormat: loaded.compatibility.saveFormat,
      accountFormat: loaded.compatibility.accountFormat,
      gameVersion: loaded.compatibility.gameVersion,
      accountVersion: loaded.compatibility.accountVersion,
      newerThanData: loaded.compatibility.newerThanData,
      olderThanWritableBaseline: loaded.compatibility.olderThanWritableBaseline,
      reasons: loaded.compatibility.reasons,
    },
    health: analysis.health,
    missingCounts: analysis.missing,
    integrity: analysis.integrity,
    validation: loaded.validation,
    privacy: {
      saveNameIncluded: false,
      usernamesIncluded: false,
      userIdsIncluded: false,
      locationsIncluded: false,
      rawSaveDataIncluded: false,
    },
  };
}
