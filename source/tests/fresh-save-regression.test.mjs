import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import master from "../src/data/index.js";
import {
  DEFAULT_OPTIONS,
  analyzeCompletion,
  completeUnlocks,
  verifyCompletion,
} from "../src/completion.js";
import {
  decodeJsonFile,
  decodeMetadata,
  updateMetadata,
  validateMetadata,
} from "../src/nms-codec.js";
import { encodeAdapterFile } from "../src/platform-adapters.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(project, "../../..");
const uploadNames = [
  "save8(3).hg",
  "mf_save8(2).hg",
  "accountdata(2).hg",
  "mf_accountdata(1).hg",
  "steam_autocloud(1).vdf",
];
const hasFreshSaveFixture = uploadNames.every((name) =>
  existsSync(path.join(workspace, "upload", name)),
);

async function uploadedBytes(name) {
  return new Uint8Array(await readFile(path.join(workspace, "upload", name)));
}

function globalStats(save) {
  return save.BaseContext.PlayerStateData.Stats
    .find((group) => group.GroupId === "^GLOBAL_STATS")
    .Stats;
}

function statValue(save, id) {
  return globalStats(save).find((entry) => entry.Id === id)?.Value;
}

function hasFantasyValue(entry) {
  return [entry?.Value?.IntValue, entry?.Value?.FloatValue]
    .map(Number)
    .filter(Number.isFinite)
    .some(
      (value) =>
        [-2_147_483_648, 2_147_483_647, 2_147_483_648, 4_294_967_295]
          .includes(value) ||
        value <= -2_000_000_000,
    );
}

