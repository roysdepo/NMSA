function prefixed(prefix, values) {
  return values.map((value) => `^${prefix}${value}`);
}

// These finite families are generated from their NMS identifier grammar rather
// than copied from another completion tool or extracted from a previously
// edited save. Tests verify the generated counts and cross-family relationships.
function numbered(prefix, first, last) {
  return Array.from(
    { length: last - first + 1 },
    (_, index) => `^${prefix}${first + index}`,
  );
}

function unique(values) {
  return [...new Set(values)];
}

const fossilBlueprintRecords = Object.freeze([
  "^FOS_WORM_DIS",
  "^FOS_WORM",
  "^FOS_QUAD_DIS",
  "^FOS_QUAD",
  "^FOS_GRUN_DIS",
  "^FOS_GRUN",
  "^FOS_BODY",
  "^FOS_TAIL",
  "^FOS_LIMBS",
  "^FOS_SKULL",
  "^FOS_BODY_DISP",
  "^FOS_BODY_MNT",
  "^FOS_TAIL_DISP",
  "^FOS_TAIL_MNT",
  "^FOS_LIMBS_DISP",
  "^FOS_LIMBS_MNT",
  "^FOS_SKULL_DISP",
  "^FOS_SKULL_MNT",
  "^FOS_BI_DIS",
  "^FOS_BI",
  "^FOS_BIRD_DIS",
  "^FOS_BIRD",
]);

const fossilBodies = ["A", "B"].flatMap((body) =>
  ["A", "B", "C", "D", "E", "N"].map(
    (variant) => `^FOS_BI_BODY_${body}${variant}`,
  ),
);
const fossilTails = [
  ...["A", "B", "C", "D"].flatMap((tail) =>
    ["A", "N"].map((variant) => `^FOS_BI_TAIL_${tail}${variant}`),
  ),
  ...["E", "F", "G"].map((tail) => `^FOS_BI_TAIL_${tail}`),
];
const fossilHeadVariants = Object.freeze({
  A: "ABCDN",
  B: "ABCDEFGHIJN",
  C: "ABCDEFGHIJN",
  D: "ABCDEFGHIJN",
  E: "ABCDEFGHIJN",
  F: "ABCDEFGHIJKLMN",
  G: "ABCDEFN",
  H: "ABCDEFGN",
  I: "ABCDEFGN",
  J: "ABCDEFGHIJN",
  K: "ABCDEFGHIJKLN",
});
const fossilHeads = Object.entries(fossilHeadVariants).flatMap(
  ([head, variants]) =>
    [...variants].map((variant) => `^FOS_HEAD_${head}${variant}`),
);
const fossilLimbs = [..."ABCDEFGHIJ"].map((limb) => `^FOS_LIMBS_${limb}`);

const fossilComponentRecords = Object.freeze([
  ...fossilBodies,
  ...fossilTails,
  ...fossilHeads,
  ...fossilLimbs,
]);
const fossilRecords = Object.freeze([
  ...fossilBlueprintRecords,
  ...fossilComponentRecords,
]);

const fighterParts = Object.freeze([
  "COCKAA", "COCKAB", "COCKAC", "COCKAD", "COCKAE", "COCKB", "COCKD",
  "COCKE", "COCKF", "WINGA", "WINGA_FI", "WINGB", "WINGB_FI", "WINGBA",
  "WINGBA_FI", "WINGBB", "WINGBB_FI", "WINGBC", "WINGBC_FI", "WINGBD",
  "WINGBD_FI", "WINGD", "WINGEA", "WINGEA_FI", "WINGEB", "WINGEB_FI",
  "WINGEC", "WINGEC_FI", "WINGED", "WINGED_FI", "WINGEE", "WINGEE_FI",
  "WINGEF", "WINGEF_FI", "WINGFC", "WINGFC_FI", "WINGFD", "WINGFD_FI",
  "WINGFE", "WINGFE_FI", "WINGG", "WINGG_FI", "WINGH", "WINGH_FI",
  "WINGHA", "WINGHA_FI", "WINGHB", "WINGHB_FI", "WINGHC", "WINGHC_FI",
  "WINGHD", "WINGHD_FI", "WINGI", "WINGI_FI", "WINGJLOW", "WINGJMID",
  "WINGJFULL", "WINGKA", "WINGKAA", "WINGKBA", "WINGKBB", "WINGKBC",
  "ENGIB", "ENGIC", "ENGID",
]);

