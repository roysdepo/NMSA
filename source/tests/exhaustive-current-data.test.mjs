import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import master from "../src/data/index.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(project, "../../..");
const referenceDirectory = path.join(
  workspace,
  "external-current-reference",
  "Resources",
  "json",
);
const requiredReferenceFiles = [
  "Fish.json",
  "Ship Customisation.json",
  "Rewards.json",
  "Recipes.json",
  "Titles.json",
  "Wiki Guide.json",
  "Words.json",
];
const hasCurrentComparisonData = requiredReferenceFiles.every((file) =>
  existsSync(path.join(referenceDirectory, file))
);

async function json(file) {
  return JSON.parse(await readFile(path.join(referenceDirectory, file), "utf8"));
}

function gameId(value) {
  const text = String(value || "");
  return text.startsWith("^") ? text : `^${text}`;
}

function assertSameSet(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  assert.equal(actualSet.size, actual.length, `${label}: Atlas duplicates`);
  assert.equal(expectedSet.size, expected.length, `${label}: source duplicates`);
  assert.deepEqual(
    [...actualSet].filter((item) => !expectedSet.has(item)),
    [],
    `${label}: Atlas-only entries`,
  );
  assert.deepEqual(
    [...expectedSet].filter((item) => !actualSet.has(item)),
    [],
    `${label}: omitted current entries`,
  );
}

