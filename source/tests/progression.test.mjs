import assert from "node:assert/strict";
import test from "node:test";
import master from "../src/data/index.js";
import {
  analyzeCompletion,
  completeUnlocks,
  verifyCompletion,
} from "../src/completion.js";

function fixture() {
  const player = {
    KnownProducts: [],
    SeenBaseBuildingObjects: [],
    KnownSpecials: [],
    KnownTech: [],
    KnownRefinerRecipes: [],
    KnownWordGroups: [
      { Group: "^TEST_ONE", Races: [true, true, false] },
      { Group: "^TEST_TWO", Races: [true, false, true] },
    ],
    RedeemedSeasonRewards: [],
    RedeemedTwitchRewards: [],
    RedeemedPlatformRewards: [],
    KnownPortalRunes: 0,
    UnlockedPetSlots: [],
    SquadronUnlockedPilotSlots: [],
    Stats: [
      {
        GroupId: "^GLOBAL_STATS",
        Address: 0,
        Stats: [
          { Id: "^DIST_WALKED", Value: { FloatValue: 500 } },
          { Id: "^ALIENS_MET", Value: { IntValue: 2_147_483_647 } },
          { Id: "^MONEY", Value: { IntValue: 5_000_000, FloatValue: 0 } },
          { Id: "^DISC_FLORA", Value: { IntValue: 356 } },
        ],
      },
    ],
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
  return {
    save: { BaseContext: { PlayerStateData: player } },
    account: { UserSettingsData: settings },
  };
}

const progressionOnly = {
  rewards: false,
  blueprints: false,
  languageAndSlots: false,
  catalogue: false,
  naturalProgression: true,
  repairIntegrity: false,
  progressionConveniences: false,
};

function stat(player, id) {
  return player.Stats[0].Stats.find((entry) => entry.Id === id);
}

test("natural progression uses current final-rank thresholds, never fantasy sentinels", () => {
  assert.equal(master.naturalProgressionTargets.length, 93);
  assert.equal(master.naturalStatRepairs.length, 51);
  assert.equal(
    master.naturalProgressionTargets.find((item) => item.id === "^DIST_WALKED").target,
    100_000,
  );
  assert.equal(
    master.naturalProgressionTargets.find((item) => item.id === "^MONEY").target,
    100_000_000,
  );
  assert.equal(
    master.naturalProgressionTargets.find((item) => item.id === "^PIRATE_STAND").target,
    150,
  );
  assert.equal(
    master.naturalProgressionTargets.find((item) => item.id === "^SMUGGLE_VALUE").target,
    50_000_000,
  );
  const additionalMaxima = {
    "^LONGEST_LIFE_EX": 43_200,
    "^TSEEN_SYSTEMS": 60,
    "^WSEEN_SYSTEMS": 60,
    "^ESEEN_SYSTEMS": 60,
    "^TDONE_MISSIONS": 60,
    "^WDONE_MISSIONS": 60,
    "^EDONE_MISSIONS": 60,
    "^NANITES_EVER": 100_000,
    "^WALKERS_KILLED": 40,
    "^PB_BOSS_WINS": 60,
    "^PB_WINS": 220,
    "^PB_PETS_MAXED": 20,
    "^PB_D_NEXUS": 30,
    "^EGGS_HATCHED": 30,
  };
  for (const [id, target] of Object.entries(additionalMaxima)) {
    assert.equal(
      master.naturalProgressionTargets.find((item) => item.id === id)?.target,
      target,
      id,
    );
  }
  const guildMaxima = {
    "^TGUILD_STAND": 100,
    "^TGDONE_MISSIONS": 60,
    "^PLANTS_PLANTED": 80,
    "^PROC_PRODS": 100,
    "^WGUILD_STAND": 100,
    "^WGDONE_MISSIONS": 60,
    "^PIRATES_KILLED": 80,
    "^FIENDS_KILLED": 250,
    "^EGUILD_STAND": 100,
    "^EGDONE_MISSIONS": 60,
    "^RARE_SCANNED": 50,
    "^DISC_FLORA": 300,
    "^PIRATE_STAND": 150,
    "^PIRATE_MISSIONS": 60,
    "^BOUNTIES": 40,
    "^TRADERS_KILLED": 40,
    "^SMUGGLE_VALUE": 50_000_000,
  };
  for (const [id, target] of Object.entries(guildMaxima)) {
    assert.equal(
      master.naturalProgressionTargets.find((item) => item.id === id)?.target,
      target,
      id,
    );
  }
  const titleBackedMaxima = {
    "^ALIENS_MET": 150,
    "^ENEMIES_KILLED": 150,
    "^SENTINEL_KILLS": 150,
    "^HOME_REALITY": 9,
    "^DISC_SYSTEMS": 100,
    "^DISC_CREATURES": 100,
    "^DISC_MINERALS": 100,
    "^PARTS_PLACED": 200,
    "^FRIGATES": 30,
    "^TREASURE_FOUND": 30,
    "^ABAND_FREIGHTER": 25,
    "^FISH_CAUGHT": 250,
    "^BONES_FOUND": 200,
    "^FISH_CASH": 1_000_000,
    "^FISH_RELEASED": 60,
    "^EXO_SMASH": 500,
  };
  for (const [id, target] of Object.entries(titleBackedMaxima)) {
    assert.equal(
      master.naturalProgressionTargets.find((item) => item.id === id)?.target,
      target,
      id,
    );
  }
  assert(
    master.naturalProgressionTargets
      .filter((item) => item.target !== undefined)
      .every((item) => Math.abs(item.target) < 2_147_483_647),
  );
});

test("natural progression repairs every observed fantasy stat while preserving the legitimate CRUISE sentinel", () => {
  const { save, account } = fixture();
  const stats = save.BaseContext.PlayerStateData.Stats[0].Stats;
  stats.push(
    { Id: "^WALKERS_KILLED", Value: { IntValue: 2_147_483_647 } },
    { Id: "^NANITES_EVER", Value: { IntValue: -2_147_482_974 } },
    { Id: "^PB_BOSS_WINS", Value: { IntValue: 2_147_483_647 } },
    { Id: "^PB_WINS", Value: { IntValue: 2_147_483_647 } },
    { Id: "^PB_PETS_MAXED", Value: { IntValue: 2_147_483_647 } },
    { Id: "^PB_D_NEXUS", Value: { IntValue: 2_147_483_647 } },
    { Id: "^PB_CHALL_WINS", Value: { IntValue: 2_147_483_647 } },
    { Id: "^AMMO_FIRED", Value: { IntValue: 2_147_483_647 } },
    { Id: "^CRUISE", Value: { IntValue: -1 } },
  );

  const result = completeUnlocks(save, account, master, progressionOnly);
  const player = result.save.BaseContext.PlayerStateData;
  assert.equal(stat(player, "^WALKERS_KILLED").Value.IntValue, 40);
  assert.equal(stat(player, "^NANITES_EVER").Value.IntValue, 100_000);
  assert.equal(stat(player, "^PB_BOSS_WINS").Value.IntValue, 60);
  assert.equal(stat(player, "^PB_WINS").Value.IntValue, 220);
  assert.equal(stat(player, "^PB_PETS_MAXED").Value.IntValue, 20);
  assert.equal(stat(player, "^PB_D_NEXUS").Value.IntValue, 30);
  assert.equal(stat(player, "^PB_CHALL_WINS").Value.IntValue, 220);
  assert.equal(stat(player, "^AMMO_FIRED").Value.IntValue, 0);
  assert.deepEqual(stat(player, "^CRUISE").Value, { IntValue: -1 });
  assert.equal(result.report.after.progression.astronomical, 0);
  assert.equal(result.report.after.progression.pending, 0);
});

test("natural progression raises ranked stats, repairs editor sentinels, and syncs word counters", () => {
  const { save, account } = fixture();
  const before = analyzeCompletion(save, account, master);
  assert(before.progression.pending > 0);
  assert.equal(before.contextual.naturalProgression, before.progression.pending);
  assert.equal(before.progression.astronomical, 1);

  const result = completeUnlocks(save, account, master, progressionOnly);
  const player = result.save.BaseContext.PlayerStateData;

  assert.deepEqual(stat(player, "^DIST_WALKED").Value, {
    FloatValue: 100_000,
    IntValue: 100_000,
  });
  assert.deepEqual(stat(player, "^ALIENS_MET").Value, {
    IntValue: 150,
    FloatValue: 150,
  });
  assert.deepEqual(stat(player, "^MONEY").Value, {
    IntValue: 100_000_000,
    FloatValue: 100_000_000,
  });
  assert.deepEqual(stat(player, "^DISC_FLORA").Value, { IntValue: 356 });
  assert.equal(stat(player, "^WORDS_LEARNT").Value.IntValue, 2);
  assert.equal(stat(player, "^TWORDS_LEARNT").Value.IntValue, 2);
  assert.equal(stat(player, "^WWORDS_LEARNT").Value.IntValue, 1);
  assert.equal(stat(player, "^EWORDS_LEARNT").Value.IntValue, 1);
  assert.equal(result.report.after.progression.pending, 0);
  assert.equal(result.report.after.contextual.naturalProgression, 0);
  assert.equal(result.report.after.progression.astronomical, 0);
  assert.deepEqual(result.report.after.health, before.health);
  assert.deepEqual(
    verifyCompletion(result.save, result.account, master, progressionOnly),
    { ok: true, failures: [] },
  );
  assert.deepEqual(result.account, account);
});

test("natural progression refuses to invent a missing global stats group", () => {
  const { save, account } = fixture();
  delete save.BaseContext.PlayerStateData.Stats;
  assert.throws(
    () => completeUnlocks(save, account, master, progressionOnly),
    /GLOBAL_STATS/,
  );
});
