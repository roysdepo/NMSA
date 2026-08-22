import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChangePreview,
  completionOptionsChangeAccount,
  completionOptionsRequirePlatformSettings,
} from "../src/change-preview.js";
import { getSaveTemplateDefinition } from "../src/save-templates.js";

test("template companion eligibility separates rewards from licensed entitlements", () => {
  const safeRewards = getSaveTemplateDefinition("god").completionOptions;
  assert.equal(safeRewards.rewards, true);
  assert.equal(safeRewards.licensedEntitlements, undefined);
  assert.equal(completionOptionsChangeAccount(safeRewards), true);
  assert.equal(
    completionOptionsRequirePlatformSettings(safeRewards, "steam"),
    false,
  );
  assert.equal(
    completionOptionsRequirePlatformSettings(safeRewards, "gog"),
    false,
  );

  const licensed = { rewards: false, licensedEntitlements: true };
  assert.equal(completionOptionsChangeAccount(licensed), true);
  assert.equal(completionOptionsRequirePlatformSettings(licensed, "steam"), true);
  assert.equal(completionOptionsRequirePlatformSettings(licensed, "gog"), true);
  assert.equal(
    completionOptionsRequirePlatformSettings(licensed, "xbox-game-pass"),
    false,
  );
});

test("change previews never count preserved internal SeenTechnologies", () => {
  const zeroProjection = {
    seenKnownProducts: 0,
    seenKnownTechnologies: 0,
    productRecords: 0,
  };
  const preview = buildChangePreview(
    {
      missing: { disallowedSeenTechnologies: 73 },
      projections: { catalogue: { base: zeroProjection } },
      progression: { pending: 0 },
      conveniencesMissing: 0,
      integrity: {
        structuralIssues: 0,
        disallowedKnownTechnologies: 0,
        disallowedSeenTechnologies: 73,
      },
    },
    {
      rewards: false,
      licensedEntitlements: false,
      blueprints: false,
      languageAndSlots: false,
      catalogue: true,
      naturalProgression: false,
      progressionConveniences: false,
      repairIntegrity: true,
    },
  );

  assert.equal(
    preview.categories.find((item) => item.option === "catalogue").additions,
    0,
  );
  assert.equal(
    preview.categories.find((item) => item.option === "repairIntegrity").additions,
    0,
  );
  assert.equal(preview.total, 0);
});
