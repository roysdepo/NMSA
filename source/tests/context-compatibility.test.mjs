import assert from "node:assert/strict";
import test from "node:test";
import lz4 from "lz4js";
import master from "../src/data/index.js";
import { analyzeCompletion, completeUnlocks } from "../src/completion.js";
import { inspectCompatibility } from "../src/compatibility.js";
import { resolveSaveContext } from "../src/context-resolver.js";
import { buildChangePreview } from "../src/change-preview.js";
import {
  HGSAVEV2_LIMITS,
  decodeAdapterFile,
  decodePortableManifest,
  encodeAdapterFile,
  updatePortableManifest,
  updateXboxMeta,
  validatePortableManifest,
} from "../src/platform-adapters.js";

const HGSAVEV2_MAGIC = new TextEncoder().encode("HGSAVEV2\0");

function literalOnlyLz4Block(source) {
  const extraLengthBytes =
    source.length < 15 ? 0 : Math.floor((source.length - 15) / 255) + 1;
  const result = new Uint8Array(1 + extraLengthBytes + source.length);
  result[0] = Math.min(source.length, 15) << 4;
  let output = 1;
  if (source.length >= 15) {
    let remaining = source.length - 15;
    while (remaining >= 255) {
      result[output++] = 255;
      remaining -= 255;
    }
    result[output++] = remaining;
  }
  result.set(source, output);
  return result;
}

function compressRawLz4(source) {
  const destination = new Uint8Array(lz4.compressBound(source.length));
  const hashTable = new Uint32Array(1 << 16);
  const length = lz4.compressBlock(source, destination, 0, source.length, hashTable);
  return length > 0 ? destination.slice(0, length) : literalOnlyLz4Block(source);
}

function buildHgSaveV2(rawFrames) {
  const frames = rawFrames.map((raw) => ({ raw, compressed: compressRawLz4(raw) }));
  const size = HGSAVEV2_MAGIC.length + frames.reduce(
    (total, frame) => total + 8 + frame.compressed.length,
    0,
  );
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(HGSAVEV2_MAGIC);
  let offset = HGSAVEV2_MAGIC.length;
  for (const frame of frames) {
    view.setUint32(offset, frame.raw.length, true);
    view.setUint32(offset + 4, frame.compressed.length, true);
    offset += 8;
    bytes.set(frame.compressed, offset);
    offset += frame.compressed.length;
  }
  return bytes;
}

function buildDeclaredHgSaveV2(frameCount, rawLength, compressedLength = 1) {
  const bytes = new Uint8Array(HGSAVEV2_MAGIC.length + frameCount * (8 + compressedLength));
  const view = new DataView(bytes.buffer);
  bytes.set(HGSAVEV2_MAGIC);
  let offset = HGSAVEV2_MAGIC.length;
  for (let index = 0; index < frameCount; index += 1) {
    view.setUint32(offset, rawLength, true);
    view.setUint32(offset + 4, compressedLength, true);
    offset += 8 + compressedLength;
  }
  return bytes;
}

function player() {
  return {
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
    UnlockedPetSlots: [false],
    SquadronUnlockedPilotSlots: [false],
    PersistentPlayerBases: [],
    RevealBlackHoles: false,
    HasAccessToNexus: false,
    BuildersKnown: false,
    HasDiscoveredPurpleSystems: false,
  };
}

