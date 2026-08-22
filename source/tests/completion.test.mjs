import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "lossless-json";
import master from "../src/data/index.js";
import { buildChangePreview } from "../src/change-preview.js";
import { encodeAdapterFile } from "../src/platform-adapters.js";
import {
  DEFAULT_OPTIONS,
  accountEntitlements,
  analyzeCompletion,
  canonicalNmsName,
  classifyNmsFilename,
  completeUnlocks,
  expectedSlotFromSaveName,
  validateFileSet,
  verifyCompletion,
} from "../src/completion.js";
import {
  cloneJson,
  decodeJsonFile,
  decodeMetadata,
  updateMetadata,
  validateMetadata,
} from "../src/nms-codec.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(project, "../../..");
const privateFixturePaths = [
  "samples/save8.hg",
  "samples/accountdata.hg",
  "samples/mf_save8.hg",
];
const hasPrivateFixtures = privateFixturePaths.every((relativePath) =>
  existsSync(path.join(workspace, relativePath)),
);

async function bytes(relativePath) {
  return new Uint8Array(await readFile(path.join(workspace, relativePath)));
}

async function originalFixture() {
  const saveBytes = await bytes("samples/save8.hg");
  const accountBytes = await bytes("samples/accountdata.hg");
  return {
    saveBytes,
    accountBytes,
    save: decodeJsonFile(saveBytes, master.saveMap),
    account: decodeJsonFile(accountBytes, master.accountMap),
    saveMeta: decodeMetadata(await bytes("samples/mf_save8.hg"), 9),
  };
}

function replaceAllowedFieldsWithOriginal(completed, original, fields) {
  for (const field of fields) completed[field] = cloneJson(original[field]);
}