test(
  "the current comparison snapshot cannot expose an omitted finite unlock or record row",
  { skip: !hasCurrentComparisonData },
  async () => {
    const fish = await json("Fish.json");
    assertSameSet(
      master.fishingRecords.map((record) => record.productId),
      fish.map((record) => gameId(record.Id)),
      "fishing records",
    );
    const fishById = new Map(fish.map((record) => [gameId(record.Id), record]));
    for (const record of master.fishingRecords) {
      assert.equal(
        record.size,
        fishById.get(record.productId)?.FishSize,
        record.productId,
      );
    }

    const shipCustomisation = await json("Ship Customisation.json");
    const shipParts = shipCustomisation.flatMap((configuration) =>
      configuration.Slots.flatMap((slot) =>
        slot.Items.map((item) => gameId(item.ItemID))
      )
    );
    shipParts.push(
      "^SHIP_CORE_C",
      "^SHIP_CORE_B",
      "^SHIP_CORE_A",
      "^SHIP_CORE_S",
    );
    assertSameSet(
      master.speculativeShipComponentRecords,
      [...new Set(shipParts)],
      "starship component records",
    );

    const rewards = await json("Rewards.json");
    for (const [category, values] of [
      ["season", master.seasonRewards],
      ["twitch", master.twitchRewards],
      ["platform", master.platformRewards],
      ["entitlement", master.contentEntitlements],
    ]) {
      assertSameSet(
        values,
        rewards
          .filter((reward) => reward.Category === category)
          .map((reward) => gameId(reward.Id)),
        `${category} rewards`,
      );
    }

    assertSameSet(
      master.refinerRecipes,
      (await json("Recipes.json")).map((recipe) => gameId(recipe.Id)),
      "recipes",
    );
    assertSameSet(
      master.titles,
      (await json("Titles.json")).map((title) => gameId(title.Id)),
      "titles",
    );
    assertSameSet(
      master.wikiTopics,
      (await json("Wiki Guide.json")).map((topic) => gameId(topic.Id)),
      "wiki topics",
    );

    const titleRows = await json("Titles.json");
    const titleStatIds = new Set(
      titleRows
        .filter((title) => title.UnlockedByStat)
        .map((title) => gameId(title.UnlockedByStat)),
    );
    assert.equal(titleStatIds.size, 78);
    const titleRequirements = new Map();
    for (const title of titleRows) {
      if (!title.UnlockedByStat || Number(title.UnlockedByStatValue) <= 0) continue;
      const id = gameId(title.UnlockedByStat);
      titleRequirements.set(
        id,
        Math.max(
          Number(title.UnlockedByStatValue),
          titleRequirements.get(id) ?? 0,
        ),
      );
    }
    const progression = new Map(
      master.naturalProgressionTargets.map((target) => [target.id, target]),
    );
    assert.deepEqual(
      [...titleStatIds].filter((id) => !progression.has(id)),
      [],
      "title-backed statistic families were omitted",
    );
    for (const [id, threshold] of titleRequirements) {
      const target = progression.get(id);
      assert(target, `${id}: title-backed statistic omitted`);
      if (target.target !== undefined) {
        assert(
          Number(target.target) >= threshold,
          `${id}: ${target.target} is below title threshold ${threshold}`,
        );
      } else {
        assert.equal(target.source, "knownWordGroups", id);
      }
    }

    const wordGroups = new Set(
      (await json("Words.json")).flatMap((word) => Object.keys(word.Groups ?? {})),
    );
    const atlasWordGroups = new Set(master.wordGroups.map((group) => group.Group));
    assert.deepEqual(
      [...wordGroups].filter((group) => !atlasWordGroups.has(group)),
      [],
      "word groups: omitted current entries",
    );

    const allJsonFiles = (await readdir(referenceDirectory))
      .filter((file) => file.endsWith(".json"));
    const tables = new Map();
    for (const file of allJsonFiles) {
      const value = await json(file);
      if (Array.isArray(value)) tables.set(file, value);
    }
    const substances = [];
    for (const rows of tables.values()) {
      for (const row of rows) {
        if (row?.SourceTable === "Substance") substances.push(gameId(row.Id));
      }
    }
    assertSameSet(
      master.seenSubstances,
      [...new Set(substances)],
      "substance records",
    );

    const coveredProductRows = new Set([
      ...master.knownProducts,
      ...master.contextualKnownProducts,
      ...master.knownSpecials,
      ...master.knownTechnologies,
      ...master.disallowedKnownTechnologies,
      ...master.catalogueRecordProducts,
      ...master.fishingRecords.map((record) => record.productId),
      ...master.seenSubstances,
    ]);
    const productTables = [
      "Buildings.json",
      "Constructed Technology.json",
      "Corvette.json",
      "Curiosities.json",
      "Exocraft.json",
      "Fish.json",
      "Food.json",
      "Others.json",
      "Products.json",
      "Starships.json",
      "Technology Module.json",
      "Technology.json",
      "Trade.json",
    ];
    const omittedProductRows = productTables.flatMap((file) =>
      (tables.get(file) ?? [])
        .map((row) => gameId(row.Id))
        .filter((id) => !coveredProductRows.has(id))
    );
    assertSameSet(omittedProductRows, [
      "^PIPESHAPE",
      "^CURVEPIPESHAPE",
      "^BONE_TEMP",
      "^BAIT_MEAT_1",
      "^BAIT_MEAT_2",
      "^BAIT_MEAT_3",
      "^BAIT_MEAT_4",
      "^BAIT_VEG_1",
      "^BAIT_VEG_2",
      "^BAIT_VEG_3",
      "^BAIT_VEG_4",
    ], "explicit internal/temporary product exclusions");

    const upgradeRows = (tables.get("Upgrades.json") ?? [])
      .map((row) => gameId(row.Id))
      .filter((id) => !coveredProductRows.has(id));
    assert(
      upgradeRows.every((id) => /^\^(?:UP|CV|UA)_/.test(id)),
      "unclassified non-finite upgrade rows were found",
    );
    const definitionCounts = new Map(
      master.completionCoverage.definitionOnlyFamilies.map((family) => [
        family.key,
        family.currentRows,
      ]),
    );
    for (const [key, file] of [
      ["colourPalettes", "Colour Palettes.json"],
      ["companionAccessories", "Companion Accessories.json"],
      ["creatureDescriptors", "Creature Descriptors.json"],
      ["creatureSpecies", "Creature Species.json"],
      ["frigateTraits", "Frigate Traits.json"],
      ["settlementPerks", "Settlement Perks.json"],
      ["petBattleMoves", "Pet Battle Moves.json"],
      ["petBattleMovesets", "Pet Battle Movesets.json"],
    ]) {
      assert.equal(
        definitionCounts.get(key),
        (tables.get(file) ?? []).length,
        `${key}: definition-only audit count is stale`,
      );
    }
    assert.equal(
      definitionCounts.get("proceduralUpgradeModules"),
      upgradeRows.length,
      "proceduralUpgradeModules: definition-only audit count is stale",
    );
  },
);