const haulerParts = Object.freeze([
  "COCKA", "COCKB", "COCKC", "COCKD", "COCKE", "COCKF", "COCKG", "COCKH",
  "COCKS13", "ENGIA", "ENGIAA", "ENGIAB", "ENGIB", "ENGIBA", "ENGIBB",
  "ENGIC", "ENGIS13", "WINGEMP", "WINGAA", "WINGAAA", "WINGAAB", "WINGAAC",
  "WINGAAD", "WINGAAE", "WINGAAF", "WINGAAG", "WINGAAH", "WINGAAI",
  "WINGAB", "WINGABA", "WINGABB", "WINGABC", "WINGABD", "WINGABE",
  "WINGABF", "WINGABG", "WINGABH", "WINGABI", "WINGAC", "WINGACA",
  "WINGACB", "WINGACC", "WINGACD", "WINGACE", "WINGACF", "WINGACG",
  "WINGACH", "WINGACI", "WINGBA", "WINGBAA", "WINGBAB", "WINGBAC",
  "WINGBAD", "WINGBAE", "WINGBAF", "WINGBAG", "WINGBAH", "WINGBAI",
  "WINGBB", "WINGBBA", "WINGBBB", "WINGBBC", "WINGBBD", "WINGBBE",
  "WINGBBF", "WINGBBG", "WINGBBH", "WINGBBI", "WINGBC", "WINGBCA",
  "WINGBCB", "WINGBCC", "WINGBCD", "WINGBCE", "WINGBCF", "WINGBCG",
  "WINGBCH", "WINGBCI", "WINGCA", "WINGCAA", "WINGCAB", "WINGCAC",
  "WINGCAD", "WINGCAE", "WINGCAF", "WINGCAG", "WINGCAH", "WINGCAI",
  "WINGCB", "WINGCBA", "WINGCBB", "WINGCBC", "WINGCBD", "WINGCBE",
  "WINGCBF", "WINGCBG", "WINGCBH", "WINGCBI", "WINGCC", "WINGCCA",
  "WINGCCB", "WINGCCC", "WINGCCD", "WINGCCE", "WINGCCF", "WINGCCG",
  "WINGCCH", "WINGCCI", "WINGCD", "WINGCDA", "WINGCDB", "WINGCDD", "WINGCDE",
  "WINGCDF", "WINGCDG", "WINGCDH", "WINGCDI", "WINGDA", "WINGDAX",
  "WINGDAA", "WINGDAB", "WINGDAH", "WINGDAI", "WINGDB", "WINGDBA",
  "WINGDBB", "WINGDBH", "WINGDBI", "WINGDBX", "WINGDBAX", "WINGDBBX",
  "WINGDBHX", "WINGDBIX", "WINGS13", "WING1", "WING2",
]);

const explorerParts = Object.freeze([
  "COCKAA", "COCKAAA", "COCKABA", "COCKACA", "COCKAB", "COCKAAB",
  "COCKABB", "COCKACB", "COCKDA", "COCKDB", "WINGEMP", "WINGA", "WINGBA",
  "WINGBB", "WINGBC", "WINGBD", "WINGC", "WINGDA", "WINGDB", "WINGDC",
  "WINGDD", "WINGE", "WINGF", "WINGFA", "WINGG", "WINGGA", "WINGHA",
  "WINGHB", "WINGHC", "WINGHD", "WINGI", "WINGKA", "WINGKB", "WINGKC",
  "WINGKD", "WINGL", "WINGT_A", "WINGT_C", "WINGT_F", "WINGT_G", "WINGT_I",
]);

const shuttleParts = Object.freeze([
  "COCKA", "COCKB",
  "CYLIN0A", "CYLIN0B", "CYLIN1A", "CYLIN1B", "CYLIN2A",
  "2CYLIN1A", "2CYLIN1B", "2CYLIN2A",
  "BOX0A", "BOX1A", "BOX2A", "BOX3A", "2BOX0A", "2BOX1A",
  "WINGA", "WINGD", "WINGG", "WINGH", "WINGI", "WINGJ", "WINGK", "WINGL",
]);

