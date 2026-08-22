import assert from "node:assert/strict";
import test from "node:test";
import {
  choosePreferredSaveSets,
  discoverSaveFileSets,
  logicalSlotFromSaveName,
  savePointLabelFromSaveName,
  savePointTypeFromSaveName,
  storageOrdinalFromSaveName,
} from "../src/save-discovery.js";

function entry(relativePath, lastModified = 0) {
  const name = relativePath.split("/").at(-1);
  return {
    relativePath,
    file: {
      name,
      size: 100,
      lastModified,
    },
  };
}

test("physical filenames map to the game slots shown in No Man's Sky", () => {
  assert.equal(storageOrdinalFromSaveName("save.hg"), 1);
  assert.equal(storageOrdinalFromSaveName("save8.hg"), 8);
  assert.equal(logicalSlotFromSaveName("save.hg"), 1);
  assert.equal(logicalSlotFromSaveName("save2.hg"), 1);
  assert.equal(logicalSlotFromSaveName("save3.hg"), 2);
  assert.equal(logicalSlotFromSaveName("save8.hg"), 4);
  assert.equal(savePointTypeFromSaveName("save.hg"), "auto");
  assert.equal(savePointTypeFromSaveName("save7.hg"), "auto");
  assert.equal(savePointTypeFromSaveName("save8.hg"), "restore");
  assert.equal(savePointLabelFromSaveName("save7.hg"), "Autosave");
  assert.equal(savePointLabelFromSaveName("save8.hg"), "Restore Point");
});

test("folder scan pairs every save with companions from the same profile", () => {
  const sets = discoverSaveFileSets([
    entry("NMS/st_111/accountdata.hg"),
    entry("NMS/st_111/mf_accountdata.hg"),
    entry("NMS/st_111/save7.hg", 100),
    entry("NMS/st_111/mf_save7.hg", 100),
    entry("NMS/st_111/save8.hg", 200),
    entry("NMS/st_111/mf_save8.hg", 200),
    entry("NMS/st_222/save2.hg", 300),
    entry("NMS/st_222/mf_save2.hg", 300),
  ]);
  assert.equal(sets.length, 3);
  assert.equal(sets.filter((set) => set.complete).length, 2);
  assert(sets.filter((set) => set.complete).every((set) => set.profileName === "st_111"));
  assert(sets.find((set) => set.profileName === "st_222").missing.includes("accountdata.hg"));
  assert.equal(sets.find((set) => set.save.name === "save7.hg").savePointType, "auto");
  assert.equal(sets.find((set) => set.save.name === "save8.hg").savePointType, "restore");
});

test("PC save sets do not require an account manifest", () => {
  const [set] = discoverSaveFileSets([
    entry("NMS/st_111/accountdata.hg"),
    entry("NMS/st_111/save8.hg"),
    entry("NMS/st_111/mf_save8.hg"),
  ]);
  assert.equal(set.complete, true);
  assert.equal(set.accountMeta, null);
  assert.deepEqual(set.missing, []);
});

test("PC platform settings are paired with every save in the same profile", () => {
  const sets = discoverSaveFileSets([
    entry("NMS/st_111/accountdata.hg"),
    entry("NMS/st_111/GCUSERSETTINGSDATA.MXML"),
    entry("NMS/st_111/save7.hg"),
    entry("NMS/st_111/mf_save7.hg"),
    entry("NMS/st_111/save8.hg"),
    entry("NMS/st_111/mf_save8.hg"),
  ]);
  assert.equal(sets.length, 2);
  assert(
    sets.every(
      (set) => set.platformSettings?.name === "GCUSERSETTINGSDATA.MXML",
    ),
  );
});

test("autosave and restore point remain separate choices in one logical slot", () => {
  const sets = discoverSaveFileSets([
    entry("st_111/accountdata.hg"),
    entry("st_111/mf_accountdata.hg"),
    entry("st_111/save7.hg", 100),
    entry("st_111/mf_save7.hg", 100),
    entry("st_111/save8.hg", 200),
    entry("st_111/mf_save8.hg", 200),
  ]).map((set) => ({ ...set, ready: true }));
  const selected = choosePreferredSaveSets(sets);
  assert.equal(selected.length, 2);
  assert(selected.every((set) => set.logicalSlot === 4));
  assert.deepEqual(
    selected.map((set) => [set.save.name, set.savePointLabel]),
    [
      ["save8.hg", "Restore Point"],
      ["save7.hg", "Autosave"],
    ],
  );
  assert(selected.every((set) => !("alternateSnapshots" in set)));
  assert(selected.every((set) => !("snapshotCount" in set)));

  const withUnsafeLatest = sets.map((set) => ({
    ...set,
    ready: set.save.name !== "save8.hg",
  }));
  const safelyOrdered = choosePreferredSaveSets(withUnsafeLatest);
  assert.deepEqual(
    safelyOrdered.map((set) => set.save.name),
    ["save7.hg", "save8.hg"],
  );
});
