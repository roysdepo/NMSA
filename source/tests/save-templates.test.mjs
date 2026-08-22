import assert from "node:assert/strict";
import test from "node:test";
import templateAudit from "../src/data/save-template-audit.json" with { type: "json" };
import master from "../src/data/index.js";
import { completePreparedUnlocks, verifyCompletion } from "../src/completion.js";
import { decodeJsonFile, encodeJsonFile } from "../src/nms-codec.js";
import {
  SAVE_TEMPLATE_DEFINITIONS,
  applySaveTemplate,
  getSaveTemplateDefinition,
  templateVerificationJson,
} from "../src/save-templates.js";

function account() {
  return {
    UserSettingsData: {
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
    },
  };
}

function destinationSave() {
  const identity = {
    PTK: "ST",
    USN: "Destination",
    UID: "destination-uid",
    LID: "destination-local",
    TS: 123,
  };
  return {
    Version: master.testedGameVersion,
    ActiveContext: "Base",
    WrapperMarker: "preserve-wrapper",
    CommonStateData: { UsedDiscoveryOwnersV2: [identity] },
    BaseContext: {
      PlayerStateData: {
        FutureGameField: { preserve: true },
        MissionProgress: [{ Mission: "^DESTINATION", Progress: 1 }],
        Inventory: { Marker: "destination-inventory" },
        PersistentPlayerBases: [{ Owner: identity }],
      },
      SpawnStateData: { Marker: "destination-spawn" },
    },
    ExpeditionContext: {
      PlayerStateData: { Marker: "inactive-expedition" },
      SpawnStateData: { Marker: "inactive-spawn" },
    },
    DiscoveryManagerData: {
      "DiscoveryData-v1": { Store: { Record: [] } },
    },
  };
}

function populated(values, field) {
  return values.filter((value) => value?.Resource?.[field]).length;
}

test("all three audited save-state tiers are packaged and selectable", () => {
  assert.deepEqual(
    SAVE_TEMPLATE_DEFINITIONS.map(({ id, kind }) => ({ id, kind })),
    [
      { id: "god", kind: "full" },
      { id: "demigod", kind: "full" },
      { id: "missions", kind: "missions" },
    ],
  );
  assert.equal(templateAudit.summaries.missions.recordCount, 511);
  assert.equal(templateAudit.summaries.missions.uniqueMissionCount, 511);
});

test("Full Progression replaces the selected context, preserves wrappers, and repairs internal technology", () => {
  const original = destinationSave();
  const inactiveBefore = structuredClone(original.ExpeditionContext);
  const result = applySaveTemplate(original, "god", master, "main");
  const player = result.save.BaseContext.PlayerStateData;

  assert.equal(result.changedFields.length, 244);
  assert.equal(result.save.WrapperMarker, "preserve-wrapper");
  assert.deepEqual(result.save.ExpeditionContext, inactiveBefore);
  assert.deepEqual(player.FutureGameField, { preserve: true });
  assert.equal(player.MissionProgress.length, 482);
  assert.equal(populated(player.ShipOwnership, "Filename"), 9);
  assert.equal(populated(player.Multitools, "Filename"), 4);
  assert.equal(player.FleetFrigates.length, 30);
  assert.equal(player.FreighterInventory.Class.InventoryClass, "S");
  assert(!player.KnownTech.includes("^DUMMY_SCAN"));
  assert(!player.KnownTech.includes("^OBSOLETE"));
  assert.deepEqual(result.sanitization.removedTechnologies.sort(), [
    "^DUMMY_SCAN",
    "^OBSOLETE",
  ]);
  assert.equal(result.basesRebound, 2);
  assert(result.identityRecordsRebound > result.basesRebound);
  assert(player.PersistentPlayerBases.every((base) =>
    base.Owner.UID === "destination-uid"
  ));
  assert(!JSON.stringify(player).includes("ATLAS_TEMPLATE"));
});

test("full templates preserve destination owner-bound fields when no owner can be inferred", () => {
  const original = destinationSave();
  original.CommonStateData.UsedDiscoveryOwnersV2 = [];
  Object.assign(original.BaseContext.PlayerStateData, {
    PersistentPlayerBases: [],
    SettlementStatesV2: [{ Marker: "destination-settlement" }],
    Pets: [{ Marker: "destination-pet" }],
    Eggs: [{ Marker: "destination-egg" }],
  });
  const result = applySaveTemplate(original, "god", master, "main");
  const player = result.save.BaseContext.PlayerStateData;
  assert.equal(result.destinationOwnerDetected, false);
  assert.deepEqual(result.ownerBoundFieldsPreserved.sort(), [
    "Eggs",
    "PersistentPlayerBases",
    "Pets",
    "SettlementStatesV2",
  ]);
  assert.deepEqual(player.PersistentPlayerBases, []);
  assert.deepEqual(player.SettlementStatesV2, [{ Marker: "destination-settlement" }]);
  assert.deepEqual(player.Pets, [{ Marker: "destination-pet" }]);
  assert.deepEqual(player.Eggs, [{ Marker: "destination-egg" }]);
  assert(!JSON.stringify(player).includes("ATLAS_TEMPLATE"));
});

