import lz4 from "lz4js";
import { cloneJson } from "./nms-codec.js";
import { resolveSaveContext } from "./context-resolver.js";
import packedSaveTemplates from "./data/save-templates-packed.js";

export const SAVE_TEMPLATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "god",
    tier: "Complete loadout",
    name: "Full Progression",
    kind: "full",
    summary:
      "9 populated ships, 4 populated multitools, an S-class freighter, 30 frigates, 4 companions, max slot layouts, stocked inventories and boosted currencies.",
    detail:
      "Replaces all 243 supplied player-state fields plus spawn state, then applies Atlas Natural 100%, full convenience and integrity repair so current legitimate unlocks are not left behind.",
    destructiveLabel: "character, inventory, ships, multitools, fleet, bases and mission progress",
    completionOptions: Object.freeze({
      rewards: true,
      blueprints: true,
      languageAndSlots: true,
      catalogue: true,
      naturalProgression: true,
      repairIntegrity: true,
      progressionConveniences: true,
    }),
  }),
  Object.freeze({
    id: "demigod",
    tier: "Balanced loadout",
    name: "Explorer Progression",
    kind: "full",
    summary:
      "Starter ship and multitool, a C-class freighter, 1 frigate, expanded suit/technology capacity, boosted currencies and broad story progression without the full fleet and collection.",
    detail:
      "Replaces all 243 supplied player-state fields plus spawn state while preserving current wrapper fields that the older template does not contain.",
    destructiveLabel: "character, inventory, ships, multitools, fleet, bases and mission progress",
    completionOptions: null,
  }),
  Object.freeze({
    id: "missions",
    tier: "Missions only",
    name: "Mission Progress",
    kind: "missions",
    summary:
      "Installs 511 unique completed Voyagers mission-progress records while preserving the selected save’s character, inventory, currencies, ships, multitools, freighter, companions and bases.",
    detail:
      "The supplied file is a mission array rather than a full save, so Atlas performs a targeted MissionProgress replacement instead of pretending it can safely replace the entire slot.",
    destructiveLabel: "mission progress",
    completionOptions: null,
  }),
]);

