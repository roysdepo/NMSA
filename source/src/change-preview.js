function sum(missing, fields) {
  return fields.reduce((total, field) => total + Number(missing[field] || 0), 0);
}

export function completionOptionsChangeAccount(options = {}) {
  return Boolean(options.rewards || options.licensedEntitlements);
}

export function completionOptionsRequirePlatformSettings(options = {}, adapter = "") {
  return ["steam", "gog"].includes(adapter) && Boolean(options.licensedEntitlements);
}

function completeIdentity(value) {
  if (!value) return null;
  const identity = Object.fromEntries(
    ["PTK", "UID", "LID", "USN"].map((field) => [field, String(value[field] || "").trim()]),
  );
  return Object.values(identity).every(Boolean) ? identity : null;
}

function sameIdentity(current, expected) {
  return ["PTK", "UID", "LID", "USN"].every(
    (field) => String(current?.[field] || "") === String(expected?.[field] || ""),
  );
}

function projectedOwnershipChanges(audit, ownership) {
  if (!ownership?.enabled) return 0;
  const primary = completeIdentity(ownership.primary);
  if (!primary) return 0;
  const identities = [primary, ...(ownership.aliases || []).map(completeIdentity).filter(Boolean)];
  const byUid = new Map(identities.map((identity) => [identity.UID, identity]));
  let changes = 0;

  for (const identity of byUid.values()) {
    const registered = audit.registeredOwners.filter((owner) => owner.UID === identity.UID);
    if (!registered.length) changes += 1;
    else {
      changes += registered.reduce(
        (total, owner) => total + (sameIdentity(owner, identity) ? 0 : owner.count),
        0,
      );
    }
  }

  if (ownership.normalizeBases) {
    const representedBases = audit.baseOwners.reduce((total, owner) => total + owner.count, 0);
    changes += Math.max(0, audit.persistentBases - representedBases);
    changes += audit.baseOwners.reduce(
      (total, owner) => total + (sameIdentity(owner, primary) ? 0 : owner.count),
      0,
    );
    if (ownership.clearBaseEditorLabels) changes += audit.basesWithEditorLabels || 0;
  }

  if (ownership.normalizeMatchingDiscoveries) {
    changes += audit.discoveryOwners.reduce((total, owner) => {
      const expected = byUid.get(owner.UID);
      return total + (expected && !sameIdentity(owner, expected) ? owner.count : 0);
    }, 0);
  }
  return changes;
}

export function buildChangePreview(analysis, options, ownership = { enabled: false }) {
  const missing = analysis.missing;
  const catalogueProjection = analysis.projections.catalogue[
    options.blueprints && options.rewards
      ? "both"
      : options.blueprints
        ? "blueprints"
        : options.rewards
          ? "rewards"
          : "base"
  ];
  const categories = [
    {
      label: "Rewards & cosmetics",
      option: "rewards",
      enabled: Boolean(options.rewards),
      additions: options.rewards
        ? sum(missing, [
            "knownSpecials", "accountSpecials", "seasonRewards", "twitchRewards",
            "platformRewards", "contentEntitlements",
            "redeemedSeasonRewards", "redeemedTwitchRewards",
            "redeemedPlatformRewards", "titles",
          ])
        : 0,
    },
    {
      label: "Blueprints & recipes",
      option: "blueprints",
      enabled: Boolean(options.blueprints),
      additions: options.blueprints
        ? sum(missing, [
            "knownProducts",
            "knownTechnologies",
            "disallowedKnownTechnologies",
            "refinerRecipes",
          ])
        : 0,
    },
    {
      label: "Language, runes & slots",
      option: "languageAndSlots",
      enabled: Boolean(options.languageAndSlots),
      additions: options.languageAndSlots
        ? sum(missing, [
            "wordGroups", "wordGroupsExpanded", "portalRunes", "petSlots", "squadronSlots",
          ])
        : 0,
    },
    {
      label: "Catalogue & records",
      option: "catalogue",
      enabled: Boolean(options.catalogue),
      additions: options.catalogue
        ? sum(missing, ["wikiTopics", "seenWikiTopics", "seenSubstances"]) +
          catalogueProjection.seenKnownProducts +
          catalogueProjection.seenKnownTechnologies +
          catalogueProjection.productRecords +
          Number(missing.fishingRecords || 0) +
          Number(missing.baseBuildingRecords || 0) +
          Number(missing.storyRecords || 0) +
          Number(missing.anomalousBasePartRecords || 0)
        : 0,
    },
    {
      label: "Natural milestones & standing",
      option: "naturalProgression",
      enabled: Boolean(options.naturalProgression),
      additions: options.naturalProgression
        ? Number(analysis.progression?.pending || 0)
        : 0,
    },
  ];
  if (options.progressionConveniences) {
    categories.push({
      label: "Progression conveniences",
      option: "progressionConveniences",
      enabled: true,
      additions: analysis.conveniencesMissing ?? 0,
    });
  }
  if (options.repairIntegrity) {
    categories.push({
      label: "Integrity repair",
      option: "repairIntegrity",
      enabled: true,
      additions:
        Number(analysis.integrity?.structuralIssues || 0) +
        (options.blueprints
          ? 0
          : Number(analysis.integrity?.disallowedKnownTechnologies || 0)),
    });
  }
  if (ownership.enabled) {
    categories.push({
      label: "Scoped ownership repair",
      option: "ownership",
      enabled: true,
      additions: projectedOwnershipChanges(analysis.ownership, ownership),
    });
  }
  return {
    categories,
    total: categories.reduce((total, item) => total + item.additions, 0),
  };
}