function settings() {
  return {
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

test("active expedition context is completed without modifying the main context", () => {
  const save = {
    Version: master.testedGameVersion,
    ActiveContext: "Season",
    CommonStateData: { UsedDiscoveryOwnersV2: [] },
    BaseContext: { PlayerStateData: player() },
    ExpeditionContext: { PlayerStateData: { ...player(), StartingSeasonNumber: 22 } },
    DiscoveryManagerData: { "DiscoveryData-v1": { Store: { Record: [] } } },
  };
  const account = { UserSettingsData: settings() };
  assert.equal(resolveSaveContext(save).type, "expedition");
  assert.equal(analyzeCompletion(save, account, master).context.type, "expedition");
  const result = completeUnlocks(
    save,
    account,
    master,
    {
      rewards: false,
      blueprints: false,
      languageAndSlots: false,
      catalogue: false,
      repairIntegrity: false,
      progressionConveniences: true,
    },
  );
  assert.equal(result.save.ExpeditionContext.PlayerStateData.HasAccessToNexus, true);
  assert.equal(result.save.BaseContext.PlayerStateData.HasAccessToNexus, false);
  assert.equal(result.save.ActiveContext, "Season");
});

test("scoped ownership preview matches the records actually changed", () => {
  const primary = { PTK: "ST", UID: "primary", LID: "local-1", USN: "Primary" };
  const alias = { PTK: "XB", UID: "alias", LID: "local-2", USN: "Alias" };
  const activePlayer = player();
  activePlayer.PersistentPlayerBases = [{
    Owner: { PTK: "ST", UID: "foreign", LID: "x", USN: "Foreign", TS: 4 },
    LastEditedById: "editor",
    LastEditedByUsername: "Editor",
  }];
  const save = {
    Version: master.testedGameVersion,
    CommonStateData: {
      UsedDiscoveryOwnersV2: [
        { PTK: "ST", UID: "primary", LID: "old", USN: "Old", TS: 1 },
        { PTK: "PS", UID: "foreign", LID: "f", USN: "Foreign", TS: 2 },
      ],
    },
    BaseContext: { PlayerStateData: activePlayer },
    DiscoveryManagerData: {
      "DiscoveryData-v1": {
        Store: {
          Record: [
            { OWS: { PTK: "XB", UID: "alias", LID: "old", USN: "Old alias", TS: 3 } },
            { OWS: { PTK: "PS", UID: "foreign", LID: "f", USN: "Foreign", TS: 4 } },
          ],
        },
      },
    },
  };
  const account = { UserSettingsData: settings() };
  const options = {
    rewards: false,
    blueprints: false,
    languageAndSlots: false,
    catalogue: false,
    repairIntegrity: false,
    progressionConveniences: false,
  };
  const ownership = {
    enabled: true,
    primary,
    aliases: [alias],
    normalizeBases: true,
    normalizeMatchingDiscoveries: true,
    clearBaseEditorLabels: true,
  };
  const analysis = analyzeCompletion(save, account, master);
  const preview = buildChangePreview(analysis, options, ownership);
  const result = completeUnlocks(save, account, master, options, ownership);
  assert.equal(preview.total, 5);
  assert.equal(result.report.ownership.totalChanges, preview.total);
  assert.equal(result.report.ownership.discoveriesNormalized, 1);
  assert.equal(result.save.DiscoveryManagerData["DiscoveryData-v1"].Store.Record[1].OWS.UID, "foreign");
});

test("newer saves remain analyzable but are blocked from writing", () => {
  const current = inspectCompatibility({
    save: { Version: master.testedGameVersion },
    account: { Version: 1 },
    manifestFormat: 2004,
    accountManifestFormat: 2004,
    platform: "steam",
    master,
  });
  assert.equal(current.writeAllowed, true);
  const currentWithoutAccountManifest = inspectCompatibility({
    save: { Version: master.testedGameVersion },
    account: { Version: 1 },
    manifestFormat: 2004,
    accountManifestFormat: null,
    platform: "steam",
    manifestValid: true,
    accountManifestValid: true,
    master,
  });
  assert.equal(currentWithoutAccountManifest.accountFormat, 2004);
  assert.equal(currentWithoutAccountManifest.writeAllowed, true);
  const future = inspectCompatibility({
    save: { Version: master.testedGameVersion + 1 },
    account: { Version: 1 },
    manifestFormat: 2004,
    accountManifestFormat: 2004,
    platform: "steam",
    master,
  });
  assert.equal(future.analysisAllowed, true);
  assert.equal(future.writeAllowed, false);
  assert.equal(future.newerThanData, true);

  const old = inspectCompatibility({
    save: { Version: master.minimumWritableGameVersion - 1 },
    account: { Version: 1 },
    manifestFormat: 2004,
    accountManifestFormat: 2004,
    platform: "steam",
    master,
  });
  assert.equal(old.analysisAllowed, true);
  assert.equal(old.writeAllowed, false);
  assert.equal(old.olderThanWritableBaseline, true);
});

test("only exact container-preserving PC adapters are writable", () => {
  for (const platform of ["steam", "gog"]) {
    const compatibility = inspectCompatibility({
      save: { Version: master.testedGameVersion },
      account: { Version: 1 },
      manifestFormat: 2004,
      accountManifestFormat: 2004,
      platform,
      master,
    });
    assert.equal(compatibility.platformKnown, true, platform);
    assert.equal(compatibility.platformWritable, true, platform);
    assert.equal(compatibility.writeAllowed, true, platform);
  }

  for (const platform of [
    "xbox-game-pass",
    "playstation-extracted",
    "switch-extracted",
  ]) {
    const compatibility = inspectCompatibility({
      save: { Version: master.testedGameVersion },
      account: { Version: 1 },
      manifestFormat: 2004,
      accountManifestFormat: 2004,
      platform,
      master,
    });
    assert.equal(compatibility.platformKnown, true, platform);
    assert.equal(compatibility.analysisAllowed, true, platform);
    assert.equal(compatibility.platformWritable, false, platform);
    assert.equal(compatibility.writeAllowed, false, platform);
    assert.match(compatibility.reasons.at(-1), /writing is disabled/i, platform);
  }
});

test("portable manifests remain readable but metadata updates are blocked", () => {
  const bytes = new Uint8Array(380).fill(0x5a);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xca55e77e, true);
  view.setUint32(4, 2004, true);
  view.setUint32(8, 100, true);
  view.setUint32(12, 2, true);
  view.setUint32(36, 100, true);
  const manifest = decodePortableManifest(bytes, 2);
  assert.equal(validatePortableManifest(manifest, { decompressedLength: 100 }), true);
  assert.equal(manifest.bytes[100], 0x5a);
  assert.throws(
    () => updatePortableManifest(manifest, 1234),
    /metadata writing is disabled/i,
  );
});

test("console containers remain readable while every console encoder is blocked", () => {
  const json = new TextEncoder().encode('{"Version":4733,"value":7}\u0000');
  const psBytes = new Uint8Array(0x70 + json.length);
  psBytes.set(new TextEncoder().encode("NOMANSKY"));
  new DataView(psBytes.buffer).setUint32(0x5c, json.length, true);
  psBytes.set(json, 0x70);
  const psRecord = { adapter: "playstation-extracted", bytes: psBytes };
  const ps = decodeAdapterFile(psRecord, {}, null, "save");
  assert.deepEqual(ps.value, { Version: 4733, value: 7 });

  const xboxValue = { Version: 4098, value: "account" };
  const xboxRaw = new TextEncoder().encode(JSON.stringify(xboxValue));
  const xboxBytes = compressRawLz4(xboxRaw);
  const meta = new Uint8Array(20);
  new DataView(meta.buffer).setUint32(16, xboxRaw.length, true);
  const xbox = decodeAdapterFile(
    { adapter: "xbox-game-pass", bytes: xboxBytes },
    {},
    { bytes: meta },
    "account",
  );
  assert.deepEqual(xbox.value, xboxValue);

  const switchValue = { Version: 4733, value: "switch" };
  const switchSave = decodeAdapterFile(
    {
      adapter: "switch-extracted",
      bytes: new TextEncoder().encode(JSON.stringify(switchValue)),
    },
    {},
    null,
    "save",
  );
  assert.deepEqual(switchSave.value, switchValue);

  for (const adapter of [
    "xbox-game-pass",
    "playstation-extracted",
    "switch-extracted",
  ]) {
    assert.throws(
      () => encodeAdapterFile(
        { Version: 4733 },
        {},
        { adapter, compressed: false },
        "save",
      ),
      /writing is disabled/i,
      adapter,
    );
  }
  assert.throws(
    () => updateXboxMeta({ bytes: meta }, xboxRaw.length, "account"),
    /Xbox writing is disabled/i,
  );
});

test("HGSAVEV2 multi-frame saves remain readable", () => {
  const raw = new TextEncoder().encode('{"Version":4733,"value":"two frames"}\u0000');
  const split = Math.floor(raw.length / 2);
  const bytes = buildHgSaveV2([raw.slice(0, split), raw.slice(split)]);
  const decoded = decodeAdapterFile(
    { adapter: "xbox-game-pass", bytes },
    {},
    null,
    "save",
  );
  assert.deepEqual(decoded.value, { Version: 4733, value: "two frames" });
  assert.equal(decoded.platformEncoding, "hgsavev2");
});

test("HGSAVEV2 rejects unsafe frame, aggregate, and frame-count declarations before decoding", () => {
  assert.throws(
    () => decodeAdapterFile(
      {
        adapter: "xbox-game-pass",
        bytes: buildDeclaredHgSaveV2(
          1,
          HGSAVEV2_LIMITS.maxFrameDecompressedBytes + 1,
        ),
      },
      {},
    ),
    /frame exceeds the decompressed safety limit/,
  );

  const aggregateFrames =
    Math.floor(
      HGSAVEV2_LIMITS.maxDecompressedBytes /
        HGSAVEV2_LIMITS.maxFrameDecompressedBytes,
    ) + 1;
  assert.throws(
    () => decodeAdapterFile(
      {
        adapter: "xbox-game-pass",
        bytes: buildDeclaredHgSaveV2(
          aggregateFrames,
          HGSAVEV2_LIMITS.maxFrameDecompressedBytes,
        ),
      },
      {},
    ),
    /aggregate output exceeds the decompressed safety limit/,
  );

  assert.throws(
    () => decodeAdapterFile(
      {
        adapter: "xbox-game-pass",
        bytes: buildDeclaredHgSaveV2(HGSAVEV2_LIMITS.maxFrames + 1, 1),
      },
      {},
    ),
    /too many frames/,
  );

  const compressedLimit = lz4.compressBound(1);
  assert.throws(
    () => decodeAdapterFile(
      {
        adapter: "xbox-game-pass",
        bytes: buildDeclaredHgSaveV2(1, 1, compressedLimit + 1),
      },
      {},
    ),
    /frame exceeds the compressed safety limit/,
  );
});