test("master snapshot contains only generic game completion data", () => {
  assert.equal(master.saveFormat, 2004);
  assert.equal(master.knownProducts.length, 3501);
  assert.deepEqual(master.contextualKnownProducts, [
    "^PURPM_LUSH_KEY",
    "^PURPM_WATER_KEY",
    "^PURPM_GAS_KEY",
  ]);
  assert(master.contextualKnownProducts.every((item) =>
    !master.knownProducts.includes(item)
  ));
  assert.equal(master.knownSpecials.length, 893);
  assert.equal(master.knownTechnologies.length, 204);
  assert.equal(master.disallowedKnownTechnologies.length, 129);
  assert.equal(master.disallowedSeenTechnologies.length, 129);
  assert(master.knownTechnologies.includes("^BOLT_SM"));
  assert(master.knownTechnologies.includes("^PHOTONIX_CORE"));
  assert(!master.knownTechnologies.includes("^DUMMY_SCAN"));
  assert(!master.knownTechnologies.some((item) => /_DMG\d+$/.test(item)));
  assert.equal(master.refinerRecipes.length, 1681);
  assert.equal(master.wordGroups.length, 3827);
  assert.equal(master.seasonRewards.length, 278);
  assert.equal(master.twitchRewards.length, 405);
  assert.deepEqual(master.platformRewards, [
    "^TGA_SHIP1",
    "^SW_PREORDER",
    "^SW_PREORDER2",
  ]);
  assert.deepEqual(master.contentEntitlements, [
    "^ENT_BOLTCASTER",
    "^ENT_PHOCORE",
    "^ENT_XO_HELMET",
  ]);
  assert.equal(master.titles.length, 339);
  assert.equal(master.seenSubstances.length, 111);
  assert.equal(master.fossilBlueprintRecords.length, 22);
  assert.equal(master.fossilComponentRecords.length, 143);
  assert.equal(master.fossilRecords.length, 165);
  assert.equal(master.shipComponentRecords.length, 309);
  assert.equal(master.speculativeShipComponentRecords.length, 309);
  assert.strictEqual(
    master.shipComponentRecords,
    master.speculativeShipComponentRecords,
  );
  assert.equal(master.catalogueRecordProducts.length, 474);
  assert.equal(master.catalogueOnlyProductRecords.length, 452);
  assert.equal(master.authoritativeCatalogueRecordProducts.length, 165);
  assert.equal(master.authoritativeCatalogueOnlyProductRecords.length, 143);
  assert.equal(master.fishingRecords.length, 226);
  assert.equal(master.seenBaseBuildingObjects.length, 1289);
  assert.equal(master.storyRecords.length, 40);
  assert.equal(master.anomalousBasePartRecords.length, 11);
  assert.equal(master.storyRecordSource.staticEntryCount, 592);
  assert.equal(master.storyRecordSource.displayedEntryCount, 598);
  assert.equal(master.recordFamilies.length, 6);
  assert.equal(master.naturalProgressionTargets.length, 93);
  assert.equal(master.naturalStatRepairs.length, 51);
  assert.equal(master.sourceCounts.titleBackedStatFamilies, 78);
  assert.equal(master.completionCoverage.finiteFamilies.length, 15);
  assert.equal(master.completionCoverage.contextualFamilies.length, 6);
  assert.equal(master.completionCoverage.preservedProceduralFamilies.length, 7);
  assert.equal(master.completionCoverage.definitionOnlyFamilies.length, 9);
  assert.equal(master.completionCoverage.preservedStateFamilies.length, 6);
  assert(master.speculativeShipComponentRecords.includes("^DROPS_WINGCDD"));
  assert(master.speculativeShipComponentRecords.includes("^SHUTT_COCKA"));
  assert(master.speculativeShipComponentRecords.includes("^SHUTT_WINGL"));
  assert(master.speculativeShipComponentRecords.every((item) =>
    !master.authoritativeCatalogueRecordProducts.includes(item)
  ));
  assert(master.fishingRecords.some((item) => item.productId === "^F_BOSS_JELLY"));
  assert(master.fishingRecords.some((item) => item.productId === "^S15_FISH"));
  assert(master.fishingRecords.some((item) => item.productId === "^S15_BOT_4"));
  assert(master.fossilRecords.every((item) => /^\^FOS_[A-Z0-9_]+$/.test(item)));
  assert(master.fishingRecords.every((item) =>
    master.knownProducts.includes(item.productId)
  ));
  assert(!master.catalogueRecordProducts.some((item) =>
    /BAIT_|PIPESHAPE/.test(item)
  ));
  assert(master.disallowedKnownTechnologies.includes("^MAINT_TECH25"));
  assert(master.disallowedKnownTechnologies.includes("^EXOPOD_TECH3"));
  assert(master.wordGroups.some((item) => item.Group === "^TRA_COLLECTION"));
  assert.equal(
    master.baseBuildingRecordSource.sourceGameTable,
    "METADATA/REALITY/TABLES/BASEBUILDINGOBJECTSTABLE.MBIN",
  );
  assert.match(
    master.baseBuildingRecordSource.sourceTableSha256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    master.storyRecordSource.sourceGameTable,
    "METADATA/REALITY/TABLES/STORIESTABLE.MBIN",
  );
  assert.match(master.storyRecordSource.sourceTableSha256, /^[a-f0-9]{64}$/);
  assert(!master.seenBaseBuildingObjects.includes("^PIPESHAPE"));
  assert(master.wordGroups.some((item) => item.Group === "^BUI_MINE"));
  assert.doesNotMatch(
    JSON.stringify(master),
    /765611\d{8,}/,
  );
});

