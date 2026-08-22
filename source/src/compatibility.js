import { adapterWriteCapability } from "./platform-adapters.js";

const PLATFORM_LABELS = Object.freeze({
  steam: "Steam",
  gog: "GOG",
  "xbox-game-pass": "Xbox Game Pass",
  "playstation-extracted": "Extracted PlayStation",
  "switch-extracted": "Extracted Nintendo Switch",
  portable: "Portable files",
});

export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] ?? "Unknown platform";
}

export function inferSaveFormat(save, manifestFormat, master) {
  if (Number.isInteger(manifestFormat) && manifestFormat > 0) return manifestFormat;
  const gameVersion = Number(save?.Version ?? 0);
  if (gameVersion >= master.minimumGameVersion) return 2004;
  if (gameVersion >= 4135) return 2003;
  if (gameVersion >= 4115) return 2002;
  return gameVersion > 0 ? 2001 : null;
}

export function inspectCompatibility({
  save,
  account,
  manifestFormat = null,
  accountManifestFormat = null,
  platform = "portable",
  manifestValid = true,
  accountManifestValid = true,
  master,
}) {
  const gameVersion = Number(save?.Version ?? 0);
  const accountVersion = Number(account?.Version ?? 0);
  const saveFormat = inferSaveFormat(save, manifestFormat, master);
  const resolvedAccountFormat = accountManifestFormat ?? saveFormat;
  const knownFormat = master.knownSaveFormats.includes(saveFormat);
  const writableFormat = master.writableSaveFormats.includes(saveFormat);
  const formatPairMatches =
    resolvedAccountFormat === null ||
    saveFormat === null ||
    resolvedAccountFormat === saveFormat;
  const newerThanData = gameVersion > Number(master.testedGameVersion || 0);
  const olderThanWritableBaseline =
    gameVersion < Number(master.minimumWritableGameVersion || master.minimumGameVersion || 0);
  const platformKnown = master.platformAdapters.includes(platform);
  const writeCapability = adapterWriteCapability(platform);
  const platformWritable = platformKnown && writeCapability.writeAllowed;
  const reasons = [];

  if (!knownFormat) reasons.push(`Save format ${saveFormat ?? "unknown"} is not recognized.`);
  else if (!writableFormat) reasons.push(`Save format ${saveFormat} is analysis-only in this build.`);
  if (!formatPairMatches) reasons.push("Save and account formats do not match.");
  if (!manifestValid) reasons.push("Save metadata does not match its data file.");
  if (!accountManifestValid) reasons.push("Account metadata does not match its data file.");
  if (newerThanData) {
    reasons.push(
      `Save version ${gameVersion} is newer than the tested data baseline ${master.testedGameVersion}.`,
    );
  }
  if (olderThanWritableBaseline) {
    reasons.push(
      `Save version ${gameVersion || "unknown"} predates the verified write baseline ${master.minimumWritableGameVersion}.`,
    );
  }
  if (!platformKnown) reasons.push("No verified platform writer is available.");
  else if (!platformWritable) reasons.push(writeCapability.reason);

  const writeAllowed =
    knownFormat &&
    writableFormat &&
    formatPairMatches &&
    manifestValid &&
    accountManifestValid &&
    !newerThanData &&
    !olderThanWritableBaseline &&
    platformWritable;

  return {
    platform,
    platformLabel: platformLabel(platform),
    saveFormat,
    accountFormat: resolvedAccountFormat,
    gameVersion,
    accountVersion,
    knownFormat,
    writableFormat,
    formatPairMatches,
    newerThanData,
    olderThanWritableBaseline,
    platformKnown,
    platformWritable,
    analysisAllowed: true,
    writeAllowed,
    status: writeAllowed ? "verified" : "analysis-only",
    reasons,
    codec:
      platform === "xbox-game-pass"
        ? "Xbox container / NMS LZ4"
        : platform === "playstation-extracted"
          ? "NOMANSKY streaming / JSON"
          : "NMS LZ4 streaming",
    mappingVersion: master.mappingVersion,
    dataPackage: master.activePackage,
  };
}

export function assertWritableCompatibility(compatibility) {
  if (!compatibility?.writeAllowed) {
    throw new Error(
      `Atlas opened this save in analysis-only mode. ${compatibility?.reasons?.join(" ") || "Writing is not verified."}`,
    );
  }
}
