import catalogue from "./catalogue.json" with { type: "json" };
import baseBuildingRecords from "./base-building-records.json" with { type: "json" };
import compatibility from "./compatibility.json" with { type: "json" };
import completionCoverage from "./completion-coverage.json" with { type: "json" };
import mappings from "./mappings.json" with { type: "json" };
import products from "./products.json" with { type: "json" };
import progression from "./progression.json" with { type: "json" };
import recipes from "./recipes.json" with { type: "json" };
import rewards from "./rewards.json" with { type: "json" };
import storyRecords from "./story-records.json" with { type: "json" };
import technologies from "./technologies.json" with { type: "json" };
import titles from "./titles.json" with { type: "json" };
import words from "./words.json" with { type: "json" };
import {
  anomalousBasePartRecords,
  authoritativeCatalogueOnlyProductRecords,
  authoritativeCatalogueRecordProducts,
  catalogueOnlyProductRecords,
  catalogueRecordProducts,
  disallowedTechnologies,
  fishingRecords,
  fossilBlueprintRecords,
  fossilComponentRecords,
  fossilRecords,
  recordFamilies,
  speculativeShipComponentRecords,
  supplementalWordGroups,
} from "./record-generators.js";

const master = Object.freeze({
  ...compatibility,
  toolVersion: compatibility.toolVersion,
  saveFormat: compatibility.writableSaveFormats[0],
  ...mappings,
  ...products,
  ...progression,
  ...technologies,
  ...recipes,
  ...words,
  ...rewards,
  ...titles,
  ...catalogue,
  wordGroups: Object.freeze([
    ...words.wordGroups,
    ...supplementalWordGroups,
  ]),
  disallowedKnownTechnologies: disallowedTechnologies,
  disallowedSeenTechnologies: disallowedTechnologies,
  fossilBlueprintRecords,
  fossilComponentRecords,
  fossilRecords,
  // Backward-compatible diagnostic alias. These grammar-derived identifiers are
  // intentionally excluded from catalogueRecordProducts and completion health.
  shipComponentRecords: speculativeShipComponentRecords,
  speculativeShipComponentRecords,
  anomalousBasePartRecords,
  authoritativeCatalogueOnlyProductRecords,
  authoritativeCatalogueRecordProducts,
  catalogueRecordProducts,
  catalogueOnlyProductRecords,
  fishingRecords,
  seenBaseBuildingObjects: Object.freeze(
    baseBuildingRecords.seenBaseBuildingObjects,
  ),
  baseBuildingRecordSource: Object.freeze({
    sourceGameTable: baseBuildingRecords.sourceGameTable,
    sourceTableSha256: baseBuildingRecords.sourceTableSha256,
    extractionRule: baseBuildingRecords.extractionRule,
  }),
  storyRecords: Object.freeze(storyRecords.storyRecords),
  storyRecordSource: Object.freeze({
    sourceGameTable: storyRecords.sourceGameTable,
    sourceTableSha256: storyRecords.sourceTableSha256,
    extractionRule: storyRecords.extractionRule,
    staticEntryCount: storyRecords.staticEntryCount,
    displayedEntryCount: storyRecords.displayedEntryCount,
  }),
  completionCoverage: Object.freeze(completionCoverage),
  recordFamilies: Object.freeze([
    ...recordFamilies,
    {
      key: "seenBaseBuildingObjects",
      label: "Base-building menu records",
      storage: "PlayerStateData.SeenBaseBuildingObjects",
      count: baseBuildingRecords.seenBaseBuildingObjects.length,
    },
    {
      key: "storyRecords",
      label: "Catalogue story-page records",
      storage: "PlayerStateData.SeenStories",
      count: storyRecords.storyRecords.length,
    },
  ]),
  schemaVersion: 7,
});

export default master;