test("catalogue completion creates every finite legitimate record family", () => {
  const emptyFishingRecord = {
    ProductList: Array(256).fill("^"),
    LargestCatchList: Array(256).fill(0),
    ProductCountList: Array(256).fill(0),
  };
  const player = {
    KnownProducts: [],
    SeenBaseBuildingObjects: [],
    SeenStories: [],
    KnownSpecials: [],
    KnownTech: [],
    KnownRefinerRecipes: [],
    KnownWordGroups: [],
    RedeemedSeasonRewards: [],
    RedeemedTwitchRewards: [],
    RedeemedPlatformRewards: [],
    KnownPortalRunes: 0,
    UnlockedPetSlots: [],
    SquadronUnlockedPilotSlots: [],
    FishingRecord: emptyFishingRecord,
  };
  const settings = {
    UnlockedSpecials: [],
    UnlockedSeasonRewards: [],
    UnlockedTwitchRewards: [],
    UnlockedPlatformRewards: [],
    UnlockedTitles: [],
    SeenWikiTopics: [],
    UnlockedWikiTopics: [],
    SeenSubstances: [],
    SeenTechnologies: [],
    SeenProducts: [],
  };
  const save = { BaseContext: { PlayerStateData: player } };
  const account = { UserSettingsData: settings };
  const options = {
    rewards: false,
    blueprints: false,
    languageAndSlots: false,
    catalogue: true,
    progressionConveniences: false,
  };
  const result = completeUnlocks(save, account, master, options);
  assert.equal(result.report.before.missing.fossilRecords, 165);
  assert.equal(
    result.report.before.contextual.speculativeShipComponentRecords,
    309,
  );
  assert.equal(result.report.before.missing.fishingRecords, 226);
  assert.equal(result.report.before.missing.baseBuildingRecords, 1289);
  assert.equal(result.report.before.missing.storyRecords, 40);
  assert.equal(result.report.before.missing.anomalousBasePartRecords, 11);
  assert.equal(result.report.additions.fossilRecords, 165);
  assert.equal(result.report.additions.shipComponentRecords, undefined);
  assert.equal(result.report.additions.fishingRecords, 226);
  assert.equal(result.report.additions.baseBuildingRecords, 1289);
  assert.equal(result.report.additions.storyRecords, 40);
  assert.equal(result.report.additions.anomalousBasePartRecords, 11);
  assert.equal(result.report.after.missing.fossilRecords, 0);
  assert.equal(
    result.report.after.contextual.speculativeShipComponentRecords,
    309,
  );
  assert.equal(result.report.after.missing.fishingRecords, 0);
  assert.equal(result.report.after.missing.baseBuildingRecords, 0);
  assert.equal(result.report.after.missing.storyRecords, 0);
  assert.equal(result.report.after.missing.anomalousBasePartRecords, 0);
  assert.deepEqual(
    result.account.UserSettingsData.SeenProducts,
    master.authoritativeCatalogueRecordProducts,
  );
  assert(master.speculativeShipComponentRecords.every((item) =>
    !result.account.UserSettingsData.SeenProducts.includes(item)
  ));
  assert.deepEqual(
    result.save.BaseContext.PlayerStateData.FishingRecord.ProductList.slice(
      0,
      master.fishingRecords.length,
    ),
    master.fishingRecords.map((item) => item.productId),
  );
  assert.deepEqual(
    result.save.BaseContext.PlayerStateData.FishingRecord.LargestCatchList.slice(
      0,
      master.fishingRecords.length,
    ),
    master.fishingRecords.map((item) => item.largestCatch),
  );
  assert(
    result.save.BaseContext.PlayerStateData.FishingRecord.ProductCountList
      .slice(0, master.fishingRecords.length)
      .every((value) => value === 1),
  );
  assert.deepEqual(
    result.save.BaseContext.PlayerStateData.SeenBaseBuildingObjects,
    master.seenBaseBuildingObjects,
  );
  for (const expected of master.storyRecords) {
    const pages =
      result.save.BaseContext.PlayerStateData
        .SeenStories[expected.categoryIndex].PagesData;
    const actual = pages.find(
      (record) => record.PageIdx === expected.pageIndex,
    );
    assert.equal(actual?.LastSeenEntryIdx, expected.targetValue);
  }
  assert.equal(
    result.save.BaseContext.PlayerStateData.WonderWeirdBasePartRecords.length,
    11,
  );
  assert(
    result.save.BaseContext.PlayerStateData.WonderWeirdBasePartRecords.every(
      (record) =>
        record.SeenInFrontend === true &&
        Number(record.WonderStatValue) >= 1,
    ),
  );
  assert.deepEqual(verifyCompletion(result.save, result.account, master, options), {
    ok: true,
    failures: [],
  });
});

