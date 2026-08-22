import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompletionReloaded,
  completionReloadDifferences,
  findMatchingSaveSet,
  prepareTargetedReload,
  saveSetIdentity,
} from "../src/post-install.js";

function slot(overrides = {}) {
  return {
    platform: "steam",
    directory: "st_NMSA_TEST_PROFILE",
    profileName: "st_NMSA_TEST_PROFILE",
    logicalSlot: 5,
    storageOrdinal: 9,
    save: { name: "save8.hg" },
    ...overrides,
  };
}

test("post-install identity identifies the exact save slot", () => {
  const selected = slot();
  const identity = saveSetIdentity(selected);
  const match = findMatchingSaveSet([
    slot({ storageOrdinal: 10, save: { name: "save9.hg" } }),
    selected,
    slot({ directory: "st_other", profileName: "st_other" }),
  ], identity);
  assert.equal(match, selected);
});

test("post-install identity rejects missing or ambiguous targets", () => {
  const identity = saveSetIdentity(slot());
  assert.equal(findMatchingSaveSet([], identity), null);
  assert.equal(findMatchingSaveSet([slot(), slot()], identity), null);
});

test("targeted reload drops only changed record caches", () => {
  const bytes = (value) => new Uint8Array([value]);
  const selected = slot({
    _inspection: { stale: true },
    save: { name: "save8.hg", token: "save", bytes: bytes(1) },
    saveMeta: { name: "mf_save8.hg", token: "save-meta", bytes: bytes(2) },
    account: { name: "accountdata.hg", token: "account", bytes: bytes(3) },
    accountMeta: { name: "mf_accountdata.hg", token: "account-meta", bytes: bytes(4) },
    platformSettings: {
      name: "GCUSERSETTINGSDATA.MXML",
      token: "settings",
      bytes: bytes(5),
    },
  });

  const refreshed = prepareTargetedReload(selected, [
    "save",
    "saveMeta",
    "account",
    "platformSettings",
  ]);

  assert.equal("_inspection" in refreshed, false);
  assert.equal("bytes" in refreshed.save, false);
  assert.equal("bytes" in refreshed.saveMeta, false);
  assert.equal("bytes" in refreshed.account, false);
  assert.equal("bytes" in refreshed.platformSettings, false);
  assert.deepEqual(refreshed.accountMeta.bytes, bytes(4));
  assert.deepEqual(selected.save.bytes, bytes(1));
  assert.deepEqual(selected.account.bytes, bytes(3));
});

test("targeted reload discards legacy nested save-point caches", () => {
  const selected = slot({
    snapshotCount: 2,
    alternateSnapshots: [{
      save: { name: "save9.hg", bytes: new Uint8Array([9]) },
      _inspection: { stale: true },
    }],
  });

  const refreshed = prepareTargetedReload(selected, ["save"]);

  assert.equal("alternateSnapshots" in refreshed, false);
  assert.equal("snapshotCount" in refreshed, false);
  assert.equal(selected.alternateSnapshots.length, 1);
});

test("post-install completion proof compares the reopened disk state", () => {
  const expected = { missing: { naturalProgression: 0, titles: 0 } };
  const complete = { missing: { naturalProgression: 0, titles: 0 } };
  assert.deepEqual(completionReloadDifferences(expected, complete), []);
  assert.equal(assertCompletionReloaded(expected, complete), true);

  const stale = { missing: { naturalProgression: 6, titles: 0 } };
  assert.deepEqual(completionReloadDifferences(expected, stale), [
    { key: "naturalProgression", expected: 0, actual: 6 },
  ]);
  assert.throws(
    () => assertCompletionReloaded(expected, stale),
    /naturalProgression: expected 0, reopened 6/,
  );
});