const definitionById = new Map(
  SAVE_TEMPLATE_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const decoder = new TextDecoder("utf-8", { fatal: true });

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function loadPackedTemplate(id) {
  const packed = packedSaveTemplates[id];
  const definition = definitionById.get(id);
  if (!packed || !definition || packed.kind !== definition.kind) {
    throw new Error(`Unknown or malformed save template: ${id}`);
  }
  const decompressed = lz4.decompress(bytesFromBase64(packed.base64));
  if (decompressed.length !== packed.jsonBytes) {
    throw new Error(`${definition.name} did not decompress to its verified size.`);
  }
  const value = JSON.parse(decoder.decode(decompressed));
  validateDecodedTemplate(value, definition);
  return value;
}

function validateDecodedTemplate(value, definition) {
  if (definition.kind === "missions") {
    if (!Array.isArray(value) || value.length !== 511) {
      throw new Error(`${definition.name} must contain exactly 511 mission records.`);
    }
    const ids = value.map((record) => String(record?.Mission || ""));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new Error(`${definition.name} contains a missing or duplicate mission ID.`);
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${definition.name} is not a full player-state template.`);
  }
  if (
    !value.PlayerStateData ||
    typeof value.PlayerStateData !== "object" ||
    !value.SpawnStateData ||
    typeof value.SpawnStateData !== "object"
  ) {
    throw new Error(`${definition.name} is missing player or spawn state.`);
  }
  if (Object.keys(value.PlayerStateData).length !== 243) {
    throw new Error(`${definition.name} does not contain the audited 243 player-state fields.`);
  }
}

function dedupePrimitiveArray(values) {
  return Array.isArray(values) ? [...new Set(values)] : values;
}

function repairWordGroups(values) {
  if (!Array.isArray(values)) return values;
  const byGroup = new Map();
  for (const value of values) {
    if (!value || typeof value !== "object" || !value.Group) continue;
    const current = byGroup.get(value.Group);
    if (!current) {
      byGroup.set(value.Group, value);
      continue;
    }
    const races = Array.isArray(value.Races) ? value.Races : [];
    if (!Array.isArray(current.Races)) current.Races = [];
    const length = Math.max(current.Races.length, races.length);
    for (let index = 0; index < length; index += 1) {
      current.Races[index] = Boolean(current.Races[index] || races[index]);
    }
  }
  return [...byGroup.values()];
}

function sanitizePlayerState(player, master) {
  const primitiveLists = [
    "KnownProducts",
    "KnownSpecials",
    "KnownTech",
    "KnownRefinerRecipes",
    "RedeemedSeasonRewards",
    "RedeemedTwitchRewards",
    "RedeemedPlatformRewards",
    "SeenBaseBuildingObjects",
  ];
  let duplicatesRemoved = 0;
  for (const field of primitiveLists) {
    if (!Array.isArray(player[field])) continue;
    const before = player[field].length;
    player[field] = dedupePrimitiveArray(player[field]);
    duplicatesRemoved += before - player[field].length;
  }
  const blocked = new Set(master.disallowedKnownTechnologies || []);
  const knownTech = Array.isArray(player.KnownTech) ? player.KnownTech : [];
  const removedTechnologies = knownTech.filter((id) => blocked.has(id));
  player.KnownTech = knownTech.filter((id) => !blocked.has(id));
  const wordGroupsBefore = Array.isArray(player.KnownWordGroups)
    ? player.KnownWordGroups.length
    : 0;
  player.KnownWordGroups = repairWordGroups(player.KnownWordGroups) || [];
  duplicatesRemoved += wordGroupsBefore - player.KnownWordGroups.length;
  return {
    duplicatesRemoved,
    removedTechnologies,
  };
}

function completeIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const identity = Object.fromEntries(
    ["PTK", "USN", "UID", "LID"].map((key) => [key, String(value[key] || "").trim()]),
  );
  return Object.values(identity).every(Boolean) ? identity : null;
}

function identityKey(identity) {
  return [identity.PTK, identity.USN, identity.UID, identity.LID].join("|");
}

function inferDestinationOwner(player) {
  const counts = new Map();
  for (const base of player?.PersistentPlayerBases || []) {
    const identity = completeIdentity(base?.Owner);
    if (!identity) continue;
    const key = identityKey(identity);
    const current = counts.get(key) || { identity, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const ranked = [...counts.values()].sort((left, right) => right.count - left.count);
  if (!ranked.length || (ranked[1] && ranked[0].count === ranked[1].count)) return null;
  return ranked[0].identity;
}

function rebindImportedBases(player, destinationOwner) {
  if (!destinationOwner || !Array.isArray(player.PersistentPlayerBases)) return 0;
  let changed = 0;
  for (const base of player.PersistentPlayerBases) {
    if (!base || typeof base !== "object") continue;
    base.Owner = { ...destinationOwner, TS: Number(base.Owner?.TS || 0) };
    if ("LastEditedById" in base) base.LastEditedById = "";
    if ("LastEditedByUsername" in base) base.LastEditedByUsername = "";
    changed += 1;
  }
  return changed;
}

const OWNER_BOUND_PLAYER_FIELDS = Object.freeze([
  "PersistentPlayerBases",
  "SettlementStatesV2",
  "Pets",
  "Eggs",
]);

function rebindIdentityRecords(value, destinationOwner) {
  let changed = 0;
  function visit(current) {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== "object") return;
    if (["PTK", "USN", "UID", "LID"].some((key) => key in current)) {
      const timestamp = Number(current.TS || 0);
      for (const [key, replacement] of Object.entries(destinationOwner)) {
        current[key] = replacement;
      }
      if ("TS" in current) current.TS = timestamp;
      changed += 1;
    }
    for (const child of Object.values(current)) visit(child);
  }
  visit(value);
  return changed;
}

function registerOwner(save, identity) {
  const owners = save?.CommonStateData?.UsedDiscoveryOwnersV2;
  if (!identity || !Array.isArray(owners)) return false;
  const key = identityKey(identity);
  const current = owners.find((owner) => {
    const normalized = completeIdentity(owner);
    return normalized && identityKey(normalized) === key;
  });
  if (current) return false;
  owners.push({ ...identity, TS: 0 });
  return true;
}

function containsStringFragment(value, fragment) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string" && current.includes(fragment)) return true;
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current && typeof current === "object") {
      pending.push(...Object.values(current));
    }
  }
  return false;
}

export function getSaveTemplateDefinition(id) {
  const definition = definitionById.get(id);
  if (!definition) throw new Error(`Unknown save template: ${id}`);
  return definition;
}

export function applySaveTemplate(
  inputSave,
  id,
  master,
  contextPreference = "active",
) {
  const definition = getSaveTemplateDefinition(id);
  const source = loadPackedTemplate(id);
  const save = cloneJson(inputSave);
  const context = resolveSaveContext(save, contextPreference);

  if (definition.kind === "missions") {
    context.playerState.MissionProgress = source;
    return {
      save,
      definition,
      context,
      changedFields: ["MissionProgress"],
      missionCount: source.length,
      sanitization: { duplicatesRemoved: 0, removedTechnologies: [] },
      basesRebound: 0,
      identityRecordsRebound: 0,
      ownerBoundFieldsPreserved: [],
      destinationOwnerDetected: false,
    };
  }

  const destinationPlayer = context.playerState;
  const destinationOwner = inferDestinationOwner(destinationPlayer);
  const templatePlayer = source.PlayerStateData;
  const sanitization = sanitizePlayerState(templatePlayer, master);
  let basesRebound = 0;
  let identityRecordsRebound = 0;
  const ownerBoundFieldsPreserved = [];
  if (destinationOwner) {
    basesRebound = rebindImportedBases(templatePlayer, destinationOwner);
    for (const field of OWNER_BOUND_PLAYER_FIELDS.filter(
      (field) => field !== "PersistentPlayerBases",
    )) {
      identityRecordsRebound += rebindIdentityRecords(
        templatePlayer[field],
        destinationOwner,
      );
    }
    identityRecordsRebound += basesRebound;
  } else {
    for (const field of OWNER_BOUND_PLAYER_FIELDS) {
      delete templatePlayer[field];
      ownerBoundFieldsPreserved.push(field);
    }
  }
  Object.assign(destinationPlayer, templatePlayer);
  context.root.SpawnStateData = source.SpawnStateData;
  if (context.type === "legacy" && "GameMode" in save) {
    save.GameMode = source.GameMode;
  } else if ("GameMode" in context.root) {
    context.root.GameMode = source.GameMode;
  }
  registerOwner(save, destinationOwner);
  if (containsStringFragment(context.root.PlayerStateData, "ATLAS_TEMPLATE")) {
    throw new Error(
      `${definition.name} still contains a source identity placeholder after rebinding.`,
    );
  }

  return {
    save,
    definition,
    context: resolveSaveContext(save, contextPreference),
    changedFields: [
      ...Object.keys(source.PlayerStateData),
      "SpawnStateData",
    ],
    missionCount: templatePlayer.MissionProgress?.length || 0,
    sanitization,
    basesRebound,
    identityRecordsRebound,
    ownerBoundFieldsPreserved,
    destinationOwnerDetected: Boolean(destinationOwner),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function templateVerificationJson(save, id, contextPreference = "active") {
  const definition = getSaveTemplateDefinition(id);
  const context = resolveSaveContext(save, contextPreference);
  const value = definition.kind === "missions"
    ? context.playerState.MissionProgress
    : {
        PlayerStateData: context.playerState,
        SpawnStateData: context.spawnState,
      };
  return JSON.stringify(canonicalize(value));
}
