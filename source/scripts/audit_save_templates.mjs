import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import master from "../src/data/index.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = path.join(project, "src", "data");

async function load(name) {
  return JSON.parse(await readFile(path.join(dataDirectory, name), "utf8"));
}

const [god, demigod, missions] = await Promise.all([
  load("arcane-god-save.json"),
  load("arcane-demigod-save.json"),
  load("arcane-voyagers-missions.json"),
]);

function assertTemplateRoot(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (!value.PlayerStateData || !value.SpawnStateData) {
    throw new Error(`${label} must contain PlayerStateData and SpawnStateData.`);
  }
}

assertTemplateRoot(god, "God template");
assertTemplateRoot(demigod, "Demigod template");
if (!Array.isArray(missions) || !missions.length) {
  throw new Error("Voyagers mission template must be a non-empty array.");
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function difference(left, right) {
  const key = (value) =>
    value && typeof value === "object" ? JSON.stringify(value) : String(value);
  const rightSet = new Set(right.map(key));
  const unique = new Map(left.map((item) => [key(item), item]));
  return [...unique.entries()]
    .filter(([itemKey]) => !rightSet.has(itemKey))
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([, item]) => item);
}

function inventorySummary(inventory) {
  const slots = Array.isArray(inventory?.Slots) ? inventory.Slots : [];
  const validSlots = slots.filter((slot) => slot && slot.Type?.InventoryType !== "None");
  return {
    width: Number(inventory?.Width || 0),
    height: Number(inventory?.Height || 0),
    occupiedSlots: validSlots.length,
    validSlotCount: Array.isArray(inventory?.ValidSlotIndices)
      ? inventory.ValidSlotIndices.length
      : 0,
  };
}

function classCounts(values, classPath) {
  const output = {};
  for (const value of values || []) {
    let current = value;
    for (const key of classPath) current = current?.[key];
    const name = String(current || "Unknown");
    output[name] = (output[name] || 0) + 1;
  }
  return output;
}

function countIdentityPlaceholders(value) {
  let count = 0;
  function visit(current) {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== "object") return;
    if (current.UID === "ATLAS_TEMPLATE" || current.LID === "ATLAS_TEMPLATE") {
      count += 1;
    }
    for (const child of Object.values(current)) visit(child);
  }
  visit(value);
  return count;
}

const privateTextReplacements = new Map([
  ["Name", ""],
  ["CustomName", ""],
  ["CustomSpeciesName", ""],
  ["ArchivedName", ""],
  ["PlayerFreighterName", ""],
  ["LastEditedByUsername", "Template"],
  ["SaveSummary", "NMSA Template"],
]);

function assertSanitizedNames(value, label) {
  let count = 0;
  function visit(current, path = "$") {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      const childPath = `${path}.${key}`;
      if (typeof child === "string" && privateTextReplacements.has(key)) {
        const expected = privateTextReplacements.get(key);
        if (child !== expected) {
          throw new Error(`${label} contains an unsanitized name at ${childPath}.`);
        }
        count += 1;
      }
      visit(child, childPath);
    }
  }
  visit(value);
  return count;
}

const godSanitizedNames = assertSanitizedNames(god, "God template");
const demigodSanitizedNames = assertSanitizedNames(demigod, "Demigod template");

function summarizeFullTemplate(value) {
  const player = value.PlayerStateData;
  return {
    gameMode: value.GameMode,
    summary: player.SaveSummary,
    playerStateFieldCount: Object.keys(player).length,
    missionCount: player.MissionProgress?.length || 0,
    currencies: {
      units: player.Units,
      nanites: player.Nanites,
      quicksilver: player.Specials,
    },
    known: {
      products: player.KnownProducts?.length || 0,
      specials: player.KnownSpecials?.length || 0,
      technologies: player.KnownTech?.length || 0,
      wordGroups: player.KnownWordGroups?.length || 0,
      refinerRecipes: player.KnownRefinerRecipes?.length || 0,
    },
    assets: {
      ships: player.ShipOwnership?.length || 0,
      multitools: player.Multitools?.length || 0,
      frigates: player.FleetFrigates?.length || 0,
      squadronPilots: player.SquadronPilots?.length || 0,
      companions: player.Pets?.length || 0,
      vehicles: player.VehicleOwnership?.length || 0,
      bases: player.PersistentPlayerBases?.length || 0,
    },
    populatedAssets: {
      ships: (player.ShipOwnership || [])
        .filter((item) => String(item?.Resource?.Filename || "")).length,
      multitools: (player.Multitools || [])
        .filter((item) => String(item?.Resource?.Filename || "")).length,
      companions: (player.Pets || [])
        .filter((item) => String(item?.CreatureSeed?.[1] || "0x0") !== "0x0").length,
    },
    assetClasses: {
      ships: classCounts(player.ShipOwnership, ["Resource", "Filename"]),
      multitools: classCounts(player.Multitools, ["Resource", "Filename"]),
      frigates: classCounts(player.FleetFrigates, ["Class"]),
    },
    inventories: {
      exosuit: inventorySummary(player.Inventory),
      exosuitTechnology: inventorySummary(player.Inventory_TechOnly),
      activeShip: inventorySummary(player.ShipInventory),
      activeMultitool: inventorySummary(player.WeaponInventory),
      freighter: inventorySummary(player.FreighterInventory),
      freighterTechnology: inventorySummary(player.FreighterInventory_TechOnly),
    },
    difficulty: player.DifficultyState?.Settings || {},
  };
}

