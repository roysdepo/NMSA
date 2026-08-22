const STORAGE_KEY = "atlas-complete-active-data-package-v1";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function uniqueCount(values, key = (value) => value) {
  return new Set(values.map(key)).size;
}

function hasSameStringMembers(values, expected) {
  return values.length === expected.size && values.every((value) => expected.has(value));
}

const REQUIRED_CLASSIFICATION_ARRAYS = Object.freeze([
  "contextualKnownProducts",
  "authoritativeCatalogueRecordProducts",
  "authoritativeCatalogueOnlyProductRecords",
  "speculativeShipComponentRecords",
]);

const REQUIRED_CONTEXTUAL_FAMILIES = Object.freeze({
  contextualKnownProducts: "preserve-context",
  platformRewards: "licensed-opt-in",
  contentEntitlements: "licensed-opt-in",
  disallowedSeenTechnologies: "preserve-observed",
  speculativeShipComponentRecords: "diagnostic-only",
  naturalProgressionTargets: "explicit-opt-in",
});

export function validateDataPayload(payload) {
  if (!payload || typeof payload !== "object" || payload.schemaVersion !== 7) {
    throw new Error("Unsupported NMSA data payload schema.");
  }
  const arrayFields = [
    "knownProducts",
    "contextualKnownProducts",
    "knownSpecials",
    "knownTechnologies",
    "disallowedKnownTechnologies",
    "disallowedSeenTechnologies",
    "refinerRecipes",
    "wordGroups",
    "seasonRewards",
    "twitchRewards",
    "platformRewards",
    "contentEntitlements",
    "titles",
    "seenSubstances",
    "wikiTopics",
    "fossilBlueprintRecords",
    "fossilComponentRecords",
    "fossilRecords",
    "shipComponentRecords",
    "speculativeShipComponentRecords",
    "catalogueRecordProducts",
    "catalogueOnlyProductRecords",
    "authoritativeCatalogueRecordProducts",
    "authoritativeCatalogueOnlyProductRecords",
    "fishingRecords",
    "anomalousBasePartRecords",
    "seenBaseBuildingObjects",
    "storyRecords",
    "recordFamilies",
    "naturalNegativeStatAllowlist",
  ];
  for (const field of arrayFields) {
    const values = payload[field];
    if (!Array.isArray(values) || !values.length) {
      throw new Error(`Data package is missing ${field}.`);
    }
    const key =
      field === "wordGroups"
        ? (item) => item.Group
        : field === "fishingRecords"
          ? (item) => item.productId
          : field === "storyRecords"
            ? (item) => `${item.categoryIndex}:${item.pageIndex}`
          : field === "recordFamilies"
            ? (item) => item.key
            : undefined;
    const count = uniqueCount(values, key);
    if (count !== values.length) throw new Error(`Data package ${field} contains duplicates.`);
    if (field === "wordGroups") {
      if (
        values.some(
          (item) =>
            !item ||
            typeof item.Group !== "string" ||
            !item.Group.startsWith("^") ||
            !Array.isArray(item.Races) ||
            item.Races.some((value) => typeof value !== "boolean"),
        )
      ) {
        throw new Error("Data package contains an invalid word group.");
      }
    } else if (field === "fishingRecords") {
      if (
        values.some(
          (item) =>
            typeof item?.productId !== "string" ||
            !item.productId.startsWith("^") ||
            !["Small", "Medium", "Large", "ExtraLarge"].includes(item.size) ||
            !Number.isFinite(item.largestCatch) ||
            item.largestCatch <= 0 ||
            !Number.isFinite(item.standardDeviation) ||
            item.standardDeviation <= 0 ||
            !Number.isFinite(item.maximumPlausibleCatch) ||
            item.maximumPlausibleCatch <= item.largestCatch ||
            !Number.isInteger(item.count) ||
            item.count < 1,
        )
      ) {
        throw new Error("Data package contains an invalid fishing record.");
      }
    } else if (field === "storyRecords") {
      if (
        values.some(
          (item) =>
            !Number.isInteger(item?.categoryIndex) ||
            item.categoryIndex < 0 ||
            item.categoryIndex > 8 ||
            !Number.isInteger(item.pageIndex) ||
            item.pageIndex < 0 ||
            typeof item.pageId !== "string" ||
            !item.pageId ||
            !["sequential-index", "bitmask", "grid-page"].includes(
              item.completionMode,
            ) ||
            !Number.isInteger(item.entryCount) ||
            item.entryCount < 1 ||
            !Number.isInteger(item.targetValue) ||
            item.targetValue < 0,
        )
      ) {
        throw new Error("Data package contains an invalid story-page record.");
      }
    } else if (field === "recordFamilies") {
      if (
        values.some(
          (item) =>
            typeof item?.key !== "string" ||
            typeof item.label !== "string" ||
            typeof item.storage !== "string" ||
            !Number.isInteger(item.count) ||
            item.count < 1 ||
            !Array.isArray(payload[item.key]) ||
            payload[item.key].length !== item.count,
        )
      ) {
        throw new Error("Data package contains an invalid record-family manifest.");
      }
    } else if (values.some((item) => typeof item !== "string" || !item.startsWith("^"))) {
      throw new Error(`Data package ${field} contains an invalid identifier.`);
    }
    const expected = payload.sourceCounts?.[field];
    if (expected !== undefined && expected !== values.length) {
      throw new Error(`Data package ${field} count does not match its manifest.`);
    }
  }
  // Early schema-7 packages did not carry these classifications. Never infer
  // them from the broad legacy arrays: that would promote contextual or
  // grammar-generated identifiers into core completion requirements.
  for (const field of REQUIRED_CLASSIFICATION_ARRAYS) {
    const expected = payload.sourceCounts?.[field];
    if (!Number.isInteger(expected) || expected !== payload[field].length) {
      throw new Error(
        `Data package ${field} classification count is missing or invalid.`,
      );
    }
  }
  const knownProductIds = new Set(payload.knownProducts);
  const contextualKnownProductIds = new Set(payload.contextualKnownProducts);
  const disallowedKnownTechnologyIds = new Set(payload.disallowedKnownTechnologies);
  const disallowedSeenTechnologyIds = new Set(payload.disallowedSeenTechnologies);
  const fossilBlueprintIds = new Set(payload.fossilBlueprintRecords);
  const fossilComponentIds = new Set(payload.fossilComponentRecords);
  if (
    payload.knownProducts.some((item) => contextualKnownProductIds.has(item))
  ) {
    throw new Error("Data package core and contextual known-product lists overlap.");
  }
  if (
    payload.knownTechnologies.some((item) => disallowedKnownTechnologyIds.has(item))
  ) {
    throw new Error("Data package technology allow/block lists overlap.");
  }
  if (
    payload.disallowedKnownTechnologies.length !==
      payload.disallowedSeenTechnologies.length ||
    payload.disallowedKnownTechnologies.some(
      (item) => !disallowedSeenTechnologyIds.has(item),
    )
  ) {
    throw new Error("Data package learned/seen technology blocklists differ.");
  }
  if (
    uniqueCount([
      ...payload.fossilBlueprintRecords,
      ...payload.fossilComponentRecords,
    ]) !== payload.fossilRecords.length ||
    payload.fossilRecords.some(
      (item) => !fossilBlueprintIds.has(item) && !fossilComponentIds.has(item),
    )
  ) {
    throw new Error("Data package fossil record families do not match.");
  }
  const authoritativeCatalogueRecordIds = new Set(
    payload.authoritativeCatalogueRecordProducts,
  );
  const authoritativeCatalogueOnlyIds = new Set(
    payload.authoritativeCatalogueOnlyProductRecords,
  );
  const speculativeShipComponentIds = new Set(
    payload.speculativeShipComponentRecords,
  );
  if (
    !hasSameStringMembers(
      payload.authoritativeCatalogueRecordProducts,
      new Set(payload.fossilRecords),
    ) ||
    !hasSameStringMembers(
      payload.authoritativeCatalogueOnlyProductRecords,
      fossilComponentIds,
    )
  ) {
    throw new Error("Data package authoritative catalogue classifications do not match.");
  }
  if (
    !hasSameStringMembers(
      payload.speculativeShipComponentRecords,
      new Set(payload.shipComponentRecords),
    )
  ) {
    throw new Error("Data package speculative catalogue classification does not match.");
  }
  if (
    payload.authoritativeCatalogueRecordProducts.some((item) =>
      speculativeShipComponentIds.has(item),
    ) ||
    payload.authoritativeCatalogueOnlyProductRecords.some((item) =>
      speculativeShipComponentIds.has(item),
    )
  ) {
    throw new Error("Data package authoritative and speculative catalogue lists overlap.");
  }
  const completeCatalogueRecordIds = new Set([
    ...authoritativeCatalogueRecordIds,
    ...speculativeShipComponentIds,
  ]);
  const completeCatalogueOnlyIds = new Set([
    ...authoritativeCatalogueOnlyIds,
    ...speculativeShipComponentIds,
  ]);
  if (
    !hasSameStringMembers(
      payload.catalogueRecordProducts,
      completeCatalogueRecordIds,
    )
  ) {
    throw new Error("Data package catalogue record families do not match.");
  }
  if (
    !hasSameStringMembers(
      payload.catalogueOnlyProductRecords,
      completeCatalogueOnlyIds,
    )
  ) {
    throw new Error("Data package catalogue-only record families do not match.");
  }
  if (
    payload.fishingRecords.some(
      (record) => !knownProductIds.has(record.productId),
    )
  ) {
    throw new Error("Data package fishing records contain a non-product ID.");
  }
  if (
    payload.anomalousBasePartRecords.some(
      (record) => !knownProductIds.has(record),
    )
  ) {
    throw new Error(
      "Data package reality-glitch records contain a non-product ID.",
    );
  }
  if (!Array.isArray(payload.completionCoverage?.contextualFamilies)) {
    throw new Error("Data package completionCoverage.contextualFamilies is missing.");
  }
  if (
    !payload.completionCoverage ||
    payload.completionCoverage.schemaVersion !== 1 ||
    !Array.isArray(payload.completionCoverage.finiteFamilies) ||
    !Array.isArray(payload.completionCoverage.dynamicFiniteFamilies) ||
    !Array.isArray(payload.completionCoverage.preservedProceduralFamilies) ||
    !Array.isArray(payload.completionCoverage.definitionOnlyFamilies) ||
    !Array.isArray(payload.completionCoverage.preservedStateFamilies) ||
    !Array.isArray(payload.completionCoverage.excludedInternalFamilies) ||
    payload.completionCoverage.finiteFamilies.some(
      (family) =>
        typeof family?.key !== "string" ||
        typeof family.storage !== "string" ||
        typeof family.mode !== "string" ||
        !Array.isArray(payload[family.key]) ||
        !payload[family.key].length,
    ) ||
    payload.completionCoverage.definitionOnlyFamilies.some(
      (family) =>
        typeof family?.key !== "string" ||
        !Number.isInteger(family.currentRows) ||
        family.currentRows < 1 ||
        typeof family.reason !== "string" ||
        !family.reason,
    )
  ) {
    throw new Error("Data package completion coverage ledger is incomplete.");
  }
  const contextualFamilies = payload.completionCoverage.contextualFamilies;
  if (!contextualFamilies.length) {
    throw new Error("Data package contextualFamilies ledger is missing.");
  }
  if (
    uniqueCount(contextualFamilies, (family) => family?.key) !==
      contextualFamilies.length ||
    contextualFamilies.some(
      (family) =>
        typeof family?.key !== "string" ||
        typeof family.storage !== "string" ||
        !family.storage ||
        typeof family.mode !== "string" ||
        !family.mode ||
        typeof family.reason !== "string" ||
        !family.reason ||
        !Array.isArray(payload[family.key]) ||
        !payload[family.key].length,
    )
  ) {
    throw new Error("Data package contextualFamilies ledger is invalid.");
  }
  const contextualFamilyByKey = new Map(
    contextualFamilies.map((family) => [family.key, family]),
  );
  for (const [key, mode] of Object.entries(REQUIRED_CONTEXTUAL_FAMILIES)) {
    if (contextualFamilyByKey.get(key)?.mode !== mode) {
      throw new Error(
        `Data package contextualFamilies is missing the ${key} ${mode} classification.`,
      );
    }
  }
  const finiteFamilyKeys = new Set(
    payload.completionCoverage.finiteFamilies.map((family) => family.key),
  );
  if (contextualFamilies.some((family) => finiteFamilyKeys.has(family.key))) {
    throw new Error("Data package finite and contextual completion families overlap.");
  }
  if (
    payload.seenBaseBuildingObjects.some(
      (record) => !knownProductIds.has(record),
    )
  ) {
    throw new Error(
      "Data package base-building records contain a non-product ID.",
    );
  }
  if (
    payload.baseBuildingRecordSource?.sourceGameTable !==
      "METADATA/REALITY/TABLES/BASEBUILDINGOBJECTSTABLE.MBIN" ||
    !/^[a-f0-9]{64}$/.test(
      payload.baseBuildingRecordSource?.sourceTableSha256 ?? "",
    ) ||
    !payload.baseBuildingRecordSource?.extractionRule
  ) {
    throw new Error("Data package base-building record provenance is missing.");
  }
  if (
    payload.storyRecordSource?.sourceGameTable !==
      "METADATA/REALITY/TABLES/STORIESTABLE.MBIN" ||
    !/^[a-f0-9]{64}$/.test(
      payload.storyRecordSource?.sourceTableSha256 ?? "",
    ) ||
    !payload.storyRecordSource?.extractionRule ||
    payload.storyRecordSource.staticEntryCount !== 592 ||
    payload.storyRecordSource.displayedEntryCount !== 598
  ) {
    throw new Error("Data package story-record provenance is missing or invalid.");
  }
  const contentEntitlementIds = new Set(payload.contentEntitlements);
  if (payload.platformRewards.some((item) => contentEntitlementIds.has(item))) {
    throw new Error("Data package storefront and content entitlement lists overlap.");
  }
  const progressionTargets = payload.naturalProgressionTargets;
  const allowedSources = new Set([
    "knownWordGroups",
    "raceWords0",
    "raceWords1",
    "raceWords2",
  ]);
  if (!Array.isArray(progressionTargets) || !progressionTargets.length) {
    throw new Error("Data package is missing naturalProgressionTargets.");
  }
  if (uniqueCount(progressionTargets, (item) => item?.id) !== progressionTargets.length) {
    throw new Error("Data package naturalProgressionTargets contains duplicates.");
  }
  const progressionTargetIds = new Set(progressionTargets.map((item) => item?.id));
  if (
    progressionTargets.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        !item.id.startsWith("^") ||
        typeof item.label !== "string" ||
        !item.label ||
        typeof item.category !== "string" ||
        !item.category ||
        !["int", "float"].includes(item.storage) ||
        !(
          (Number.isInteger(item.target) && item.target >= 0) ||
          allowedSources.has(item.source)
        ),
    )
  ) {
    throw new Error("Data package contains an invalid natural progression target.");
  }
  const statRepairs = payload.naturalStatRepairs;
  if (!Array.isArray(statRepairs) || !statRepairs.length) {
    throw new Error("Data package is missing naturalStatRepairs.");
  }
  if (uniqueCount(statRepairs, (item) => item?.id) !== statRepairs.length) {
    throw new Error("Data package naturalStatRepairs contains duplicates.");
  }
  if (
    statRepairs.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        !item.id.startsWith("^") ||
        typeof item.label !== "string" ||
        !item.label ||
        !["int", "float"].includes(item.storage) ||
        !Number.isInteger(item.target) ||
        item.target < 0,
    )
  ) {
    throw new Error("Data package contains an invalid natural stat repair.");
  }
  if (
    statRepairs.some(
      (repair) => progressionTargetIds.has(repair.id),
    )
  ) {
    throw new Error("Data package ranked and repair-only stat lists overlap.");
  }
  const expectedProgressionCount = payload.sourceCounts?.naturalProgressionTargets;
  if (
    expectedProgressionCount !== undefined &&
    expectedProgressionCount !== progressionTargets.length
  ) {
    throw new Error(
      "Data package naturalProgressionTargets count does not match its manifest.",
    );
  }
  const expectedRepairCount = payload.sourceCounts?.naturalStatRepairs;
  if (
    expectedRepairCount !== undefined &&
    expectedRepairCount !== statRepairs.length
  ) {
    throw new Error(
      "Data package naturalStatRepairs count does not match its manifest.",
    );
  }
  if (payload.sourceCounts?.titleBackedStatFamilies !== 78) {
    throw new Error(
      "Data package title-backed statistic family count is invalid.",
    );
  }
  if (!payload.saveMap || !payload.accountMap) {
    throw new Error("Data package is missing JSON mappings.");
  }
  for (const [label, mapping] of [["save", payload.saveMap], ["account", payload.accountMap]]) {
    if (
      !mapping ||
      typeof mapping !== "object" ||
      Array.isArray(mapping) ||
      !Object.keys(mapping).length ||
      Object.entries(mapping).some(
        ([key, value]) => !key || typeof value !== "string" || !value,
      )
    ) {
      throw new Error(`Data package has an invalid ${label} JSON mapping.`);
    }
  }
  if (!Array.isArray(payload.writableSaveFormats) || !Array.isArray(payload.knownSaveFormats)) {
    throw new Error("Data package is missing compatibility rules.");
  }
  if (
    !Number.isInteger(payload.minimumWritableGameVersion) ||
    !Number.isInteger(payload.testedGameVersion) ||
    payload.minimumWritableGameVersion > payload.testedGameVersion
  ) {
    throw new Error("Data package has an invalid verified write-version range.");
  }
  const knownSaveFormats = new Set(payload.knownSaveFormats);
  if (payload.writableSaveFormats.some((format) => !knownSaveFormats.has(format))) {
    throw new Error("Data package marks an unknown save format as writable.");
  }
  const supportedAdapters = new Set([
    "steam",
    "gog",
    "xbox-game-pass",
    "playstation-extracted",
    "switch-extracted",
  ]);
  if (
    !Array.isArray(payload.platformAdapters) ||
    !payload.platformAdapters.length ||
    payload.platformAdapters.some((adapter) => !supportedAdapters.has(adapter))
  ) {
    throw new Error("Data package declares an unsupported platform adapter.");
  }
  return payload;
}