test("integrity repair clears orphaned procedural wonders without fabricating discoveries", () => {
  const validWonder = {
    GenerationID: [1, 2],
    WonderStatValue: 42,
    SeenInFrontend: true,
  };
  const orphanedWonder = {
    GenerationID: [3, 4],
    WonderStatValue: 99,
    SeenInFrontend: true,
  };
  const player = {
    KnownProducts: [],
    SeenBaseBuildingObjects: [],
    KnownSpecials: [],
    KnownTech: [],
    KnownRefinerRecipes: [],
    KnownWordGroups: [],
    RedeemedSeasonRewards: [],
    RedeemedTwitchRewards: [],
    RedeemedPlatformRewards: [],
    KnownPortalRunes: 0,
    UnlockedPetSlots: [],
    SquadronUnlockedPilotSlots: [],
    WonderPlanetRecords: [validWonder, orphanedWonder],
    WonderCreatureRecords: [],
    WonderFloraRecords: [],
    WonderMineralRecords: [],
  };
  const settings = {
    UnlockedSpecials: [],
    UnlockedSeasonRewards: [],
    UnlockedTwitchRewards: [],
    UnlockedPlatformRewards: [],
    UnlockedTitles: [],
    SeenWikiTopics: [],
    UnlockedWikiTopics: [],
    SeenSubstances: [],
    SeenTechnologies: master.disallowedSeenTechnologies.slice(0, 73),
    SeenProducts: [],
  };
  const save = {
    BaseContext: { PlayerStateData: player },
    DiscoveryManagerData: {
      "DiscoveryData-v1": {
        Store: {
          Record: [{ DD: { UA: 1, DT: "Planet", VP: [2] } }],
        },
      },
    },
  };
  const account = { UserSettingsData: settings };
  const options = {
    rewards: false,
    blueprints: false,
    languageAndSlots: false,
    catalogue: false,
    naturalProgression: false,
    progressionConveniences: false,
    repairIntegrity: true,
  };
  const before = analyzeCompletion(save, account, master);
  assert.equal(before.integrity.orphanedProceduralWonders, 1);
  assert.equal(before.integrity.disallowedSeenTechnologies, 73);
  assert.equal(before.contextual.internalSeenTechnologies, 73);
  assert.equal(before.missing.disallowedSeenTechnologies, undefined);
  const originalSeenTechnologies = settings.SeenTechnologies.slice();
  const completed = completeUnlocks(save, account, master, options);
  const records =
    completed.save.BaseContext.PlayerStateData.WonderPlanetRecords;
  assert.deepEqual(records[0], validWonder);
  assert.deepEqual(records[1], {
    GenerationID: [0, 0],
    WonderStatValue: 0,
    SeenInFrontend: false,
  });
  assert.equal(completed.report.after.integrity.orphanedProceduralWonders, 0);
  assert.equal(completed.report.after.integrity.repairableIssues, 0);
  assert.deepEqual(
    completed.account.UserSettingsData.SeenTechnologies,
    originalSeenTechnologies,
  );
  assert.deepEqual(
    verifyCompletion(completed.save, completed.account, master, options),
    { ok: true, failures: [] },
  );
});

