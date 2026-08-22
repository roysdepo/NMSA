import master from "../src/data/index.js";

const requiredArrays = [
  "knownProducts",
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
  "catalogueRecordProducts",
  "catalogueOnlyProductRecords",
  "fishingRecords",
  "anomalousBasePartRecords",
  "seenBaseBuildingObjects",
  "storyRecords",
  "recordFamilies",
  "naturalNegativeStatAllowlist",
];

for (const key of requiredArrays) {
  const values = master[key];
  if (!Array.isArray(values) || !values.length) {
    throw new Error(`${key} is empty or missing`);
  }
  const identity =
    key === "wordGroups"
      ? (value) => value.Group
      : key === "fishingRecords"
        ? (value) => value.productId
        : key === "storyRecords"
          ? (value) => `${value.categoryIndex}:${value.pageIndex}`
        : key === "recordFamilies"
          ? (value) => value.key
          : (value) => value;
  if (new Set(values.map(identity)).size !== values.length) {
    throw new Error(`${key} contains duplicates`);
  }
  if (key === "wordGroups") {
    if (values.some((item) =>
      typeof item?.Group !== "string" ||
      !item.Group.startsWith("^") ||
      !Array.isArray(item.Races) ||
      item.Races.some((value) => typeof value !== "boolean")
    )) throw new Error(`${key} contains an invalid record`);
  } else if (key === "fishingRecords") {
    if (values.some((item) =>
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
      item.count < 1
    )) throw new Error(`${key} contains an invalid record`);
  } else if (key === "storyRecords") {
    if (values.some((item) =>
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
      item.targetValue < 0
    )) throw new Error(`${key} contains an invalid record`);
  } else if (key === "recordFamilies") {
    if (values.some((item) =>
      typeof item?.key !== "string" ||
      typeof item.label !== "string" ||
      typeof item.storage !== "string" ||
      !Number.isInteger(item.count) ||
      item.count < 1 ||
      !Array.isArray(master[item.key]) ||
      master[item.key].length !== item.count
    )) throw new Error(`${key} contains an invalid family manifest`);
  } else if (values.some((item) => typeof item !== "string" || !item.startsWith("^"))) {
    throw new Error(`${key} contains an invalid identifier`);
  }
  const expected = master.sourceCounts[key];
  if (expected !== undefined && values.length !== expected) {
    throw new Error(`${key}: expected ${expected}, found ${values.length}`);
  }
}