const solarParts = Object.freeze([
  "BODYA", "BODYB", "BODYC", "BODYD", "BODYE", "BODYF", "WINGAA", "WINGAB",
  "WINGAC", "WINGAD", "WINGAE", "WINGBA", "WINGBB", "WINGBC", "WINGBD",
  "WINGBE", "WINGCA", "WINGCB", "WINGCC", "WINGCD", "WINGCE", "WINGDA",
  "WINGDB", "WINGDC", "WINGDD", "WINGDE", "WINGEA", "WINGEB", "WINGEC",
  "WINGED", "WINGEE", "WINGFA", "WINGFB", "WINGFC", "WINGFD", "WINGFE",
  "SAILA", "SAILB", "SAILC",
]);

const speculativeShipComponentRecords = Object.freeze([
  ...prefixed("FIGHT_", fighterParts),
  ...prefixed("DROPS_", haulerParts),
  ...prefixed("SCIEN_", explorerParts),
  ...prefixed("SHUTT_", shuttleParts),
  ...prefixed("SAIL_", solarParts),
  "^SHIP_CORE_C",
  "^SHIP_CORE_B",
  "^SHIP_CORE_A",
  "^SHIP_CORE_S",
]);

const fishBiomes = Object.freeze([
  "ALL", "TOX", "RAD", "HOT", "COLD", "LUSH", "DUST", "ODD", "DEEP", "GAS",
]);
const fishVariants = Object.freeze([
  ["COM_S1", "Small"],
  ["COM_S2", "Small"],
  ["COM_S3", "Small"],
  ["COM_M1", "Medium"],
  ["COM_M2", "Medium"],
  ["COM_L1", "Large"],
  ["COM_XL", "ExtraLarge"],
  ["RARE_S1", "Small"],
  ["RARE_S2", "Small"],
  ["RARE_M1", "Medium"],
  ["RARE_M2", "Medium"],
  ["RARE_L1", "Large"],
  ["RARE_XL", "ExtraLarge"],
  ["EPIC_S1", "Small"],
  ["EPIC_M1", "Medium"],
  ["EPIC_L1", "Large"],
  ["EPIC_XL", "ExtraLarge"],
  ["LEG_S1", "Small"],
  ["LEG_M1", "Medium"],
  ["LEG_L1", "Large"],
  ["LEG_XL", "ExtraLarge"],
]);
const fishMassBySize = Object.freeze({
  // Current GCFISHINGGLOBALS Gaussian mean and standard deviation by size.
  // Ten standard deviations is intentionally conservative: it preserves real
  // personal records while rejecting obvious editor-style fantasy weights.
  Small: Object.freeze({ mean: 2, standardDeviation: 0.4 }),
  Medium: Object.freeze({ mean: 6, standardDeviation: 0.8 }),
  Large: Object.freeze({ mean: 12, standardDeviation: 2.2 }),
  ExtraLarge: Object.freeze({ mean: 20, standardDeviation: 3.7 }),
});
const specialFish = Object.freeze([
  ["F_TRASH_1", "ExtraLarge"],
  ["F_TRASH_2", "Small"],
  ["F_TRASH_3", "Large"],
  ["F_TRASH_4", "Large"],
  ["F_TRASH_5", "Large"],
  ["F_TRASH_6", "Large"],
  ["F_TRASH_7", "Small"],
  ["F_TRASH_8", "Small"],
  ["F_BOTTLE", "Small"],
  ["F_JELLYCHILD", "Small"],
  ["F_BOSS_JELLY", "Small"],
  ["S15_FISH", "Large"],
  ["S15_BOT_1", "Small"],
  ["S15_BOT_2", "Small"],
  ["S15_BOT_3", "Small"],
  ["S15_BOT_4", "Small"],
]);
const fishingRecords = Object.freeze([
  ...fishBiomes.flatMap((biome) =>
    fishVariants.map(([variant, size]) => {
      const mass = fishMassBySize[size];
      return {
        productId: `^F_${biome}_${variant}`,
        size,
        largestCatch: mass.mean,
        standardDeviation: mass.standardDeviation,
        maximumPlausibleCatch: mass.mean + mass.standardDeviation * 10,
        count: 1,
      };
    }),
  ),
  ...specialFish.map(([product, size]) => {
    const mass = fishMassBySize[size];
    return {
      productId: `^${product}`,
      size,
      largestCatch: mass.mean,
      standardDeviation: mass.standardDeviation,
      maximumPlausibleCatch: mass.mean + mass.standardDeviation * 10,
      count: 1,
    };
  }),
]);