export async function parseDataPackage(text) {
  const packageFile = JSON.parse(text);
  if (packageFile.packageSchema !== 1 || !packageFile.payload) {
    throw new Error("This is not a supported .atlaspack file.");
  }
  const canonical = JSON.stringify(stable(packageFile.payload));
  const actualHash = await sha256Text(canonical);
  if (actualHash !== String(packageFile.payloadSha256 || "").toLowerCase()) {
    throw new Error("Data package integrity check failed.");
  }
  validateDataPayload(packageFile.payload);
  return { packageFile, master: Object.freeze(packageFile.payload) };
}

export async function activateDataPackage(text, builtinMaster) {
  const parsed = await parseDataPackage(text);
  if (Number(parsed.master.testedGameVersion || 0) < Number(builtinMaster.testedGameVersion || 0)) {
    throw new Error("This data package is older than the built-in Atlas baseline.");
  }
  localStorage.setItem(STORAGE_KEY, text);
  return parsed.master;
}

export async function loadActiveDataPackage(builtinMaster) {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return { master: builtinMaster, source: "built-in", error: null };
  try {
    const { master } = await parseDataPackage(stored);
    if (Number(master.testedGameVersion || 0) < Number(builtinMaster.testedGameVersion || 0)) {
      localStorage.removeItem(STORAGE_KEY);
      return { master: builtinMaster, source: "built-in", error: "Stored data package was older than this app." };
    }
    return { master, source: "imported", error: null };
  } catch (error) {
    localStorage.removeItem(STORAGE_KEY);
    return {
      master: builtinMaster,
      source: "built-in",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function deactivateDataPackage() {
  localStorage.removeItem(STORAGE_KEY);
}