test(
  "the latest Save8 pair receives authoritative records, preserves contextual state, and round-trips its manifest",
  { skip: !hasFreshSaveFixture },
  async () => {
    const saveBytes = await uploadedBytes("save8(3).hg");
    const accountBytes = await uploadedBytes("accountdata(2).hg");
    const saveMetaBytes = await uploadedBytes("mf_save8(2).hg");
    const accountMetaBytes = await uploadedBytes("mf_accountdata(1).hg");
    const steamCloudBytes = await uploadedBytes("steam_autocloud(1).vdf");
    const accountMetaBefore = accountMetaBytes.slice();
    const steamCloudBefore = steamCloudBytes.slice();
    const save = decodeJsonFile(saveBytes, master.saveMap);
    const account = decodeJsonFile(accountBytes, master.accountMap);
    const saveMeta = decodeMetadata(saveMetaBytes, 9);

    const initial = analyzeCompletion(save.value, account.value, master);
    assert.equal(initial.health.targetEntries, 19_451);
    assert.equal(initial.contextual.platformRewards, 3);
    assert.equal(initial.contextual.contentEntitlements, 3);
    assert.equal(initial.missing.disallowedKnownTechnologies, 0);
    assert.equal(initial.contextual.internalSeenTechnologies, 73);
    assert.equal(initial.missing.seenSubstances, 21);
    assert.equal(initial.missing.fossilRecords, 0);
    assert.equal(initial.contextual.speculativeShipComponentRecords, 295);
    assert.equal(initial.missing.fishingRecords, 176);
    assert.equal(initial.missing.baseBuildingRecords, 1273);
    assert.equal(initial.missing.storyRecords, 1);
    assert.equal(initial.missing.anomalousBasePartRecords, 0);
    assert.equal(initial.contextual.naturalProgression, 38);
    assert.equal(initial.progression.astronomical, 0);
    assert.equal(initial.integrity.orphanedProceduralWonders, 0);

    const options = {
      ...DEFAULT_OPTIONS,
      naturalProgression: true,
      repairIntegrity: true,
    };
    const originalSeenTechnologies = account.value.UserSettingsData.SeenTechnologies.slice();
    const originalSpeculativeShipRecords = account.value.UserSettingsData.SeenProducts
      .filter((item) => master.speculativeShipComponentRecords.includes(item));
    const originalPlatformRewards =
      account.value.UserSettingsData.UnlockedPlatformRewards.slice();
    const completed = completeUnlocks(
      save.value,
      account.value,
      master,
      options,
    );
    assert.deepEqual(
      verifyCompletion(completed.save, completed.account, master, options),
      { ok: true, failures: [] },
    );

    const player = completed.save.BaseContext.PlayerStateData;
    const settings = completed.account.UserSettingsData;
    assert.equal(player.KnownTech.length, 204);
    assert(player.KnownTech.includes("^BOLT_SM"));
    assert(player.KnownTech.includes("^PHOTONIX_CORE"));
    assert(player.KnownSpecials.includes("^SPEC_XOHELMET"));
    assert.equal(
      player.KnownTech.filter((item) =>
        master.disallowedKnownTechnologies.includes(item)
      ).length,
      0,
    );
    assert.deepEqual(settings.SeenTechnologies, originalSeenTechnologies);
    assert(master.fossilRecords.every((item) => settings.SeenProducts.includes(item)));
    assert.deepEqual(
      settings.SeenProducts.filter((item) =>
        master.speculativeShipComponentRecords.includes(item)
      ),
      originalSpeculativeShipRecords,
    );
    assert(
      master.seenBaseBuildingObjects.every((item) =>
        player.SeenBaseBuildingObjects.includes(item)
      ),
    );
    assert(!player.SeenBaseBuildingObjects.includes("^PIPESHAPE"));
    const baseLogStory = player.SeenStories[5].PagesData.find(
      (record) => record.PageIdx === 1,
    );
    assert.equal(baseLogStory.LastSeenEntryIdx, 20);
    const originalFishing = save.value.BaseContext.PlayerStateData.FishingRecord;
    for (let index = 0; index < originalFishing.ProductList.length; index += 1) {
      if (
        !originalFishing.ProductList[index] ||
        originalFishing.ProductList[index] === "^"
      ) {
        continue;
      }
      assert.equal(
        player.FishingRecord.ProductList[index],
        originalFishing.ProductList[index],
      );
      assert.deepEqual(
        player.FishingRecord.ProductCountList[index],
        originalFishing.ProductCountList[index],
      );
    }
    for (const expected of master.fishingRecords) {
      const index = player.FishingRecord.ProductList.indexOf(expected.productId);
      assert.notEqual(index, -1);
      const completedMass = Number(
        player.FishingRecord.LargestCatchList[index]?.value ??
        player.FishingRecord.LargestCatchList[index],
      );
      assert(completedMass > 0);
      assert(completedMass <= expected.maximumPlausibleCatch);
      const originalMass = Number(
        originalFishing.LargestCatchList[index]?.value ??
        originalFishing.LargestCatchList[index],
      );
      if (
        originalFishing.ProductList[index] === expected.productId &&
        originalMass > 0 &&
        originalMass <= expected.maximumPlausibleCatch
      ) {
        assert.deepEqual(
          player.FishingRecord.LargestCatchList[index],
          originalFishing.LargestCatchList[index],
        );
      }
    }
    assert.equal(completed.report.additions.fishingRecords, 176);
    assert.equal(completed.report.additions.storyRecords, 1);
    assert.deepEqual(settings.UnlockedPlatformRewards, originalPlatformRewards);
    assert.deepEqual(
      player.RedeemedPlatformRewards,
      save.value.BaseContext.PlayerStateData.RedeemedPlatformRewards,
    );

    assert.equal(statValue(completed.save, "^LONGEST_LIFE_EX").FloatValue, 43_200);
    assert.equal(statValue(completed.save, "^WALKERS_KILLED").IntValue, 40);
    assert.equal(statValue(completed.save, "^NANITES_EVER").IntValue, 100_000);
    assert.equal(statValue(completed.save, "^PB_BOSS_WINS").IntValue, 60);
    assert.equal(statValue(completed.save, "^PB_WINS").IntValue, 220);
    assert.equal(statValue(completed.save, "^PB_PETS_MAXED").IntValue, 20);
    assert.equal(statValue(completed.save, "^PB_D_NEXUS").IntValue, 30);
    assert.equal(statValue(completed.save, "^EGGS_HATCHED").IntValue, 30);
    assert.equal(statValue(completed.save, "^PB_CHALL_WINS").IntValue, 220);
    assert.equal(statValue(completed.save, "^ALIENS_MET").IntValue, 150);
    assert.equal(statValue(completed.save, "^MONEY").IntValue, 100_000_000);
    assert.equal(statValue(completed.save, "^HOME_REALITY").IntValue, 9);
    assert(statValue(completed.save, "^FISH_CAUGHT").IntValue >= 250);
    assert.equal(statValue(completed.save, "^BONES_FOUND").IntValue, 200);
    assert.equal(statValue(completed.save, "^EXO_SMASH").IntValue, 500);
    assert.deepEqual(statValue(completed.save, "^CRUISE"), { IntValue: -1 });
    assert.equal(
      globalStats(completed.save)
        .filter((entry) => entry.Id !== "^CRUISE")
        .filter(hasFantasyValue)
        .length,
      0,
    );
    assert.equal(completed.report.after.contextual.naturalProgression, 0);
    assert.equal(completed.report.after.progression.astronomical, 0);
    assert.equal(completed.report.after.missing.fossilRecords, 0);
    assert.equal(
      completed.report.after.contextual.speculativeShipComponentRecords,
      initial.contextual.speculativeShipComponentRecords,
    );
    assert.equal(completed.report.after.missing.fishingRecords, 0);
    assert.equal(completed.report.after.missing.baseBuildingRecords, 0);
    assert.equal(completed.report.after.missing.storyRecords, 0);
    assert.equal(completed.report.after.missing.anomalousBasePartRecords, 0);
    assert.equal(completed.report.after.integrity.repairableIssues, 0);
    assert.equal(completed.report.after.health.score, 100);
    for (const field of [
      "WonderPlanetRecords",
      "WonderCreatureRecords",
      "WonderFloraRecords",
      "WonderMineralRecords",
      "WonderTreasureRecords",
      "WonderWeirdBasePartRecords",
      "WonderCustomRecords",
      "WonderCustomRecordsExtraData",
    ]) {
      assert.deepEqual(
        player[field],
        save.value.BaseContext.PlayerStateData[field],
        field,
      );
    }
    assert.deepEqual(
      completed.save.DiscoveryManagerData,
      save.value.DiscoveryManagerData,
    );

    const saveOutput = encodeAdapterFile(
      completed.save,
      master.saveMap,
      { ...save, adapter: "steam" },
      "save",
    );
    const accountOutput = encodeAdapterFile(
      completed.account,
      master.accountMap,
      { ...account, adapter: "steam" },
      "account",
    );
    const saveMetaOutput = updateMetadata(
      saveMeta,
      saveOutput.bytes,
      saveOutput.decompressedLength,
      saveOutput.compressed,
    );
    const checkedSave = decodeJsonFile(saveOutput.bytes, master.saveMap);
    const checkedAccount = decodeJsonFile(accountOutput.bytes, master.accountMap);
    const checkedSaveMeta = decodeMetadata(saveMetaOutput.bytes, 9);

    assert.equal(saveOutput.compressed, true);
    assert.equal(accountOutput.compressed, false);
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
    assert.deepEqual(
      verifyCompletion(
        checkedSave.value,
        checkedAccount.value,
        master,
        options,
      ),
      { ok: true, failures: [] },
    );
    assert.deepEqual(accountMetaBytes, accountMetaBefore);
    assert.deepEqual(steamCloudBytes, steamCloudBefore);
  },
);