if (!master.writableSaveFormats.includes(master.saveFormat)) {
  throw new Error("default save format is not writable");
}
if (master.schemaVersion !== 7) {
  throw new Error("bundled payload schema must be 7");
}
const allowedProgressionSources = new Set([
  "knownWordGroups",
  "raceWords0",
  "raceWords1",
  "raceWords2",
]);
if (
  !Array.isArray(master.naturalProgressionTargets) ||
  !master.naturalProgressionTargets.length ||
  new Set(master.naturalProgressionTargets.map((item) => item?.id)).size !==
    master.naturalProgressionTargets.length ||
  master.naturalProgressionTargets.some(
    (item) =>
      typeof item?.id !== "string" ||
      !item.id.startsWith("^") ||
      typeof item.label !== "string" ||
      !item.label ||
      typeof item.category !== "string" ||
      !item.category ||
      !["int", "float"].includes(item.storage) ||
      !(
        (Number.isInteger(item.target) && item.target >= 0) ||
        allowedProgressionSources.has(item.source)
      ),
  )
) {
  throw new Error("natural progression targets are invalid");
}
if (
  master.naturalProgressionTargets.length !==
  master.sourceCounts.naturalProgressionTargets
) {
  throw new Error("natural progression target count does not match its manifest");
}
if (
  !Array.isArray(master.naturalStatRepairs) ||
  !master.naturalStatRepairs.length ||
  new Set(master.naturalStatRepairs.map((item) => item?.id)).size !==
    master.naturalStatRepairs.length ||
  master.naturalStatRepairs.some(
    (item) =>
      typeof item?.id !== "string" ||
      !item.id.startsWith("^") ||
      typeof item.label !== "string" ||
      !item.label ||
      !["int", "float"].includes(item.storage) ||
      !Number.isInteger(item.target) ||
      item.target < 0,
  )
) {
  throw new Error("natural stat repairs are invalid");
}
if (master.naturalStatRepairs.length !== master.sourceCounts.naturalStatRepairs) {
  throw new Error("natural stat repair count does not match its manifest");
}
if (master.sourceCounts.titleBackedStatFamilies !== 78) {
  throw new Error("title-backed statistic family count does not match its manifest");
}
if (
  master.knownTechnologies.some((item) =>
    master.disallowedKnownTechnologies.includes(item)
  )
) {
  throw new Error("technology allow/block lists overlap");
}
if (
  master.disallowedKnownTechnologies.length !==
    master.disallowedSeenTechnologies.length ||
  master.disallowedKnownTechnologies.some(
    (item) => !master.disallowedSeenTechnologies.includes(item),
  )
) {
  throw new Error("learned and seen technology blocklists differ");
}
if (
  new Set([
    ...master.fossilBlueprintRecords,
    ...master.fossilComponentRecords,
  ]).size !== master.fossilRecords.length ||
  master.fossilRecords.some(
    (item) =>
      !master.fossilBlueprintRecords.includes(item) &&
      !master.fossilComponentRecords.includes(item),
  )
) {
  throw new Error("fossil record families do not form the 165-record set");
}
if (
  new Set([
    ...master.fossilRecords,
    ...master.shipComponentRecords,
  ]).size !== master.catalogueRecordProducts.length
) {
  throw new Error("catalogue record product families do not match");
}
if (
  new Set([
    ...master.fossilComponentRecords,
    ...master.shipComponentRecords,
  ]).size !== master.catalogueOnlyProductRecords.length
) {
  throw new Error("catalogue-only product record families do not match");
}
if (
  master.fishingRecords.some(
    (record) => !master.knownProducts.includes(record.productId),
  )
) {
  throw new Error("fishing records contain a non-product identifier");
}
if (
  master.anomalousBasePartRecords.some(
    (record) => !master.knownProducts.includes(record),
  )
) {
  throw new Error("reality-glitch records contain a non-product identifier");
}
if (
  !master.completionCoverage ||
  master.completionCoverage.schemaVersion !== 1 ||
  !Array.isArray(master.completionCoverage.finiteFamilies) ||
  !Array.isArray(master.completionCoverage.dynamicFiniteFamilies) ||
  !Array.isArray(master.completionCoverage.preservedProceduralFamilies) ||
  !Array.isArray(master.completionCoverage.definitionOnlyFamilies) ||
  !Array.isArray(master.completionCoverage.preservedStateFamilies) ||
  !Array.isArray(master.completionCoverage.excludedInternalFamilies) ||
  master.completionCoverage.finiteFamilies.some(
    (family) =>
      typeof family?.key !== "string" ||
      typeof family.storage !== "string" ||
      typeof family.mode !== "string" ||
      !Array.isArray(master[family.key]) ||
      !master[family.key].length,
  ) ||
  master.completionCoverage.definitionOnlyFamilies.some(
    (family) =>
      typeof family?.key !== "string" ||
      !Number.isInteger(family.currentRows) ||
      family.currentRows < 1 ||
      typeof family.reason !== "string" ||
      !family.reason,
  )
) {
  throw new Error("completion coverage ledger is missing or incomplete");
}
if (
  master.seenBaseBuildingObjects.some(
    (record) => !master.knownProducts.includes(record),
  )
) {
  throw new Error("base-building records contain a non-product identifier");
}
if (
  master.baseBuildingRecordSource?.sourceGameTable !==
    "METADATA/REALITY/TABLES/BASEBUILDINGOBJECTSTABLE.MBIN" ||
  !/^[a-f0-9]{64}$/.test(
    master.baseBuildingRecordSource?.sourceTableSha256 ?? "",
  ) ||
  !master.baseBuildingRecordSource?.extractionRule
) {
  throw new Error("base-building record provenance is missing");
}
if (
  master.storyRecordSource?.sourceGameTable !==
    "METADATA/REALITY/TABLES/STORIESTABLE.MBIN" ||
  !/^[a-f0-9]{64}$/.test(
    master.storyRecordSource?.sourceTableSha256 ?? "",
  ) ||
  !master.storyRecordSource?.extractionRule ||
  master.storyRecordSource.staticEntryCount !== 592 ||
  master.storyRecordSource.displayedEntryCount !== 598
) {
  throw new Error("story-record provenance is missing or invalid");
}
if (
  master.platformRewards.some((item) =>
    master.contentEntitlements.includes(item)
  )
) {
  throw new Error("storefront and content entitlement lists overlap");
}
if (
  !Number.isInteger(master.minimumWritableGameVersion) ||
  master.minimumWritableGameVersion > master.testedGameVersion
) {
  throw new Error("invalid writable game-version range");
}
if (!Object.keys(master.saveMap).length || !Object.keys(master.accountMap).length) {
  throw new Error("mapping databases are empty");
}

console.log(`validated NMSA data package ${master.activePackage}`);
