import { cloneJson } from "./nms-codec.js";
import { resolveSaveContext } from "./context-resolver.js";

export const DEFAULT_OPTIONS = Object.freeze({
  rewards: true,
  licensedEntitlements: false,
  blueprints: true,
  languageAndSlots: true,
  catalogue: true,
  naturalProgression: false,
  progressionConveniences: false,
  repairIntegrity: false,
});

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Save is missing the required ${name} object.`);
  }
  return value;
}

function requireArray(parent, field) {
  if (!Array.isArray(parent[field])) {
    throw new Error(`Save is missing the required ${field} list.`);
  }
  return parent[field];
}

function appendMissing(target, source) {
  const known = new Set(target);
  const added = [];
  for (const item of source) {
    if (!known.has(item)) {
      target.push(item);
      known.add(item);
      added.push(item);
    }
  }
  return added;
}

function removeListed(target, source) {
  const blocked = new Set(source);
  const removed = [];
  let write = 0;
  for (const item of target) {
    if (blocked.has(item)) {
      removed.push(item);
      continue;
    }
    target[write++] = item;
  }
  target.length = write;
  return removed;
}

function withoutListed(values, blockedValues) {
  const blocked = new Set(blockedValues);
  return values.filter((item) => !blocked.has(item));
}

function countListed(values, blockedValues) {
  const blocked = new Set(blockedValues);
  return values.reduce((count, item) => count + (blocked.has(item) ? 1 : 0), 0);
}

function mergeWordGroups(target, source) {
  const byGroup = new Map(target.map((entry) => [entry.Group, entry]));
  const added = [];
  const expanded = [];
  for (const masterEntry of source) {
    const current = byGroup.get(masterEntry.Group);
    if (!current) {
      const inserted = cloneJson(masterEntry);
      target.push(inserted);
      byGroup.set(inserted.Group, inserted);
      added.push(inserted.Group);
      continue;
    }
    if (!Array.isArray(current.Races)) current.Races = [];
    let changed = false;
    for (let index = 0; index < masterEntry.Races.length; index += 1) {
      if (masterEntry.Races[index] && !current.Races[index]) {
        current.Races[index] = true;
        changed = true;
      } else if (current.Races[index] === undefined) {
        current.Races[index] = false;
      }
    }
    if (changed) expanded.push(masterEntry.Group);
  }
  return { added, expanded };
}

function countMissing(target, master, key = (item) => item) {
  const present = new Set(target.map(key));
  return master.reduce(
    (count, item) => count + (present.has(key(item)) ? 0 : 1),
    0,
  );
}

function fishingArrays(player, required = false) {
  const record = player?.FishingRecord;
  const productList = record?.ProductList;
  const largestCatchList = record?.LargestCatchList;
  const productCountList = record?.ProductCountList;
  const valid =
    Array.isArray(productList) &&
    Array.isArray(largestCatchList) &&
    Array.isArray(productCountList) &&
    productList.length === largestCatchList.length &&
    productList.length === productCountList.length;
  if (!valid) {
    if (required) {
      throw new Error(
        "Save is missing the aligned PlayerStateData → FishingRecord arrays.",
      );
    }
    return null;
  }
  return { productList, largestCatchList, productCountList };
}

function positiveFinite(value) {
  const number = Number(value?.value ?? value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validFishMass(value, expected) {
  const number = positiveFinite(value);
  return number !== null &&
    !isFantasyStatSentinel(number) &&
    number <= expected.maximumPlausibleCatch
    ? number
    : null;
}

function validFishCount(value) {
  const number = positiveFinite(value);
  return number !== null &&
    Number.isInteger(number) &&
    number <= 4_294_967_295 &&
    !isFantasyStatSentinel(number)
    ? number
    : null;
}

function analyzeFishingRecords(player, master) {
  const arrays = fishingArrays(player);
  if (!arrays) {
    return {
      targetCount: master.fishingRecords.length,
      present: 0,
      pending: master.fishingRecords.length,
      missing: master.fishingRecords.length,
      invalid: 0,
      duplicates: 0,
      capacity: 0,
    };
  }
  const indexes = new Map();
  arrays.productList.forEach((productId, index) => {
    if (!indexes.has(productId)) indexes.set(productId, []);
    indexes.get(productId).push(index);
  });
  let present = 0;
  let missing = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const expected of master.fishingRecords) {
    const matching = indexes.get(expected.productId) ?? [];
    if (!matching.length) {
      missing += 1;
      continue;
    }
    const valid = matching.some(
      (index) =>
        validFishMass(arrays.largestCatchList[index], expected) !== null &&
        validFishCount(arrays.productCountList[index]) !== null,
    );
    if (!valid) invalid += 1;
    else present += 1;
    if (matching.length > 1) duplicates += matching.length - 1;
  }
  return {
    targetCount: master.fishingRecords.length,
    present,
    pending: missing + invalid + duplicates,
    missing,
    invalid,
    duplicates,
    capacity: arrays.productList.length,
  };
}

function completeFishingRecords(player, master) {
  const arrays = fishingArrays(player, true);
  if (arrays.productList.length < master.fishingRecords.length) {
    throw new Error(
      `FishingRecord has ${arrays.productList.length} slots but ${master.fishingRecords.length} are required.`,
    );
  }
  const indexes = new Map();
  arrays.productList.forEach((productId, index) => {
    if (!indexes.has(productId)) indexes.set(productId, []);
    indexes.get(productId).push(index);
  });
  const blanks = [];
  arrays.productList.forEach((productId, index) => {
    if (!productId || productId === "^") blanks.push(index);
  });
  let added = 0;
  let repaired = 0;
  let deduplicated = 0;
  for (const expected of master.fishingRecords) {
    let matching = indexes.get(expected.productId) ?? [];
    let index = matching[0];
    if (index === undefined) {
      index = blanks.shift();
      if (index === undefined) {
        throw new Error(
          `FishingRecord has no empty slot for ${expected.productId}.`,
        );
      }
      arrays.productList[index] = expected.productId;
      arrays.largestCatchList[index] = expected.largestCatch;
      arrays.productCountList[index] = expected.count;
      matching = [index];
      indexes.set(expected.productId, matching);
      added += 1;
      continue;
    }

    const primaryMass = validFishMass(arrays.largestCatchList[index], expected);
    const primaryCount = validFishCount(arrays.productCountList[index]);
    if (
      matching.length === 1 &&
      primaryMass !== null &&
      primaryCount !== null
    ) {
      continue;
    }
    const masses = matching
      .map((entryIndex) =>
        validFishMass(arrays.largestCatchList[entryIndex], expected)
      )
      .filter((value) => value !== null);
    const counts = matching
      .map((entryIndex) => validFishCount(arrays.productCountList[entryIndex]))
      .filter((value) => value !== null);
    const desiredMass = masses.length
      ? Math.max(...masses)
      : expected.largestCatch;
    const desiredCount = counts.length
      ? Math.min(4_294_967_295, Math.round(counts.reduce((sum, value) => sum + value, 0)))
      : expected.count;
    if (
      primaryMass === null ||
      primaryCount === null
    ) {
      repaired += 1;
    }
    arrays.largestCatchList[index] = desiredMass;
    arrays.productCountList[index] = desiredCount;
    for (const duplicateIndex of matching.slice(1)) {
      arrays.productList[duplicateIndex] = "^";
      arrays.largestCatchList[duplicateIndex] = 0;
      arrays.productCountList[duplicateIndex] = 0;
      blanks.push(duplicateIndex);
      deduplicated += 1;
    }
  }
  return {
    changed: added + repaired + deduplicated,
    added,
    repaired,
    deduplicated,
  };
}

function analyzeStoryRecords(player, master) {
  const categories = Array.isArray(player?.SeenStories)
    ? player.SeenStories
    : [];
  let present = 0;
  let missing = 0;
  let invalid = 0;
  for (const expected of master.storyRecords) {
    const pages = categories[expected.categoryIndex]?.PagesData;
    if (!Array.isArray(pages)) {
      missing += 1;
      continue;
    }
    const matching = pages.filter(
      (record) => Number(record?.PageIdx) === expected.pageIndex,
    );
    if (!matching.length) {
      missing += 1;
      continue;
    }
    if (
      matching.length === 1 &&
      Number(matching[0]?.LastSeenEntryIdx) === expected.targetValue
    ) {
      present += 1;
    } else {
      invalid += 1;
    }
  }
  return {
    targetCount: master.storyRecords.length,
    present,
    pending: missing + invalid,
    missing,
    invalid,
  };
}

function completeStoryRecords(player, master) {
  if (!Array.isArray(player.SeenStories)) player.SeenStories = [];
  const categories = player.SeenStories;
  const finalCategory = Math.max(
    ...master.storyRecords.map((record) => record.categoryIndex),
  );
  while (categories.length <= finalCategory) {
    categories.push({ PagesData: [] });
  }
  let added = 0;
  let normalized = 0;
  let deduplicated = 0;
  for (const expected of master.storyRecords) {
    let category = categories[expected.categoryIndex];
    if (!category || typeof category !== "object" || Array.isArray(category)) {
      category = { PagesData: [] };
      categories[expected.categoryIndex] = category;
    }
    if (!Array.isArray(category.PagesData)) category.PagesData = [];
    const matching = category.PagesData
      .map((record, index) => ({ record, index }))
      .filter(
        ({ record }) => Number(record?.PageIdx) === expected.pageIndex,
      );
    if (!matching.length) {
      category.PagesData.push({
        PageIdx: expected.pageIndex,
        LastSeenEntryIdx: expected.targetValue,
      });
      added += 1;
      continue;
    }
    const primary = matching[0].record;
    if (
      Number(primary.LastSeenEntryIdx) !== expected.targetValue ||
      primary.PageIdx !== expected.pageIndex
    ) {
      primary.PageIdx = expected.pageIndex;
      primary.LastSeenEntryIdx = expected.targetValue;
      normalized += 1;
    }
    for (const duplicate of matching.slice(1).reverse()) {
      category.PagesData.splice(duplicate.index, 1);
      deduplicated += 1;
    }
  }
  return {
    changed: added + normalized + deduplicated,
    added,
    normalized,
    deduplicated,
  };
}

export function accountEntitlements(master) {
  return [...new Set([
    ...master.platformRewards,
    ...master.contentEntitlements,
  ])];
}

function countWordGroupsNeedingExpansion(target, master) {
  const byGroup = new Map(target.map((entry) => [entry?.Group, entry]));
  let count = 0;
  for (const expected of master) {
    const current = byGroup.get(expected.Group);
    if (!current || !Array.isArray(current.Races)) continue;
    if (expected.Races.some((required, index) => required && !current.Races[index])) {
      count += 1;
    }
  }
  return count;
}

function projectedCatalogueCounts(player, settings, master, includeBlueprints, includeRewards) {
  const seenProducts = new Set(requireArray(settings, "SeenProducts"));
  const desiredProducts = new Set([
    ...withoutListed(
      requireArray(player, "KnownProducts"),
      master.contextualKnownProducts ?? [],
    ),
    ...(includeBlueprints ? master.knownProducts : []),
    ...requireArray(player, "KnownSpecials"),
    ...(includeRewards ? master.knownSpecials : []),
  ]);
  const seenKnownProducts = [...desiredProducts].filter((item) => !seenProducts.has(item)).length;
  const productsAfterKnown = new Set([...seenProducts, ...desiredProducts]);
  const productRecords = (
    master.authoritativeCatalogueRecordProducts ?? master.catalogueRecordProducts
  ).filter(
    (item) => !productsAfterKnown.has(item),
  ).length;

  const seenTechnologies = new Set(requireArray(settings, "SeenTechnologies"));
  const desiredTechnologies = new Set([
    ...withoutListed(
      requireArray(player, "KnownTech"),
      master.disallowedKnownTechnologies,
    ),
    ...(includeBlueprints ? master.knownTechnologies : []),
  ]);
  return {
    seenKnownProducts,
    seenKnownTechnologies: [...desiredTechnologies].filter(
      (item) => !seenTechnologies.has(item),
    ).length,
    productRecords,
  };
}

function identityKey(identity) {
  return [identity.PTK, identity.UID, identity.LID, identity.USN].join("|");
}

export function validateIdentity(identity, label = "identity") {
  const normalized = {
    PTK: String(identity?.PTK ?? "").trim().toUpperCase(),
    UID: String(identity?.UID ?? "").trim(),
    LID: String(identity?.LID ?? "").trim(),
    USN: String(identity?.USN ?? "").trim(),
  };
  if (!normalized.PTK || !normalized.UID || !normalized.LID || !normalized.USN) {
    throw new Error(`${label} requires platform, username, UID, and local ID.`);
  }
  if (!/^[A-Za-z0-9_-]{1,8}$/.test(normalized.PTK)) {
    throw new Error(`${label} has an invalid platform token.`);
  }
  return normalized;
}

function withTimestamp(identity, timestamp = 0) {
  return { ...identity, TS: timestamp };
}

function normalizeOwnership(save, ownership, contextPreference = "active") {
  if (!ownership?.enabled) {
    return {
      enabled: false,
      identitiesRegistered: 0,
      identityRecordsChanged: 0,
      basesNormalized: 0,
      discoveriesNormalized: 0,
      editorLabelsCleared: 0,
      totalChanges: 0,
    };
  }

  const primary = validateIdentity(ownership.primary, "Primary identity");
  const identities = [primary];
  for (const [index, identity] of (ownership.aliases ?? []).entries()) {
    identities.push(validateIdentity(identity, `Alias ${index + 1}`));
  }
  const uniqueIdentities = [];
  const seenIdentityKeys = new Set();
  const seenUids = new Set();
  for (const identity of identities) {
    if (seenUids.has(identity.UID)) {
      throw new Error(`Ownership identities contain duplicate UID ${identity.UID}.`);
    }
    const key = identityKey(identity);
    if (!seenIdentityKeys.has(key)) {
      uniqueIdentities.push(identity);
      seenIdentityKeys.add(key);
      seenUids.add(identity.UID);
    }
  }

  const common = requireObject(save.CommonStateData, "CommonStateData");
  const player = resolveSaveContext(save, contextPreference).playerState;
  const usedOwners = requireArray(common, "UsedDiscoveryOwnersV2");
  const identityByUid = new Map(uniqueIdentities.map((item) => [item.UID, item]));
  const foundUids = new Set();
  let identityRecordsChanged = 0;
  const identityMatches = (current, expected) =>
    ["PTK", "UID", "LID", "USN"].every(
      (field) => String(current?.[field] ?? "") === String(expected?.[field] ?? ""),
    );
  for (let index = 0; index < usedOwners.length; index += 1) {
    const current = usedOwners[index];
    const identity = identityByUid.get(String(current?.UID ?? ""));
    if (identity) {
      if (!identityMatches(current, identity)) identityRecordsChanged += 1;
      usedOwners[index] = withTimestamp(identity, current.TS ?? 0);
      foundUids.add(identity.UID);
    }
  }
  for (const identity of uniqueIdentities) {
    if (!foundUids.has(identity.UID)) {
      usedOwners.push(withTimestamp(identity));
      identityRecordsChanged += 1;
    }
  }

  let basesNormalized = 0;
  let editorLabelsCleared = 0;
  if (ownership.normalizeBases) {
    for (const base of requireArray(player, "PersistentPlayerBases")) {
      if (!identityMatches(base.Owner, primary)) {
        base.Owner = withTimestamp(primary, base.Owner?.TS ?? 0);
        basesNormalized += 1;
      }
      if (ownership.clearBaseEditorLabels) {
        if (base.LastEditedById || base.LastEditedByUsername) {
          editorLabelsCleared += 1;
        }
        base.LastEditedById = "";
        base.LastEditedByUsername = "";
      }
    }
  }

  let discoveriesNormalized = 0;
  if (ownership.normalizeMatchingDiscoveries) {
    const records =
      save.DiscoveryManagerData?.["DiscoveryData-v1"]?.Store?.Record;
    if (!Array.isArray(records)) {
      throw new Error("Save is missing the discovery record store.");
    }
    for (const record of records) {
      const currentOwner = record?.OWS;
      const identity = identityByUid.get(String(currentOwner?.UID ?? ""));
      if (identity && !identityMatches(currentOwner, identity)) {
        record.OWS = withTimestamp(identity, currentOwner.TS ?? 0);
        discoveriesNormalized += 1;
      }
    }
  }

  return {
    enabled: true,
    identitiesRegistered: uniqueIdentities.length,
    identityRecordsChanged,
    basesNormalized,
    discoveriesNormalized,
    editorLabelsCleared,
    totalChanges:
      identityRecordsChanged + basesNormalized + discoveriesNormalized + editorLabelsCleared,
  };
}

function getState(save, account, contextPreference = "active") {
  const context = resolveSaveContext(save, contextPreference);
  const player = requireObject(context.playerState, "PlayerStateData");
  const settings = requireObject(account.UserSettingsData, "UserSettingsData");
  return { player, settings, context };
}

const FANTASY_STAT_SENTINELS = new Set([
  -2_147_483_648,
  2_147_483_647,
  2_147_483_648,
  4_294_967_295,
]);

function finiteStatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isFantasyStatSentinel(value) {
  return (
    value !== null &&
    (FANTASY_STAT_SENTINELS.has(value) || value <= -2_000_000_000)
  );
}

function globalStatsForPlayer(player, required = false) {
  const groups = Array.isArray(player?.Stats) ? player.Stats : null;
  const globalGroup = groups?.find(
    (group) => String(group?.GroupId || "").toUpperCase() === "^GLOBAL_STATS",
  );
  if (!Array.isArray(globalGroup?.Stats)) {
    if (required) {
      throw new Error("Save is missing PlayerStateData → Stats → ^GLOBAL_STATS.");
    }
    return null;
  }
  return globalGroup.Stats;
}

function wordProgressionCounts(player) {
  const groups = Array.isArray(player?.KnownWordGroups)
    ? player.KnownWordGroups
    : [];
  const counts = {
    knownWordGroups: groups.length,
    raceWords0: 0,
    raceWords1: 0,
    raceWords2: 0,
  };
  for (const group of groups) {
    if (!Array.isArray(group?.Races)) continue;
    if (group.Races[0]) counts.raceWords0 += 1;
    if (group.Races[1]) counts.raceWords1 += 1;
    if (group.Races[2]) counts.raceWords2 += 1;
  }
  return counts;
}

function resolvedProgressionTargets(player, master) {
  const wordCounts = wordProgressionCounts(player);
  return requireArray(master, "naturalProgressionTargets").map((definition) => ({
    ...definition,
    target:
      definition.source === undefined
        ? Number(definition.target)
        : Number(wordCounts[definition.source] ?? 0),
  }));
}

function resolvedStatRepairs(player, master) {
  const stats = globalStatsForPlayer(player) ?? [];
  const byId = new Map(
    stats.map((entry) => [String(entry?.Id || "").toUpperCase(), entry]),
  );
  const rankedIds = new Set(
    master.naturalProgressionTargets.map((definition) => definition.id.toUpperCase()),
  );
  const allowedNegativeIds = new Set(
    master.naturalNegativeStatAllowlist.map((id) => id.toUpperCase()),
  );
  const explicit = master.naturalStatRepairs
    .filter((definition) => byId.has(definition.id.toUpperCase()))
    .map((definition) => ({ ...definition, mode: "repair" }));
  const explicitIds = new Set(explicit.map((definition) => definition.id.toUpperCase()));
  const discovered = [];
  for (const entry of stats) {
    const id = String(entry?.Id || "").toUpperCase();
    if (!id || rankedIds.has(id) || explicitIds.has(id) || allowedNegativeIds.has(id)) {
      continue;
    }
    const values = [
      finiteStatNumber(entry?.Value?.IntValue),
      finiteStatNumber(entry?.Value?.FloatValue),
    ].filter((value) => value !== null);
    if (!values.some(isFantasyStatSentinel)) continue;
    discovered.push({
      id,
      label: id,
      category: "Sentinel cleanup",
      target: 0,
      storage:
        entry?.Value?.FloatValue !== undefined &&
        entry?.Value?.IntValue === undefined
          ? "float"
          : "int",
      mode: "repair",
    });
  }
  return [...explicit, ...discovered];
}

function inspectProgressionEntry(entry, target, mode = "ranked") {
  const intValue = finiteStatNumber(entry?.Value?.IntValue);
  const floatValue = finiteStatNumber(entry?.Value?.FloatValue);
  const presentValues = [intValue, floatValue].filter((value) => value !== null);
  const believableValues = presentValues.filter(
    (value) => value >= 0 && !isFantasyStatSentinel(value),
  );
  const current =
    (believableValues.length ? Math.max(...believableValues) : null) ??
    presentValues[0] ??
    0;
  const mirrorsDisagree =
    intValue !== null &&
    floatValue !== null &&
    Math.abs(intValue - floatValue) > 0.000_1;
  const fantasyValue = presentValues.some(isFantasyStatSentinel);
  const invalidValue =
    mode === "ranked" && presentValues.some((value) => value < 0);
  const pending = mode === "repair"
    ? Boolean(entry && fantasyValue)
    : !entry ||
      current < target ||
      fantasyValue ||
      invalidValue ||
      mirrorsDisagree;
  const desired = believableValues.length
    ? Math.max(target, ...believableValues)
    : target;
  return {
    current,
    pending,
    fantasyValue,
    invalidValue,
    mirrorsDisagree,
    desired,
  };
}

function analyzeNaturalProgression(player, master) {
  const stats = globalStatsForPlayer(player);
  const byId = new Map(
    (stats ?? []).map((entry) => [String(entry?.Id || "").toUpperCase(), entry]),
  );
  const rankedEntries = resolvedProgressionTargets(player, master).map((definition) => {
    const entry = byId.get(definition.id.toUpperCase()) ?? null;
    return {
      id: definition.id,
      label: definition.label,
      category: definition.category,
      target: definition.target,
      storage: definition.storage,
      mode: "ranked",
      ...inspectProgressionEntry(entry, definition.target, "ranked"),
    };
  });
  const repairEntries = resolvedStatRepairs(player, master).map((definition) => {
    const entry = byId.get(definition.id.toUpperCase()) ?? null;
    return {
      id: definition.id,
      label: definition.label,
      category: definition.category || "Sentinel cleanup",
      target: Number(definition.target),
      storage: definition.storage,
      mode: "repair",
      ...inspectProgressionEntry(entry, Number(definition.target), "repair"),
    };
  });
  const entries = [...rankedEntries, ...repairEntries];
  const categories = {};
  for (const entry of entries) {
    const group = categories[entry.category] ?? { targets: 0, pending: 0 };
    group.targets += 1;
    if (entry.pending) group.pending += 1;
    categories[entry.category] = group;
  }
  return {
    targetCount: entries.length,
    rankedTargetCount: rankedEntries.length,
    repairTargetCount: repairEntries.length,
    pending: entries.filter((entry) => entry.pending).length,
    astronomical: entries.filter((entry) => entry.fantasyValue).length,
    missing: rankedEntries.filter((entry) => entry.current === 0 && entry.pending).length,
    sentinelRepairs: repairEntries.filter((entry) => entry.pending).length,
    categories,
    entries,
  };
}

function applyNaturalProgression(player, master) {
  const stats = globalStatsForPlayer(player, true);
  const byId = new Map(
    stats.map((entry) => [String(entry?.Id || "").toUpperCase(), entry]),
  );
  let changed = 0;
  let created = 0;
  let normalized = 0;
  let raised = 0;
  const definitions = [
    ...resolvedProgressionTargets(player, master).map((definition) => ({
      ...definition,
      mode: "ranked",
    })),
    ...resolvedStatRepairs(player, master),
  ];
  for (const definition of definitions) {
    let entry = byId.get(definition.id.toUpperCase()) ?? null;
    const inspection = inspectProgressionEntry(
      entry,
      definition.target,
      definition.mode,
    );
    if (!inspection.pending) continue;
    if (!entry && definition.mode === "repair") continue;
    if (!entry) {
      entry = { Id: definition.id, Value: {} };
      stats.push(entry);
      byId.set(definition.id.toUpperCase(), entry);
      created += 1;
    }
    if (!entry.Value || typeof entry.Value !== "object" || Array.isArray(entry.Value)) {
      entry.Value = {};
    }
    const desired = definition.storage === "int"
      ? Math.round(inspection.desired)
      : Number(inspection.desired);
    entry.Value.IntValue = Math.round(desired);
    entry.Value.FloatValue = Number(desired);
    changed += 1;
    if (inspection.fantasyValue || inspection.invalidValue) normalized += 1;
    else if (inspection.current < definition.target) raised += 1;
  }
  return { changed, created, normalized, raised };
}

function duplicateCount(values, key = (item) => item) {
  if (!Array.isArray(values)) return 0;
  return values.length - new Set(values.map(key)).size;
}

const PROCEDURAL_WONDER_FIELDS = Object.freeze([
  ["WonderPlanetRecords", "Planet"],
  ["WonderCreatureRecords", "Animal"],
  ["WonderFloraRecords", "Flora"],
  ["WonderMineralRecords", "Mineral"],
]);

function canonicalGenerationValue(value) {
  const raw = value?.value ?? value;
  if (typeof raw === "bigint") return raw.toString(16);
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return BigInt(Math.trunc(raw)).toString(16);
  }
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    return BigInt(text).toString(16);
  } catch {
    return text.toUpperCase();
  }
}

function generationKey(first, second) {
  const left = canonicalGenerationValue(first);
  const right = canonicalGenerationValue(second);
  return left === null || right === null ? null : `${left}|${right}`;
}

function isBlankGenerationId(value) {
  const key = generationKey(value?.[0], value?.[1]);
  return key === "0|0";
}

function encodeAsciiGenerationWord(text) {
  let value = 0n;
  for (let index = 0; index < text.length; index += 1) {
    value |= BigInt(text.charCodeAt(index)) << BigInt(index * 8);
  }
  return value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : `0x${value.toString(16).toUpperCase()}`;
}

function anomalousBasePartGenerationId(productId) {
  const identifier = String(productId || "").replace(/^\^/, "");
  if (!identifier || identifier.length > 16 || !/^[\x20-\x7e]+$/.test(identifier)) {
    throw new Error(`Invalid reality-glitch product identifier ${productId}.`);
  }
  return [
    encodeAsciiGenerationWord(identifier.slice(0, 8)),
    encodeAsciiGenerationWord(identifier.slice(8, 16)),
  ];
}

function anomalousBasePartKey(productId) {
  const generationId = anomalousBasePartGenerationId(productId);
  return generationKey(generationId[0], generationId[1]);
}

function validAnomalousBasePartStat(value) {
  const number = positiveFinite(value);
  return number !== null && !isFantasyStatSentinel(number) ? number : null;
}

function analyzeAnomalousBasePartRecords(player, master) {
  const records = Array.isArray(player?.WonderWeirdBasePartRecords)
    ? player.WonderWeirdBasePartRecords
    : [];
  const indexes = new Map();
  records.forEach((record, index) => {
    const key = generationKey(record?.GenerationID?.[0], record?.GenerationID?.[1]);
    if (!key || key === "0|0") return;
    if (!indexes.has(key)) indexes.set(key, []);
    indexes.get(key).push(index);
  });
  let present = 0;
  let missing = 0;
  let invalid = 0;
  let duplicates = 0;
  for (const productId of master.anomalousBasePartRecords) {
    const matching = indexes.get(anomalousBasePartKey(productId)) ?? [];
    if (!matching.length) {
      missing += 1;
      continue;
    }
    const valid = matching.some((index) => {
      const record = records[index];
      return (
        validAnomalousBasePartStat(record?.WonderStatValue) !== null &&
        record?.SeenInFrontend === true
      );
    });
    if (valid) present += 1;
    else invalid += 1;
    if (matching.length > 1) duplicates += matching.length - 1;
  }
  return {
    targetCount: master.anomalousBasePartRecords.length,
    present,
    pending: missing + invalid + duplicates,
    missing,
    invalid,
    duplicates,
    capacity: records.length,
  };
}

function completeAnomalousBasePartRecords(player, master) {
  if (!Array.isArray(player.WonderWeirdBasePartRecords)) {
    player.WonderWeirdBasePartRecords = [];
  }
  const records = player.WonderWeirdBasePartRecords;
  while (records.length < master.anomalousBasePartRecords.length) {
    records.push({
      GenerationID: [0, 0],
      WonderStatValue: 0,
      SeenInFrontend: false,
    });
  }
  const indexes = new Map();
  const blanks = [];
  records.forEach((record, index) => {
    const key = generationKey(record?.GenerationID?.[0], record?.GenerationID?.[1]);
    if (!key || key === "0|0") {
      blanks.push(index);
      return;
    }
    if (!indexes.has(key)) indexes.set(key, []);
    indexes.get(key).push(index);
  });
  let added = 0;
  let repaired = 0;
  let deduplicated = 0;
  for (const productId of master.anomalousBasePartRecords) {
    const expectedKey = anomalousBasePartKey(productId);
    let matching = indexes.get(expectedKey) ?? [];
    let index = matching[0];
    if (index === undefined) {
      index = blanks.shift();
      if (index === undefined) {
        throw new Error(
          `WonderWeirdBasePartRecords has no empty slot for ${productId}.`,
        );
      }
      records[index] = {
        GenerationID: anomalousBasePartGenerationId(productId),
        WonderStatValue: 1,
        SeenInFrontend: true,
      };
      indexes.set(expectedKey, [index]);
      added += 1;
      continue;
    }
    const validValues = matching
      .map((recordIndex) =>
        validAnomalousBasePartStat(records[recordIndex]?.WonderStatValue)
      )
      .filter((value) => value !== null);
    const primary = records[index];
    const desiredValue = validValues.length ? Math.max(...validValues) : 1;
    if (
      validAnomalousBasePartStat(primary?.WonderStatValue) === null ||
      primary?.SeenInFrontend !== true
    ) {
      repaired += 1;
    }
    primary.WonderStatValue = desiredValue;
    primary.SeenInFrontend = true;
    for (const duplicateIndex of matching.slice(1)) {
      records[duplicateIndex] = {
        GenerationID: [0, 0],
        WonderStatValue: 0,
        SeenInFrontend: false,
      };
      blanks.push(duplicateIndex);
      deduplicated += 1;
    }
  }
  return {
    changed: added + repaired + deduplicated,
    added,
    repaired,
    deduplicated,
  };
}

function orphanedProceduralWonderRecords(save, player) {
  const discoveries =
    save?.DiscoveryManagerData?.["DiscoveryData-v1"]?.Store?.Record;
  if (!Array.isArray(discoveries)) return [];
  const validByType = new Map(
    PROCEDURAL_WONDER_FIELDS.map(([, type]) => [type, new Set()]),
  );
  for (const discovery of discoveries) {
    const type = discovery?.DD?.DT;
    const valid = validByType.get(type);
    if (!valid) continue;
    const key = generationKey(discovery?.DD?.UA, discovery?.DD?.VP?.[0]);
    if (key) valid.add(key);
  }
  const orphaned = [];
  for (const [field, type] of PROCEDURAL_WONDER_FIELDS) {
    const records = player?.[field];
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (isBlankGenerationId(record?.GenerationID)) continue;
      const key = generationKey(record?.GenerationID?.[0], record?.GenerationID?.[1]);
      if (!key || !validByType.get(type).has(key)) {
        orphaned.push({ field, record });
      }
    }
  }
  return orphaned;
}

function clearOrphanedProceduralWonderRecords(save, player) {
  const orphaned = orphanedProceduralWonderRecords(save, player);
  for (const { record } of orphaned) {
    record.GenerationID = [0, 0];
    record.WonderStatValue = 0;
    record.SeenInFrontend = false;
  }
  return orphaned.length;
}

function analyzeIntegrity(save, player, settings, master) {
  const fields = [
    [player, "KnownProducts"],
    [player, "KnownSpecials"],
    [player, "KnownTech"],
    [player, "KnownRefinerRecipes"],
    [player, "RedeemedSeasonRewards"],
    [player, "RedeemedTwitchRewards"],
    [player, "RedeemedPlatformRewards"],
    [player, "SeenBaseBuildingObjects"],
    [settings, "UnlockedSpecials"],
    [settings, "UnlockedSeasonRewards"],
    [settings, "UnlockedTwitchRewards"],
    [settings, "UnlockedPlatformRewards"],
    [settings, "UnlockedTitles"],
    [settings, "SeenProducts"],
    [settings, "SeenTechnologies"],
    [settings, "SeenSubstances"],
    [settings, "SeenWikiTopics"],
    [settings, "UnlockedWikiTopics"],
  ];
  let duplicateEntries = 0;
  for (const [parent, field] of fields) {
    duplicateEntries += duplicateCount(parent?.[field]);
  }
  duplicateEntries += duplicateCount(player.KnownWordGroups, (item) => item?.Group);
  const malformedWordGroups = Array.isArray(player.KnownWordGroups)
    ? player.KnownWordGroups.filter(
        (item) => !item || typeof item.Group !== "string" || !Array.isArray(item.Races),
      ).length
    : 0;
  const disallowedKnownTechnologies = countListed(
    requireArray(player, "KnownTech"),
    master.disallowedKnownTechnologies,
  );
  const disallowedSeenTechnologies = countListed(
    requireArray(settings, "SeenTechnologies"),
    master.disallowedSeenTechnologies,
  );
  const orphanedProceduralWonders =
    orphanedProceduralWonderRecords(save, player).length;
  return {
    duplicateEntries,
    malformedWordGroups,
    orphanedProceduralWonders,
    structuralIssues:
      duplicateEntries + malformedWordGroups + orphanedProceduralWonders,
    disallowedKnownTechnologies,
    disallowedSeenTechnologies,
    repairableIssues:
      duplicateEntries +
      malformedWordGroups +
      orphanedProceduralWonders +
      disallowedKnownTechnologies,
  };
}

function healthGrade(score) {
  if (score >= 99.995) return "Complete";
  if (score >= 95) return "Excellent";
  if (score >= 80) return "Good";
  if (score >= 50) return "Partial";
  return "Early";
}

export function analyzeCompletion(save, account, master, contextPreference = "active") {
  const { player, settings, context } = getState(save, account, contextPreference);
  const progression = analyzeNaturalProgression(player, master);
  const fishing = analyzeFishingRecords(player, master);
  const stories = analyzeStoryRecords(player, master);
  const anomalousBaseParts = analyzeAnomalousBasePartRecords(player, master);
  const knownProductUnion = [
    ...new Set([
      ...withoutListed(
        requireArray(player, "KnownProducts"),
        master.contextualKnownProducts ?? [],
      ),
      ...requireArray(player, "KnownSpecials"),
    ]),
  ];
  const analysis = {
    missing: {
      knownProducts: countMissing(
        requireArray(player, "KnownProducts"),
        master.knownProducts,
      ),
      knownSpecials: countMissing(
        requireArray(player, "KnownSpecials"),
        master.knownSpecials,
      ),
      accountSpecials: countMissing(
        requireArray(settings, "UnlockedSpecials"),
        master.knownSpecials,
      ),
      knownTechnologies: countMissing(
        requireArray(player, "KnownTech"),
        master.knownTechnologies,
      ),
      disallowedKnownTechnologies: countListed(
        requireArray(player, "KnownTech"),
        master.disallowedKnownTechnologies,
      ),
      refinerRecipes: countMissing(
        requireArray(player, "KnownRefinerRecipes"),
        master.refinerRecipes,
      ),
      wordGroups: countMissing(
        requireArray(player, "KnownWordGroups"),
        master.wordGroups,
        (item) => item.Group,
      ),
      wordGroupsExpanded: countWordGroupsNeedingExpansion(
        requireArray(player, "KnownWordGroups"),
        master.wordGroups,
      ),
      seasonRewards: countMissing(
        requireArray(settings, "UnlockedSeasonRewards"),
        master.seasonRewards,
      ),
      twitchRewards: countMissing(
        requireArray(settings, "UnlockedTwitchRewards"),
        master.twitchRewards,
      ),
      redeemedSeasonRewards: countMissing(
        requireArray(player, "RedeemedSeasonRewards"),
        master.seasonRewards,
      ),
      redeemedTwitchRewards: countMissing(
        requireArray(player, "RedeemedTwitchRewards"),
        master.twitchRewards,
      ),
      // Current game behavior stores platform entitlements at account level
      // (and in PC MXML), not as per-save redemption state.
      redeemedPlatformRewards: 0,
      titles: countMissing(
        requireArray(settings, "UnlockedTitles"),
        master.titles,
      ),
      wikiTopics: countMissing(
        requireArray(settings, "UnlockedWikiTopics"),
        master.wikiTopics,
      ),
      seenWikiTopics: countMissing(
        requireArray(settings, "SeenWikiTopics"),
        master.wikiTopics,
      ),
      seenSubstances: countMissing(
        requireArray(settings, "SeenSubstances"),
        master.seenSubstances,
      ),
      seenKnownProducts: countMissing(
        requireArray(settings, "SeenProducts"),
        knownProductUnion,
      ),
      seenKnownTechnologies: countMissing(
        requireArray(settings, "SeenTechnologies"),
        withoutListed(
          requireArray(player, "KnownTech"),
          master.disallowedKnownTechnologies,
        ),
      ),
      fossilRecords: countMissing(
        requireArray(settings, "SeenProducts"),
        master.fossilRecords,
      ),
      fishingRecords: fishing.pending,
      baseBuildingRecords: countMissing(
        requireArray(player, "SeenBaseBuildingObjects"),
        master.seenBaseBuildingObjects,
      ),
      storyRecords: stories.pending,
      anomalousBasePartRecords: anomalousBaseParts.pending,
      portalRunes: player.KnownPortalRunes === 65_535 ? 0 : 1,
      petSlots: requireArray(player, "UnlockedPetSlots").filter((value) => !value).length,
      squadronSlots: requireArray(player, "SquadronUnlockedPilotSlots").filter(
        (value) => !value,
      ).length,
    },
    contextual: {
      knownProducts: countMissing(
        requireArray(player, "KnownProducts"),
        master.contextualKnownProducts ?? [],
      ),
      platformRewards: countMissing(
        requireArray(settings, "UnlockedPlatformRewards"),
        master.platformRewards,
      ),
      contentEntitlements: countMissing(
        requireArray(settings, "UnlockedPlatformRewards"),
        master.contentEntitlements,
      ),
      internalSeenTechnologies: countListed(
        requireArray(settings, "SeenTechnologies"),
        master.disallowedSeenTechnologies,
      ),
      speculativeShipComponentRecords: countMissing(
        requireArray(settings, "SeenProducts"),
        master.speculativeShipComponentRecords ?? [],
      ),
      naturalProgression: progression.pending,
    },
    current: {
      knownProducts: withoutListed(
        player.KnownProducts,
        master.contextualKnownProducts ?? [],
      ).length,
      knownSpecials: player.KnownSpecials.length,
      knownTechnologies: withoutListed(
        player.KnownTech,
        master.disallowedKnownTechnologies,
      ).length,
      refinerRecipes: player.KnownRefinerRecipes.length,
      wordGroups: player.KnownWordGroups.length,
      seasonRewards: settings.UnlockedSeasonRewards.length,
      twitchRewards: settings.UnlockedTwitchRewards.length,
      platformRewards: settings.UnlockedPlatformRewards.length,
      contentEntitlements:
        master.contentEntitlements.length -
        countMissing(settings.UnlockedPlatformRewards, master.contentEntitlements),
      titles: settings.UnlockedTitles.length,
      fossilRecords:
        master.fossilRecords.length -
        countMissing(settings.SeenProducts, master.fossilRecords),
      fishingRecords: fishing.present,
      baseBuildingRecords:
        master.seenBaseBuildingObjects.length -
        countMissing(
          player.SeenBaseBuildingObjects,
          master.seenBaseBuildingObjects,
        ),
      storyRecords: stories.present,
      anomalousBasePartRecords: anomalousBaseParts.present,
      portalRunes: player.KnownPortalRunes,
      petSlots: requireArray(player, "UnlockedPetSlots").filter(Boolean).length,
      squadronSlots: requireArray(player, "SquadronUnlockedPilotSlots").filter(
        Boolean,
      ).length,
    },
    ownership: analyzeOwnership(save, contextPreference),
    progression,
    fishing,
    stories,
    anomalousBaseParts,
    context: {
      key: context.key,
      type: context.type,
      label: context.label,
      activeTag: context.activeTag,
      seasonNumber: context.seasonNumber,
      available: context.available,
      usedFallback: context.usedFallback,
    },
  };
  analysis.projections = {
    catalogue: {
      base: projectedCatalogueCounts(player, settings, master, false, false),
      blueprints: projectedCatalogueCounts(player, settings, master, true, false),
      rewards: projectedCatalogueCounts(player, settings, master, false, true),
      both: projectedCatalogueCounts(player, settings, master, true, true),
    },
  };
  const convenienceFields = [
    "RevealBlackHoles",
    "HasAccessToNexus",
    "BuildersKnown",
    "HasDiscoveredPurpleSystems",
  ];
  analysis.conveniencesMissing = convenienceFields.filter(
    (field) => player[field] !== true,
  ).length;
  analysis.integrity = analyzeIntegrity(save, player, settings, master);
  analysis.totalMissing = Object.entries(analysis.missing).reduce(
    (total, [field, count]) =>
      total + (
        [
          "seenKnownProducts",
          "seenKnownTechnologies",
          "fossilRecords",
        ].includes(field)
          ? 0
          : count
      ),
    0,
  ) +
    analysis.projections.catalogue.both.seenKnownProducts +
    analysis.projections.catalogue.both.seenKnownTechnologies +
    analysis.projections.catalogue.both.productRecords;
  const targetTotal =
    master.knownProducts.length * 2 +
    master.knownSpecials.length * 3 +
    master.knownTechnologies.length * 2 +
    master.disallowedKnownTechnologies.length +
    master.refinerRecipes.length +
    master.wordGroups.length +
    master.seasonRewards.length * 2 +
    master.twitchRewards.length * 2 +
    master.titles.length +
    master.wikiTopics.length * 2 +
    master.seenSubstances.length +
    (
      master.authoritativeCatalogueOnlyProductRecords ??
      master.catalogueOnlyProductRecords
    ).length +
    master.fishingRecords.length +
    master.seenBaseBuildingObjects.length +
    master.storyRecords.length +
    master.anomalousBasePartRecords.length +
    1 +
    player.UnlockedPetSlots.length +
    player.SquadronUnlockedPilotSlots.length;
  const score = targetTotal
    ? Math.max(0, Math.min(100, ((targetTotal - analysis.totalMissing) / targetTotal) * 100))
    : 100;
  analysis.health = {
    score: Number(score.toFixed(2)),
    grade: healthGrade(score),
    targetEntries: targetTotal,
    completedEntries: Math.max(0, targetTotal - analysis.totalMissing),
    missingEntries: analysis.totalMissing,
  };
  return analysis;
}

export function analyzeOwnership(save, contextPreference = "active") {
  let player = null;
  try {
    player = resolveSaveContext(save, contextPreference).playerState;
  } catch {
    player = null;
  }
  const records =
    save.DiscoveryManagerData?.["DiscoveryData-v1"]?.Store?.Record ?? [];
  const bases = Array.isArray(player?.PersistentPlayerBases)
    ? player.PersistentPlayerBases
    : [];
  const usedOwners = Array.isArray(save.CommonStateData?.UsedDiscoveryOwnersV2)
    ? save.CommonStateData.UsedDiscoveryOwnersV2
    : [];

  function summarize(owners) {
    const counts = new Map();
    for (const owner of owners) {
      if (!owner || typeof owner !== "object") continue;
      const key = [owner.PTK, owner.USN, owner.UID, owner.LID].join("|");
      const existing = counts.get(key) ?? {
        PTK: String(owner.PTK ?? ""),
        USN: String(owner.USN ?? ""),
        UID: String(owner.UID ?? ""),
        LID: String(owner.LID ?? ""),
        count: 0,
      };
      existing.count += 1;
      counts.set(key, existing);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }

  return {
    persistentBases: bases.length,
    baseOwners: summarize(bases.map((base) => base.Owner)),
    discoveryOwners: summarize(records.map((record) => record.OWS)),
    registeredOwners: summarize(usedOwners),
    basesWithEditorLabels: bases.filter(
      (base) => Boolean(base?.LastEditedByUsername || base?.LastEditedById),
    ).length,
    baseEditorLabels: [...new Set(
      bases
        .flatMap((base) => [base.LastEditedByUsername, base.LastEditedById])
        .filter(Boolean)
        .map(String),
    )],
  };
}

function dedupeInPlace(values, key = (item) => item) {
  const seen = new Set();
  let write = 0;
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    values[write++] = value;
  }
  const removed = values.length - write;
  values.length = write;
  return removed;
}

function repairWordGroups(values) {
  const byGroup = new Map();
  let repaired = 0;
  for (const value of values) {
    if (!value || typeof value.Group !== "string") {
      repaired += 1;
      continue;
    }
    if (!Array.isArray(value.Races)) {
      value.Races = [];
      repaired += 1;
    }
    const existing = byGroup.get(value.Group);
    if (!existing) {
      byGroup.set(value.Group, value);
      continue;
    }
    const length = Math.max(existing.Races.length, value.Races.length);
    for (let index = 0; index < length; index += 1) {
      existing.Races[index] = Boolean(existing.Races[index] || value.Races[index]);
    }
    repaired += 1;
  }
  values.splice(0, values.length, ...byGroup.values());
  return repaired;
}

function repairIntegrity(save, player, settings, master) {
  const fields = [
    [player, "KnownProducts"],
    [player, "KnownSpecials"],
    [player, "KnownTech"],
    [player, "KnownRefinerRecipes"],
    [player, "RedeemedSeasonRewards"],
    [player, "RedeemedTwitchRewards"],
    [player, "RedeemedPlatformRewards"],
    [player, "SeenBaseBuildingObjects"],
    [settings, "UnlockedSpecials"],
    [settings, "UnlockedSeasonRewards"],
    [settings, "UnlockedTwitchRewards"],
    [settings, "UnlockedPlatformRewards"],
    [settings, "UnlockedTitles"],
    [settings, "SeenProducts"],
    [settings, "SeenTechnologies"],
    [settings, "SeenSubstances"],
    [settings, "SeenWikiTopics"],
    [settings, "UnlockedWikiTopics"],
  ];
  let repaired = 0;
  for (const [parent, field] of fields) {
    repaired += dedupeInPlace(requireArray(parent, field));
  }
  repaired += removeListed(
    requireArray(player, "KnownTech"),
    master.disallowedKnownTechnologies,
  ).length;
  repaired += repairWordGroups(requireArray(player, "KnownWordGroups"));
  repaired += clearOrphanedProceduralWonderRecords(save, player);
  return repaired;
}

function runCompletion(
  save,
  account,
  master,
  selectedOptions = {},
  ownership = { enabled: false },
  contextPreference = "active",
  beforeAnalysis = null,
) {
  const options = { ...DEFAULT_OPTIONS, ...selectedOptions };
  const { player, settings, context } = getState(save, account, contextPreference);
  const before = beforeAnalysis || analyzeCompletion(save, account, master, contextPreference);
  const changes = {};

  if (options.repairIntegrity) {
    changes.integrityRepairs = repairIntegrity(save, player, settings, master);
  }

  if (options.rewards) {
    changes.knownSpecials = appendMissing(
      requireArray(player, "KnownSpecials"),
      master.knownSpecials,
    );
    changes.accountSpecials = appendMissing(
      requireArray(settings, "UnlockedSpecials"),
      master.knownSpecials,
    );
    changes.seasonRewards = appendMissing(
      requireArray(settings, "UnlockedSeasonRewards"),
      master.seasonRewards,
    );
    changes.twitchRewards = appendMissing(
      requireArray(settings, "UnlockedTwitchRewards"),
      master.twitchRewards,
    );
    changes.redeemedSeasonRewards = appendMissing(
      requireArray(player, "RedeemedSeasonRewards"),
      master.seasonRewards,
    );
    changes.redeemedTwitchRewards = appendMissing(
      requireArray(player, "RedeemedTwitchRewards"),
      master.twitchRewards,
    );
    changes.titles = appendMissing(
      requireArray(settings, "UnlockedTitles"),
      master.titles,
    );
  }

  if (options.licensedEntitlements) {
    changes.platformRewards = appendMissing(
      requireArray(settings, "UnlockedPlatformRewards"),
      master.platformRewards,
    );
    changes.contentEntitlements = appendMissing(
      requireArray(settings, "UnlockedPlatformRewards"),
      master.contentEntitlements,
    );
  }

  if (options.blueprints) {
    changes.removedDisallowedKnownTechnologies = removeListed(
      requireArray(player, "KnownTech"),
      master.disallowedKnownTechnologies,
    );
    changes.knownProducts = appendMissing(
      requireArray(player, "KnownProducts"),
      master.knownProducts,
    );
    changes.knownTechnologies = appendMissing(
      requireArray(player, "KnownTech"),
      master.knownTechnologies,
    );
    changes.refinerRecipes = appendMissing(
      requireArray(player, "KnownRefinerRecipes"),
      master.refinerRecipes,
    );
  }

  if (options.languageAndSlots) {
    changes.wordGroups = mergeWordGroups(
      requireArray(player, "KnownWordGroups"),
      master.wordGroups,
    );
    changes.portalRunes = player.KnownPortalRunes === 65_535 ? 0 : 1;
    changes.petSlots = requireArray(player, "UnlockedPetSlots").filter(
      (value) => !value,
    ).length;
    changes.squadronSlots = requireArray(
      player,
      "SquadronUnlockedPilotSlots",
    ).filter((value) => !value).length;
    player.KnownPortalRunes = 65_535;
    player.UnlockedPetSlots = requireArray(player, "UnlockedPetSlots").map(
      () => true,
    );
    player.SquadronUnlockedPilotSlots = requireArray(
      player,
      "SquadronUnlockedPilotSlots",
    ).map(() => true);
  }

  if (options.catalogue) {
    changes.wikiTopicsSeen = appendMissing(
      requireArray(settings, "SeenWikiTopics"),
      master.wikiTopics,
    );
    changes.wikiTopicsUnlocked = appendMissing(
      requireArray(settings, "UnlockedWikiTopics"),
      master.wikiTopics,
    );
    changes.seenSubstances = appendMissing(
      requireArray(settings, "SeenSubstances"),
      master.seenSubstances,
    );
    changes.seenTechnologies = appendMissing(
      requireArray(settings, "SeenTechnologies"),
      withoutListed(
        requireArray(player, "KnownTech"),
        master.disallowedKnownTechnologies,
      ),
    );
    changes.seenKnownProducts = appendMissing(
      requireArray(settings, "SeenProducts"),
      [
        ...withoutListed(
          requireArray(player, "KnownProducts"),
          master.contextualKnownProducts ?? [],
        ),
        ...requireArray(player, "KnownSpecials"),
      ],
    );
    changes.fossilRecords = appendMissing(
      requireArray(settings, "SeenProducts"),
      master.fossilRecords,
    );
    changes.fishingRecords =
      completeFishingRecords(player, master).changed;
    changes.baseBuildingRecords = appendMissing(
      requireArray(player, "SeenBaseBuildingObjects"),
      master.seenBaseBuildingObjects,
    );
    changes.storyRecords = completeStoryRecords(player, master).changed;
    changes.anomalousBasePartRecords =
      completeAnomalousBasePartRecords(player, master).changed;
  }

  if (options.naturalProgression) {
    changes.naturalProgression = applyNaturalProgression(player, master).changed;
  }

  if (options.progressionConveniences) {
    changes.progressionConveniences = [
      "RevealBlackHoles",
      "HasAccessToNexus",
      "BuildersKnown",
      "HasDiscoveredPurpleSystems",
    ].filter((field) => player[field] !== true).length;
    player.RevealBlackHoles = true;
    player.HasAccessToNexus = true;
    player.BuildersKnown = true;
    player.HasDiscoveredPurpleSystems = true;
  }

  const ownershipChanges = normalizeOwnership(save, ownership, contextPreference);
  if (ownershipChanges.enabled) changes.ownershipChanges = ownershipChanges.totalChanges;
  const after = analyzeCompletion(save, account, master, contextPreference);
  return {
    save,
    account,
    report: {
      toolVersion: master.toolVersion,
      baseline: master.gameBaseline,
      dataPackage: master.activePackage,
      context: {
        key: context.key,
        type: context.type,
        label: context.label,
        activeTag: context.activeTag,
        seasonNumber: context.seasonNumber,
      },
      options,
      before,
      after,
      additions: Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [
          key,
          typeof value === "number"
            ? value
            : Array.isArray(value)
            ? value.length
            : { added: value.added.length, expanded: value.expanded.length },
        ]),
      ),
      ownership: ownershipChanges,
    },
  };
}

export function completeUnlocks(
  inputSave,
  inputAccount,
  master,
  selectedOptions = {},
  ownership = { enabled: false },
  contextPreference = "active",
  execution = {},
) {
  return runCompletion(
    cloneJson(inputSave),
    cloneJson(inputAccount),
    master,
    selectedOptions,
    ownership,
    contextPreference,
    execution.beforeAnalysis,
  );
}

// Takes ownership of a newly prepared save to avoid copying the same large tree twice.
export function completePreparedUnlocks(
  preparedSave,
  inputAccount,
  master,
  selectedOptions = {},
  ownership = { enabled: false },
  contextPreference = "active",
  execution = {},
) {
  return runCompletion(
    preparedSave,
    cloneJson(inputAccount),
    master,
    selectedOptions,
    ownership,
    contextPreference,
    execution.beforeAnalysis,
  );
}

export function verifyCompletion(
  save,
  account,
  master,
  options = DEFAULT_OPTIONS,
  contextPreference = "active",
) {
  const { player, settings } = getState(save, account, contextPreference);
  const failures = [];

  function requireSubset(label, masterList, actualList, key = (item) => item) {
    const actual = new Set(actualList.map(key));
    const missing = masterList.filter((item) => !actual.has(key(item)));
    if (missing.length) failures.push(`${label}: ${missing.length} missing`);
  }

  function requireAbsent(label, blockedList, actualList) {
    const actual = new Set(actualList);
    const present = blockedList.filter((item) => actual.has(item));
    if (present.length) failures.push(`${label}: ${present.length} present`);
  }

  if (options.rewards) {
    requireSubset("known specials", master.knownSpecials, player.KnownSpecials);
    requireSubset("account specials", master.knownSpecials, settings.UnlockedSpecials);
    requireSubset("season rewards", master.seasonRewards, settings.UnlockedSeasonRewards);
    requireSubset("Twitch rewards", master.twitchRewards, settings.UnlockedTwitchRewards);
    requireSubset("titles", master.titles, settings.UnlockedTitles);
    requireSubset(
      "redeemed season rewards",
      master.seasonRewards,
      player.RedeemedSeasonRewards,
    );
    requireSubset(
      "redeemed Twitch rewards",
      master.twitchRewards,
      player.RedeemedTwitchRewards,
    );
  }
  if (options.licensedEntitlements) {
    requireSubset(
      "TGA and Switch rewards",
      master.platformRewards,
      settings.UnlockedPlatformRewards,
    );
    requireSubset(
      "content entitlements",
      master.contentEntitlements,
      settings.UnlockedPlatformRewards,
    );
  }
  if (options.blueprints) {
    requireSubset("known products", master.knownProducts, player.KnownProducts);
    requireSubset("known technologies", master.knownTechnologies, player.KnownTech);
    requireAbsent(
      "disallowed known technologies",
      master.disallowedKnownTechnologies,
      player.KnownTech,
    );
    requireSubset(
      "refiner recipes",
      master.refinerRecipes,
      player.KnownRefinerRecipes,
    );
  }
  if (options.languageAndSlots) {
    requireSubset(
      "word groups",
      master.wordGroups,
      player.KnownWordGroups,
      (item) => item.Group,
    );
    if (player.KnownPortalRunes !== 65_535) failures.push("portal runes incomplete");
    if (!player.UnlockedPetSlots.every(Boolean)) failures.push("pet slots incomplete");
    if (!player.SquadronUnlockedPilotSlots.every(Boolean)) {
      failures.push("squadron slots incomplete");
    }
  }
  if (options.catalogue) {
    requireSubset("wiki topics", master.wikiTopics, settings.UnlockedWikiTopics);
    requireSubset("seen substances", master.seenSubstances, settings.SeenSubstances);
    requireSubset(
      "seen technologies",
      withoutListed(player.KnownTech, master.disallowedKnownTechnologies),
      settings.SeenTechnologies,
    );
    requireSubset(
      "seen products",
      [
        ...withoutListed(
          player.KnownProducts,
          master.contextualKnownProducts ?? [],
        ),
        ...player.KnownSpecials,
      ],
      settings.SeenProducts,
    );
    requireSubset("fossil records", master.fossilRecords, settings.SeenProducts);
    const fishing = analyzeFishingRecords(player, master);
    if (fishing.pending) {
      failures.push(`${fishing.pending} fishing species records incomplete`);
    }
    requireSubset(
      "base-building menu records",
      master.seenBaseBuildingObjects,
      player.SeenBaseBuildingObjects,
    );
    const stories = analyzeStoryRecords(player, master);
    if (stories.pending) {
      failures.push(`${stories.pending} catalogue story-page records incomplete`);
    }
    const anomalousBaseParts = analyzeAnomalousBasePartRecords(player, master);
    if (anomalousBaseParts.pending) {
      failures.push(
        `${anomalousBaseParts.pending} stabilised reality-glitch records incomplete`,
      );
    }
  }
  if (options.naturalProgression) {
    const progression = analyzeNaturalProgression(player, master);
    if (progression.pending) {
      failures.push(`${progression.pending} natural milestone or standing values incomplete`);
    }
  }
  if (options.progressionConveniences) {
    for (const field of [
      "RevealBlackHoles",
      "HasAccessToNexus",
      "BuildersKnown",
      "HasDiscoveredPurpleSystems",
    ]) {
      if (player[field] !== true) failures.push(`${field} is not enabled`);
    }
  }
  if (options.repairIntegrity) {
    const integrity = analyzeIntegrity(save, player, settings, master);
    if (integrity.repairableIssues) {
      failures.push(`${integrity.repairableIssues} integrity issues remain`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function canonicalNmsName(name) {
  return name.replace(/\s*\(\d+\)(?=\.hg$)/i, "");
}

export function classifyNmsFilename(name) {
  const canonical = canonicalNmsName(name).toLowerCase();
  if (canonical === "accountdata.hg") return "account";
  if (canonical === "mf_accountdata.hg") return "accountMeta";
  if (/^save(?:\d+)?\.hg$/.test(canonical)) return "save";
  if (/^mf_save(?:\d+)?\.hg$/.test(canonical)) return "saveMeta";
  return null;
}

export function expectedSlotFromSaveName(name) {
  const canonical = canonicalNmsName(name);
  if (canonical.toLowerCase() === "save.hg") return 2;
  const match = /^save(\d+)\.hg$/i.exec(canonical);
  return match ? Number(match[1]) + 1 : null;
}

export function validateFileSet(fileRecords) {
  const byKind = {};
  for (const record of fileRecords) {
    const kind = classifyNmsFilename(record.name);
    if (!kind) continue;
    if (byKind[kind]) {
      throw new Error(`More than one ${kind} file was selected.`);
    }
    byKind[kind] = record;
  }
  for (const kind of ["save", "saveMeta", "account", "accountMeta"]) {
    if (!byKind[kind]) throw new Error(`Missing required ${kind} file.`);
  }
  const saveName = canonicalNmsName(byKind.save.name);
  const metaName = canonicalNmsName(byKind.saveMeta.name);
  if (metaName.toLowerCase() !== `mf_${saveName}`.toLowerCase()) {
    throw new Error(`${metaName} does not match ${saveName}.`);
  }
  return byKind;
}