const godHashes = Object.fromEntries(
  Object.entries(god.PlayerStateData).map(([key, value]) => [key, sha256(value)]),
);
const demigodHashes = Object.fromEntries(
  Object.entries(demigod.PlayerStateData).map(([key, value]) => [key, sha256(value)]),
);
const differingPlayerStateFields = Object.keys(godHashes)
  .filter((key) => godHashes[key] !== demigodHashes[key])
  .sort();

const sourceUnlocks = {
  knownProducts: [
    ...(god.PlayerStateData.KnownProducts || []),
    ...(demigod.PlayerStateData.KnownProducts || []),
  ],
  knownSpecials: [
    ...(god.PlayerStateData.KnownSpecials || []),
    ...(demigod.PlayerStateData.KnownSpecials || []),
  ],
  knownTechnologies: [
    ...(god.PlayerStateData.KnownTech || []),
    ...(demigod.PlayerStateData.KnownTech || []),
  ],
  wordGroups: [
    ...(god.PlayerStateData.KnownWordGroups || []),
    ...(demigod.PlayerStateData.KnownWordGroups || []),
  ],
};

const atlasUnlocks = {
  knownProducts: master.knownProducts,
  knownSpecials: master.knownSpecials,
  knownTechnologies: master.knownTechnologies,
  wordGroups: master.wordGroups,
};

const sourceOnlyCandidates = Object.fromEntries(
  Object.keys(sourceUnlocks).map((key) => [
    key,
    difference(sourceUnlocks[key], atlasUnlocks[key]),
  ]),
);
const atlasEntriesMissingFromSources = Object.fromEntries(
  Object.keys(sourceUnlocks).map((key) => [
    key,
    difference(atlasUnlocks[key], sourceUnlocks[key]),
  ]),
);

const rewards = new Set([
  ...master.seasonRewards,
  ...master.twitchRewards,
  ...master.platformRewards,
  ...master.contentEntitlements,
]);
const sourceOnlyProductClassifications = {
  rewardOrEntitlement: sourceOnlyCandidates.knownProducts
    .filter((id) => rewards.has(id)),
  knownSpecial: sourceOnlyCandidates.knownProducts
    .filter((id) => master.knownSpecials.includes(id)),
  unclassified: sourceOnlyCandidates.knownProducts
    .filter((id) => !rewards.has(id) && !master.knownSpecials.includes(id)),
};

const missionIds = missions.map((record) => String(record?.Mission || ""));
const duplicateMissionIds = [...new Set(
  missionIds.filter((id, index) => id && missionIds.indexOf(id) !== index),
)].sort();

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceFiles: {
    god: "arcane-god-save.json",
    demigod: "arcane-demigod-save.json",
    missions: "arcane-voyagers-missions.json",
  },
  sourceHashes: {
    god: sha256(god),
    demigod: sha256(demigod),
    missions: sha256(missions),
  },
  privacy: {
    godIdentityPlaceholders: countIdentityPlaceholders(god),
    demigodIdentityPlaceholders: countIdentityPlaceholders(demigod),
    godSanitizedNameFields: godSanitizedNames,
    demigodSanitizedNameFields: demigodSanitizedNames,
    policy:
      "Source identities and user-authored names are removed before distribution. Runtime application " +
      "rebinds owner-bound records to an unambiguous destination owner or preserves " +
      "the destination's existing owner-bound fields.",
  },
  summaries: {
    god: summarizeFullTemplate(god),
    demigod: summarizeFullTemplate(demigod),
    missions: {
      recordCount: missions.length,
      uniqueMissionCount: new Set(missionIds).size,
      duplicateMissionIds,
      sourceIsPartialPlayerState: true,
    },
  },
  godVsDemigod: {
    differingPlayerStateFieldCount: differingPlayerStateFields.length,
    differingPlayerStateFields,
  },
  completionComparison: {
    sourceOnlyCandidates,
    sourceOnlyProductClassifications,
    atlasEntriesMissingFromSourcesCounts: Object.fromEntries(
      Object.entries(atlasEntriesMissingFromSources)
        .map(([key, values]) => [key, values.length]),
    ),
    note:
      "Source-only IDs are audit candidates, not automatically legitimate unlocks. " +
      "The supplied templates are not a current exhaustive completion database.",
  },
};

const destination = path.join(dataDirectory, "save-template-audit.json");
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`wrote ${destination}`);
console.log(JSON.stringify({ sourceHashes: report.sourceHashes, privacy: report.privacy }, null, 2));