test("licensed account entitlements are contextual and require explicit opt-in", () => {
  function genericPlayer(marker) {
    return {
      Marker: marker,
      KnownProducts: [],
      SeenBaseBuildingObjects: [],
      KnownSpecials: [],
      KnownTech: [],
      KnownRefinerRecipes: [],
      KnownWordGroups: [],
      RedeemedSeasonRewards: [],
      RedeemedTwitchRewards: [],
      RedeemedPlatformRewards: [],
      KnownPortalRunes: 0,
      UnlockedPetSlots: [],
      SquadronUnlockedPilotSlots: [],
    };
  }

  function genericSettings(profile) {
    return {
      ProfileMarker: profile,
      UnlockedSpecials: [],
      UnlockedSeasonRewards: [],
      UnlockedTwitchRewards: [],
      UnlockedPlatformRewards: [],
      UnlockedTitles: [],
      SeenWikiTopics: [],
      UnlockedWikiTopics: [],
      SeenSubstances: [],
      SeenTechnologies: [],
      SeenProducts: [],
    };
  }

  const options = {
    rewards: true,
    blueprints: false,
    languageAndSlots: false,
    catalogue: false,
    naturalProgression: false,
    progressionConveniences: false,
    repairIntegrity: false,
  };
  for (const profile of ["st_arbitrary_profile", "DefaultUser", "portable-user"]) {
    const selectedSave = {
      Version: master.testedGameVersion,
      BaseContext: { PlayerStateData: genericPlayer("selected-slot") },
    };
    const anotherSave = {
      Version: master.testedGameVersion,
      BaseContext: { PlayerStateData: genericPlayer("another-slot") },
    };
    const account = { UserSettingsData: genericSettings(profile) };
    const completed = completeUnlocks(selectedSave, account, master, options);

    assert.deepEqual(
      completed.account.UserSettingsData.UnlockedPlatformRewards,
      [],
    );
    assert.equal(completed.account.UserSettingsData.ProfileMarker, profile);
    assert.equal(completed.save.BaseContext.PlayerStateData.Marker, "selected-slot");
    assert.deepEqual(
      anotherSave.BaseContext.PlayerStateData.RedeemedPlatformRewards,
      [],
    );

    const defaultAnalysis = analyzeCompletion(
      anotherSave,
      completed.account,
      master,
    );
    assert.equal(defaultAnalysis.contextual.platformRewards, 3);
    assert.equal(defaultAnalysis.contextual.contentEntitlements, 3);
    assert.equal(defaultAnalysis.missing.platformRewards, undefined);
    assert.equal(defaultAnalysis.missing.contentEntitlements, undefined);

    const optedIn = completeUnlocks(
      selectedSave,
      account,
      master,
      { ...options, licensedEntitlements: true },
    );
    assert.deepEqual(
      optedIn.account.UserSettingsData.UnlockedPlatformRewards,
      accountEntitlements(master),
    );
    assert.equal(optedIn.report.after.contextual.platformRewards, 0);
    assert.equal(optedIn.report.after.contextual.contentEntitlements, 0);
    const optedInAnalysis = analyzeCompletion(
      anotherSave,
      optedIn.account,
      master,
    );
    assert.deepEqual(optedInAnalysis.health, defaultAnalysis.health);
    assert.deepEqual(
      verifyCompletion(
        optedIn.save,
        optedIn.account,
        master,
        { ...options, licensedEntitlements: true },
      ),
      { ok: true, failures: [] },
    );
  }
});

test("completion fills legitimate categories and changes only declared fields", { skip: !hasPrivateFixtures }, async () => {
  const fixture = await originalFixture();
  const beforeAnalysis = analyzeCompletion(
    fixture.save.value,
    fixture.account.value,
    master,
  );
  assert(beforeAnalysis.totalMissing >= 0);

  const result = completeUnlocks(
    fixture.save.value,
    fixture.account.value,
    master,
    DEFAULT_OPTIONS,
  );
  assert.deepEqual(verifyCompletion(result.save, result.account, master), {
    ok: true,
    failures: [],
  });
  assert.equal(result.report.after.missing.knownProducts, 0);
  assert.equal(result.report.after.missing.wordGroups, 0);
  assert.equal(result.report.after.contextual.platformRewards,
    beforeAnalysis.contextual.platformRewards);
  assert.equal(result.report.after.contextual.contentEntitlements,
    beforeAnalysis.contextual.contentEntitlements);
  assert.deepEqual(
    result.account.UserSettingsData.UnlockedPlatformRewards,
    fixture.account.value.UserSettingsData.UnlockedPlatformRewards,
  );

  const normalizedSave = cloneJson(result.save);
  replaceAllowedFieldsWithOriginal(
    normalizedSave.BaseContext.PlayerStateData,
    fixture.save.value.BaseContext.PlayerStateData,
    [
      "KnownSpecials",
      "RedeemedSeasonRewards",
      "RedeemedTwitchRewards",
      "RedeemedPlatformRewards",
      "KnownProducts",
      "KnownTech",
      "KnownRefinerRecipes",
      "KnownWordGroups",
      "KnownPortalRunes",
      "UnlockedPetSlots",
      "SquadronUnlockedPilotSlots",
      "FishingRecord",
      "SeenBaseBuildingObjects",
      "SeenStories",
    ],
  );
  assert.equal(stringify(normalizedSave), stringify(fixture.save.value));

  const normalizedAccount = cloneJson(result.account);
  replaceAllowedFieldsWithOriginal(
    normalizedAccount.UserSettingsData,
    fixture.account.value.UserSettingsData,
    [
      "UnlockedSpecials",
      "UnlockedSeasonRewards",
      "UnlockedTwitchRewards",
      "UnlockedPlatformRewards",
      "UnlockedTitles",
      "SeenWikiTopics",
      "UnlockedWikiTopics",
      "SeenSubstances",
      "SeenTechnologies",
      "SeenProducts",
    ],
  );
  assert.equal(stringify(normalizedAccount), stringify(fixture.account.value));
});

