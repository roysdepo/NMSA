import {
  canonicalNmsName,
  classifyNmsFilename,
} from "./completion.js";

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function directoryFromPath(value) {
  const normalized = normalizePath(value);
  const separator = normalized.lastIndexOf("/");
  return separator === -1 ? "." : normalized.slice(0, separator);
}

function exactNameRank(record, canonicalName) {
  return record.name.toLowerCase() === canonicalName.toLowerCase() ? 2 : 1;
}

function preferCanonicalName(current, candidate, canonicalName) {
  if (!current) return candidate;
  const currentRank = exactNameRank(current, canonicalName);
  const candidateRank = exactNameRank(candidate, canonicalName);
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank ? candidate : current;
  }
  return candidate.lastModified > current.lastModified ? candidate : current;
}

function companionRole(name) {
  if (String(name || "").toLowerCase() === "gcusersettingsdata.mxml") {
    return "platformSettings";
  }
  return classifyNmsFilename(name);
}

export function toDirectoryRecord(entry) {
  const file = entry?.file ?? entry;
  const relativePath = normalizePath(
    entry?.relativePath || file?.webkitRelativePath || file?.name,
  );
  return {
    ...(entry && typeof entry === "object" ? entry : {}),
    file,
    name: file?.name || relativePath.split("/").at(-1) || "",
    size: Number(file?.size || 0),
    lastModified: Number(file?.lastModified ?? entry?.lastModified ?? 0),
    relativePath,
    directory: directoryFromPath(relativePath),
  };
}

export function storageOrdinalFromSaveName(name) {
  const canonical = canonicalNmsName(name).toLowerCase();
  if (canonical === "save.hg") return 1;
  const match = /^save(\d+)\.hg$/.exec(canonical);
  return match ? Number(match[1]) : null;
}

export function logicalSlotFromSaveName(name) {
  const ordinal = storageOrdinalFromSaveName(name);
  return ordinal === null ? null : Math.ceil(ordinal / 2);
}

export function savePointTypeFromSaveName(name) {
  const ordinal = storageOrdinalFromSaveName(name);
  if (ordinal === null) return null;
  return ordinal % 2 === 1 ? "auto" : "restore";
}

export function savePointLabelFromSaveName(name) {
  const type = savePointTypeFromSaveName(name);
  if (type === "auto") return "Autosave";
  if (type === "restore") return "Restore Point";
  return "Save Point";
}

export function discoverSaveFileSets(entries) {
  const directories = new Map();
  for (const entry of entries) {
    const record = toDirectoryRecord(entry);
    if (!record.file || !companionRole(record.name)) continue;
    if (!directories.has(record.directory)) directories.set(record.directory, []);
    directories.get(record.directory).push(record);
  }

  const sets = [];
  for (const [directory, records] of directories) {
    const files = new Map();
    for (const record of records) {
      const canonical = canonicalNmsName(record.name).toLowerCase();
      files.set(
        canonical,
        preferCanonicalName(files.get(canonical), record, canonical),
      );
    }

    const account = files.get("accountdata.hg") ?? null;
    const accountMeta = files.get("mf_accountdata.hg") ?? null;
    const platformSettings = files.get("gcusersettingsdata.mxml") ?? null;
    for (const save of files.values()) {
      if (companionRole(save.name) !== "save") continue;
      const canonicalSave = canonicalNmsName(save.name).toLowerCase();
      const saveMeta = files.get(`mf_${canonicalSave}`) ?? null;
      const missing = [];
      if (!saveMeta) missing.push(`mf_${canonicalSave}`);
      if (!account) missing.push("accountdata.hg");
      // Steam and GOG accountdata.hg has no required manifest. Some editors
      // leave a stale mf_accountdata.hg behind, so it is discovered but optional.
      sets.push({
        id: `${directory}|${canonicalSave}`,
        directory,
        profileName: directory.split("/").at(-1) || directory,
        logicalSlot: logicalSlotFromSaveName(canonicalSave),
        storageOrdinal: storageOrdinalFromSaveName(canonicalSave),
        savePointType: savePointTypeFromSaveName(canonicalSave),
        savePointLabel: savePointLabelFromSaveName(canonicalSave),
        save,
        saveMeta,
        account,
        accountMeta,
        platformSettings,
        missing,
        complete: missing.length === 0,
      });
    }
  }

  return sets.sort((left, right) =>
    left.directory.localeCompare(right.directory) ||
    (left.logicalSlot ?? 999) - (right.logicalSlot ?? 999) ||
    (left.storageOrdinal ?? 999) - (right.storageOrdinal ?? 999),
  );
}

export function choosePreferredSaveSets(sets) {
  const groups = new Map();
  for (const set of sets) {
    const key = `${set.directory}|${set.logicalSlot}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(set);
  }

  const selected = [];
  for (const candidates of groups.values()) {
    candidates.sort((left, right) => {
      const leftWritable = left.writeAllowed === true ? 1 : 0;
      const rightWritable = right.writeAllowed === true ? 1 : 0;
      if (leftWritable !== rightWritable) return rightWritable - leftWritable;
      const leftReady = left.ready === true ? 1 : 0;
      const rightReady = right.ready === true ? 1 : 0;
      if (leftReady !== rightReady) return rightReady - leftReady;
      if (left.complete !== right.complete) return Number(right.complete) - Number(left.complete);
      if (left.save.lastModified !== right.save.lastModified) {
        return right.save.lastModified - left.save.lastModified;
      }
      return (right.storageOrdinal ?? 0) - (left.storageOrdinal ?? 0);
    });
    selected.push(...candidates);
  }

  return selected.sort((left, right) =>
    left.directory.localeCompare(right.directory) ||
    (left.logicalSlot ?? 999) - (right.logicalSlot ?? 999),
  );
}