test("Full Progression can be raised to the current Atlas completion baseline", () => {
  const applied = applySaveTemplate(destinationSave(), "god", master, "main");
  const definition = getSaveTemplateDefinition("god");
  const originalAccount = account();
  const completed = completePreparedUnlocks(
    applied.save,
    originalAccount,
    master,
    definition.completionOptions,
    { enabled: false },
    "main",
  );
  assert.strictEqual(completed.save, applied.save);
  assert.deepEqual(originalAccount, account());
  assert.deepEqual(
    verifyCompletion(
      completed.save,
      completed.account,
      master,
      definition.completionOptions,
      "main",
    ),
    { ok: true, failures: [] },
  );
  assert.equal(completed.report.after.health.completedEntries,
    completed.report.after.health.targetEntries);
});

test("Explorer Progression keeps the audited balanced asset profile", () => {
  const result = applySaveTemplate(destinationSave(), "demigod", master, "main");
  const player = result.save.BaseContext.PlayerStateData;
  assert.equal(populated(player.ShipOwnership, "Filename"), 1);
  assert.equal(populated(player.Multitools, "Filename"), 1);
  assert.equal(player.FleetFrigates.length, 1);
  assert.equal(player.FreighterInventory.Class.InventoryClass, "C");
  assert.equal(player.Units, 10_000_000);
  assert.equal(player.Nanites, 10_000);
  assert.equal(player.Specials, 4_000);
});

test("Mission Progress replaces only MissionProgress with all 511 records", () => {
  const original = destinationSave();
  const playerBefore = structuredClone(original.BaseContext.PlayerStateData);
  const result = applySaveTemplate(original, "missions", master, "main");
  const player = result.save.BaseContext.PlayerStateData;
  assert.equal(player.MissionProgress.length, 511);
  assert.equal(new Set(player.MissionProgress.map((record) => record.Mission)).size, 511);
  assert.deepEqual(player.Inventory, playerBefore.Inventory);
  assert.deepEqual(player.PersistentPlayerBases, playerBefore.PersistentPlayerBases);
  assert.deepEqual(result.save.ExpeditionContext, original.ExpeditionContext);
  assert.equal(result.changedFields.length, 1);
});

test("template verification fingerprints detect post-application changes", () => {
  const result = applySaveTemplate(destinationSave(), "missions", master, "main");
  const expected = templateVerificationJson(result.save, "missions", "main");
  result.save.BaseContext.PlayerStateData.MissionProgress[0].Progress += 1;
  assert.notEqual(
    templateVerificationJson(result.save, "missions", "main"),
    expected,
  );
});

test("full and mission templates survive the NMS save codec", () => {
  for (const id of ["god", "demigod", "missions"]) {
    const applied = applySaveTemplate(destinationSave(), id, master, "main");
    const expected = templateVerificationJson(applied.save, id, "main");
    const encoded = encodeJsonFile(applied.save, master.saveMap, true, "utf-8", 0);
    const reopened = decodeJsonFile(encoded.bytes, master.saveMap);
    assert.equal(
      templateVerificationJson(reopened.value, id, "main"),
      expected,
      id,
    );
  }
});

test("shared saves remain audit evidence and cannot redefine legitimate completion", () => {
  const candidates = templateAudit.completionComparison.sourceOnlyCandidates;
  assert.deepEqual(candidates.knownTechnologies.sort(), ["^DUMMY_SCAN", "^OBSOLETE"]);
  assert(candidates.knownTechnologies.every((id) =>
    master.disallowedKnownTechnologies.includes(id)
  ));
  assert.equal(candidates.wordGroups.length, 0);
  assert.deepEqual(
    templateAudit.completionComparison.sourceOnlyProductClassifications.unclassified,
    ["^SET_S_TOWER", "^SET_S_TOWER_FA"],
  );
  assert(!master.knownProducts.includes("^SET_S_TOWER"));
  assert(!master.knownProducts.includes("^SET_S_TOWER_FA"));
});