test("change previews exactly match the completed record count", { skip: !hasPrivateFixtures }, async () => {
  const fixture = await originalFixture();
  const presets = [
    { rewards: true, blueprints: true, languageAndSlots: true, catalogue: true, repairIntegrity: true, progressionConveniences: false },
    { rewards: true, blueprints: false, languageAndSlots: false, catalogue: false, repairIntegrity: true, progressionConveniences: false },
    { rewards: false, blueprints: true, languageAndSlots: false, catalogue: true, repairIntegrity: true, progressionConveniences: false },
    { rewards: false, blueprints: false, languageAndSlots: false, catalogue: false, repairIntegrity: true, progressionConveniences: false },
    { rewards: true, blueprints: true, languageAndSlots: true, catalogue: true, repairIntegrity: true, progressionConveniences: true },
  ];
  for (const options of presets) {
    const analysis = analyzeCompletion(fixture.save.value, fixture.account.value, master);
    const preview = buildChangePreview(analysis, options);
    const result = completeUnlocks(fixture.save.value, fixture.account.value, master, options);
    const actual = Object.values(result.report.additions).reduce(
      (total, value) => total + (typeof value === "number" ? value : value.added + value.expanded),
      0,
    );
    assert.equal(preview.total, actual, JSON.stringify(options));
  }
});

test("the first-pass Save8 fixture exposes the exact final omissions", { skip: true }, async () => {
  const save = decodeJsonFile(
    await bytes("work/backups/pass1_save8.hg"),
    master.saveMap,
  );
  const account = decodeJsonFile(
    await bytes("work/backups/pass1_accountdata(2).hg"),
    master.accountMap,
  );
  const analysis = analyzeCompletion(save.value, account.value, master);
  assert.equal(analysis.missing.wordGroups, 1);
  assert.equal(analysis.missing.seenKnownProducts, 138);
  assert.equal(analysis.missing.seenKnownTechnologies, 0);
  const result = completeUnlocks(save.value, account.value, master);
  assert.equal(result.report.after.missing.wordGroups, 0);
  assert.equal(result.report.after.missing.seenKnownProducts, 0);
  assert.equal(verifyCompletion(result.save, result.account, master).ok, true);
});

test("completed payloads round-trip with matching updated manifests", { skip: !hasPrivateFixtures }, async () => {
  const fixture = await originalFixture();
  const result = completeUnlocks(
    fixture.save.value,
    fixture.account.value,
    master,
  );
  const saveOutput = encodeAdapterFile(
    result.save,
    master.saveMap,
    { ...fixture.save, adapter: "steam" },
    "save",
  );
  const accountOutput = encodeAdapterFile(
    result.account,
    master.accountMap,
    { ...fixture.account, adapter: "steam" },
    "account",
  );
  assert.equal(saveOutput.compressed, true);
  assert.equal(accountOutput.compressed, false);
  const saveMetaOutput = updateMetadata(
    fixture.saveMeta,
    saveOutput.bytes,
    saveOutput.decompressedLength,
    saveOutput.compressed,
  );
  const checkedSave = decodeJsonFile(saveOutput.bytes, master.saveMap);
  const checkedAccount = decodeJsonFile(accountOutput.bytes, master.accountMap);
  const checkedSaveMeta = decodeMetadata(saveMetaOutput.bytes, 9);
  assert.equal(
    validateMetadata(
      checkedSaveMeta,
      saveOutput.bytes,
      checkedSave.decompressedLength,
      checkedSave.compressed,
      { strict: true },
    ),
    true,
  );
  assert.equal(verifyCompletion(checkedSave.value, checkedAccount.value, master).ok, true);
});