test(
  "missing reality-glitch records are created with valid generation IDs and survive codec reload",
  { skip: !hasFreshSaveFixture },
  async () => {
    const decodedSave = decodeJsonFile(
      await uploadedBytes("save8(3).hg"),
      master.saveMap,
    );
    const decodedAccount = decodeJsonFile(
      await uploadedBytes("accountdata(2).hg"),
      master.accountMap,
    );
    decodedSave.value.BaseContext.PlayerStateData.WonderWeirdBasePartRecords =
      Array.from({ length: 11 }, () => ({
        GenerationID: [0, 0],
        WonderStatValue: 0,
        SeenInFrontend: false,
      }));
    const options = {
      rewards: false,
      blueprints: false,
      languageAndSlots: false,
      catalogue: true,
      naturalProgression: false,
      repairIntegrity: false,
      progressionConveniences: false,
    };
    const completed = completeUnlocks(
      decodedSave.value,
      decodedAccount.value,
      master,
      options,
    );
    assert.equal(completed.report.additions.anomalousBasePartRecords, 11);
    const output = encodeAdapterFile(
      completed.save,
      master.saveMap,
      { ...decodedSave, adapter: "steam" },
      "save",
    );
    const reopened = decodeJsonFile(output.bytes, master.saveMap).value;
    assert.equal(
      analyzeCompletion(reopened, completed.account, master)
        .missing.anomalousBasePartRecords,
      0,
    );
    assert.deepEqual(
      verifyCompletion(reopened, completed.account, master, options),
      { ok: true, failures: [] },
    );
  },
);