const disallowedTechnologies = Object.freeze(unique([
  "^OBSOLETE",
  ...numbered("SHIPSLOT_DMG", 1, 12),
  ...numbered("SHIPEASY_DMG", 1, 4),
  "^DUMMY_SCAN",
  ...numbered("WEAPSLOT_DMG", 1, 12),
  ...numbered("WEAPSENT_DMG", 1, 4),
  ...numbered("WEAPEASY_DMG", 1, 4),
  ...numbered("MAINT_FARM", 1, 5),
  ...numbered("MAINT_FUEL", 1, 5),
  ...numbered("MAINT_TECH", 1, 25),
  ...numbered("MAINT_PORTAL", 1, 16),
  "^MAINT_S13",
  "^MAINT_HOOVER",
  "^MAINT_BAIT",
  "^MAINT_FISHTRAP",
  "^MAINT_FOOD",
  "^MAINT_REFINER",
  "^MAINT_COOKER",
  "^MAINT_BURNER",
  "^MAINT_ARTIFACT",
  ...numbered("MAINT_SEALOCK", 1, 2),
  ...numbered("MAINT_FRIG", 1, 10),
  ...numbered("EXOPOD_TECH", 1, 3),
  ...numbered("MAINT_MONONUB", 1, 3),
  ...numbered("MAINT_ROBO", 1, 10),
  ...numbered("MAINT_S22_PART", 1, 3),
]));

const supplementalWordGroups = Object.freeze([
  {
    Group: "^TRA_COLLECTION",
    Races: [true, false, false, false, false, false, false, false, false],
  },
]);

// Unlike procedural planet, creature, flora, mineral, treasure, and custom
// wonders, these eleven stabilised reality glitches are a closed game-defined
// family. Their save records encode the product identifier in GenerationID.
const anomalousBasePartRecords = Object.freeze([
  "^BASE_ENGINEORB",
  "^BASE_BEAMSTONE",
  "^BASE_BUBBLECLUS",
  "^BASE_MEDGEOMETR",
  "^BASE_SHARD",
  "^BASE_STARJOINT",
  "^BASE_BONEGARDEN",
  "^BASE_CONTOURPOD",
  "^BASE_HYDROPOD",
  "^BASE_SHELLWHITE",
  "^BASE_WEIRDCUBE",
]);

const catalogueRecordProducts = Object.freeze([
  ...fossilRecords,
  ...speculativeShipComponentRecords,
]);
const catalogueOnlyProductRecords = Object.freeze([
  ...fossilComponentRecords,
  ...speculativeShipComponentRecords,
]);
const authoritativeCatalogueRecordProducts = Object.freeze([...fossilRecords]);
const authoritativeCatalogueOnlyProductRecords = Object.freeze([
  ...fossilComponentRecords,
]);

const recordFamilies = Object.freeze([
  {
    key: "fossilBlueprintRecords",
    label: "Fossil blueprint records",
    storage: "UserSettingsData.SeenProducts",
    count: fossilBlueprintRecords.length,
  },
  {
    key: "fossilComponentRecords",
    label: "Fossil component records",
    storage: "UserSettingsData.SeenProducts",
    count: fossilComponentRecords.length,
  },
  {
    key: "fishingRecords",
    label: "Fishing species records",
    storage: "PlayerStateData.FishingRecord",
    count: fishingRecords.length,
  },
  {
    key: "anomalousBasePartRecords",
    label: "Stabilised reality-glitch wonder records",
    storage: "PlayerStateData.WonderWeirdBasePartRecords",
    count: anomalousBasePartRecords.length,
  },
]);

export {
  anomalousBasePartRecords,
  authoritativeCatalogueOnlyProductRecords,
  authoritativeCatalogueRecordProducts,
  catalogueOnlyProductRecords,
  catalogueRecordProducts,
  disallowedTechnologies,
  fishingRecords,
  fossilBlueprintRecords,
  fossilComponentRecords,
  fossilRecords,
  recordFamilies,
  speculativeShipComponentRecords,
  supplementalWordGroups,
};