test("ownership repair changes only explicitly matching identities", { skip: !hasPrivateFixtures }, async () => {
  const fixture = await originalFixture();
  const records =
    fixture.save.value.DiscoveryManagerData["DiscoveryData-v1"].Store.Record;
  const uniqueOwners = [];
  const seen = new Set();
  for (const record of records) {
    const owner = record.OWS;
    if (owner?.UID && !seen.has(owner.UID)) {
      seen.add(owner.UID);
      uniqueOwners.push(owner);
    }
    if (uniqueOwners.length === 2) break;
  }
  assert.equal(uniqueOwners.length, 2);
  const identities = uniqueOwners.map((owner, index) => ({
    PTK: owner.PTK || "ST",
    UID: String(owner.UID),
    LID: String(owner.LID || `test-local-${index}`),
    USN: `Verified Test Owner ${index + 1}`,
  }));
  const beforeSettlements = cloneJson(
    fixture.save.value.BaseContext.PlayerStateData.SettlementStatesV2,
  );
  const beforeEggs = cloneJson(fixture.save.value.BaseContext.PlayerStateData.Eggs);
  const beforeRecords = cloneJson(records);
  const result = completeUnlocks(
    fixture.save.value,
    fixture.account.value,
    master,
    DEFAULT_OPTIONS,
    {
      enabled: true,
      primary: identities[0],
      aliases: [identities[1]],
      normalizeBases: true,
      normalizeMatchingDiscoveries: true,
      clearBaseEditorLabels: true,
    },
  );
  for (const base of result.save.BaseContext.PlayerStateData.PersistentPlayerBases) {
    assert.equal(base.Owner.UID, identities[0].UID);
    assert.equal(base.Owner.USN, identities[0].USN);
    assert.equal(base.LastEditedById, "");
    assert.equal(base.LastEditedByUsername, "");
  }
  const identityByUid = new Map(identities.map((item) => [item.UID, item]));
  const afterRecords =
    result.save.DiscoveryManagerData["DiscoveryData-v1"].Store.Record;
  for (let index = 0; index < beforeRecords.length; index += 1) {
    const before = beforeRecords[index];
    const after = afterRecords[index];
    const expected = identityByUid.get(String(before.OWS?.UID ?? ""));
    if (expected) {
      assert.equal(after.OWS.UID, expected.UID);
      assert.equal(after.OWS.USN, expected.USN);
    } else {
      assert.equal(stringify(after), stringify(before));
    }
  }
  assert.equal(
    stringify(result.save.BaseContext.PlayerStateData.SettlementStatesV2),
    stringify(beforeSettlements),
  );
  assert.equal(
    stringify(result.save.BaseContext.PlayerStateData.Eggs),
    stringify(beforeEggs),
  );
});

test("duplicate-download filenames canonicalize and pair safely", () => {
  assert.equal(canonicalNmsName("accountdata(2).hg"), "accountdata.hg");
  assert.equal(canonicalNmsName("save2 (3).hg"), "save2.hg");
  assert.equal(classifyNmsFilename("mf_save2(2).hg"), "saveMeta");
  assert.equal(classifyNmsFilename("save.hg"), "save");
  assert.equal(classifyNmsFilename("mf_save.hg"), "saveMeta");
  assert.equal(expectedSlotFromSaveName("save.hg"), 2);
  assert.equal(expectedSlotFromSaveName("save8.hg"), 9);
  const records = [
    { name: "save8.hg" },
    { name: "mf_save8.hg" },
    { name: "accountdata(2).hg" },
    { name: "mf_accountdata.hg" },
  ];
  assert.deepEqual(Object.keys(validateFileSet(records)).sort(), [
    "account",
    "accountMeta",
    "save",
    "saveMeta",
  ]);
});
