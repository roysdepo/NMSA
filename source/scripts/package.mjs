import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JSZip from "jszip";
import { addDependencyNoticesToZip } from "./dependency-notices.mjs";
import { normalizeZipEntryDates } from "./release-zip.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = path.resolve(project, "..");
const packageData = JSON.parse(
  await readFile(path.join(project, "package.json"), "utf8"),
);
const version = packageData.version;
const developerBuild = process.argv.includes("--developer");
const developerRevisionArgument = process.argv.find((argument) =>
  argument.startsWith("--developer-revision="),
);
const developerRevision = developerRevisionArgument
  ? Number(developerRevisionArgument.split("=")[1])
  : null;
if (developerRevision !== null && (!developerBuild || !Number.isInteger(developerRevision) || developerRevision < 1)) {
  throw new Error("Developer revision must be a positive integer used with --developer.");
}
const releaseName = developerBuild
  ? `NMSA-Developer-v${version}-safe-save-point-fix${developerRevision ? `-r${developerRevision}` : ""}`
  : `NMSA-Portable-v${version}`;
const releaseDir = path.join(project, "release");
const appBytes = await readFile(path.join(project, "dist", "NMSA.html"));
const dataPackPath = path.join(project, "dist", "NMSA-Data-6.45.1.atlaspack.json");
const dataPackBytes = await readFile(dataPackPath);
const appText = appBytes.toString("utf8");
const bridgeText = await readFile(
  path.join(distributionRoot, "Atlas-Complete.ps1"),
  "utf8",
);
const compatibility = JSON.parse(
  await readFile(path.join(project, "src", "data", "compatibility.json"), "utf8"),
);
const templateAudit = JSON.parse(
  await readFile(path.join(project, "src", "data", "save-template-audit.json"), "utf8"),
);
const desktopProjectText = await readFile(
  path.join(project, "desktop", "AtlasComplete.Desktop", "AtlasComplete.Desktop.csproj"),
  "utf8",
);

function requireReleaseMatch(condition, message) {
  if (!condition) throw new Error(`Release version check failed: ${message}`);
}

requireReleaseMatch(
  appText.includes(`<title>NMSA v${version} — No Man's Sky Atlas</title>`),
  `HTML title is not v${version}`,
);
requireReleaseMatch(
  appText.includes(`<span class="version">v${version}</span>`),
  `visible HTML badge is not v${version}`,
);
requireReleaseMatch(
  bridgeText.includes(`$script:Version = "${version}"`),
  `Windows bridge is not v${version}`,
);
requireReleaseMatch(
  desktopProjectText.includes(`<Version>${version}</Version>`) &&
    desktopProjectText.includes("<TargetFramework>net10.0-windows</TargetFramework>") &&
    desktopProjectText.includes("<UseWPF>true</UseWPF>"),
  `WPF host is not aligned to NMSA v${version} on .NET 10`,
);
requireReleaseMatch(
  compatibility.toolVersion === version,
  `data package is v${compatibility.toolVersion}, expected v${version}`,
);
requireReleaseMatch(
  appText.includes("schemaVersion:7"),
  "compiled app does not contain the schema 7 completion payload",
);
requireReleaseMatch(
  !appText.includes("__ATLAS_VERSION__"),
  "unresolved HTML version placeholder",
);
for (const entitlement of [
  "^TGA_SHIP1",
  "^SW_PREORDER",
  "^SW_PREORDER2",
  "^ENT_BOLTCASTER",
  "^ENT_PHOCORE",
  "^ENT_XO_HELMET",
]) {
  requireReleaseMatch(
    appText.includes(entitlement),
    `compiled app is missing ${entitlement}`,
  );
}
requireReleaseMatch(
  appText.includes("Licensed/platform entitlements") &&
    appText.includes("licensed/platform entitlements are preserved") &&
    appText.includes("explicit licensed-entitlement operation"),
  "compiled app does not contain the ownership-preserving entitlement boundary",
);
requireReleaseMatch(
  !appText.includes("storefront flags · not counted"),
  "compiled app still contains the removed storefront exclusion",
);
requireReleaseMatch(
  appText.includes('class="activity-popup hidden"') &&
    appText.includes("Verifying the edited save") &&
    appText.includes("reopened only the edited save and its required account companions"),
  "compiled app does not contain the nonblocking targeted-verification flow",
);
requireReleaseMatch(
  !appText.includes("busy-overlay") &&
    !appText.includes("Checking save ") &&
    !appText.includes("Rescanning installed files and verifying completion state"),
  "compiled app still contains the blocking or full-rescan loading flow",
);
for (const marker of [
  "Save State Templates",
  "Full Progression",
  "Explorer Progression",
  "Mission Progress",
  "511 unique completed Voyagers mission-progress records",
  "Overwrite selected save",
  "templateState",
  "template-installed",
]) {
  requireReleaseMatch(
    appText.includes(marker),
    `compiled app is missing save-template marker: ${marker}`,
  );
}
requireReleaseMatch(
  bridgeText.includes("$requested.Count -lt 2") &&
    bridgeText.includes('"save-template"') &&
    bridgeText.includes("templateState") &&
    bridgeText.includes("accountChanged") &&
    bridgeText.includes("platformSettingsChanged"),
  "Windows bridge does not contain the targeted save-template transaction contract",
);
requireReleaseMatch(
  compatibility.sourceCounts.fossilRecords === 165 &&
    compatibility.sourceCounts.shipComponentRecords === 309 &&
    compatibility.sourceCounts.fishingRecords === 226 &&
    compatibility.sourceCounts.seenBaseBuildingObjects === 1289 &&
    compatibility.sourceCounts.storyRecords === 40 &&
    compatibility.sourceCounts.anomalousBasePartRecords === 11 &&
    compatibility.sourceCounts.seenSubstances === 111 &&
    compatibility.sourceCounts.naturalProgressionTargets === 93 &&
    compatibility.sourceCounts.titleBackedStatFamilies === 78 &&
    compatibility.sourceCounts.disallowedKnownTechnologies === 129,
  "record-family manifest counts do not match the verified exhaustive baseline",
);
for (const marker of [
  "^FOS_BI_BODY_",
  "^SHIP_CORE_S",
  "SHUTT_",
  "2CYLIN2A",
  "^F_ALL_COM_S1",
  "^F_BOSS_JELLY",
  "^S15_BOT_4",
  "^TEAM_BLUE",
  "^BASE_FLAG",
  "^BASE_WEIRDCUBE",
  "UI_BASELOG_TITLE",
  "^HOME_REALITY",
  "MAINT_TECH",
]) {
  requireReleaseMatch(
    appText.includes(marker),
    `compiled app is missing generated record marker ${marker}`,
  );
}
for (const [id, filename] of [
  ["god", "arcane-god-save.json"],
  ["demigod", "arcane-demigod-save.json"],
  ["missions", "arcane-voyagers-missions.json"],
]) {
  const sourceText = await readFile(
    path.join(project, "src", "data", filename),
    "utf8",
  );
  const value = JSON.parse(sourceText);
  requireReleaseMatch(
    !/765611\d{8,}|C:\\Users\\/i.test(sourceText),
    `${filename} still contains a source Steam identity or local user path`,
  );
  requireReleaseMatch(
    hash(JSON.stringify(value)) === templateAudit.sourceHashes[id],
    `${filename} does not match the audited source hash`,
  );
}
requireReleaseMatch(
  templateAudit.summaries.god.playerStateFieldCount === 243 &&
    templateAudit.summaries.god.assets.frigates === 30 &&
    templateAudit.summaries.god.populatedAssets.ships === 9 &&
    templateAudit.summaries.god.populatedAssets.multitools === 4 &&
    templateAudit.summaries.god.populatedAssets.companions === 4 &&
    templateAudit.summaries.demigod.playerStateFieldCount === 243 &&
    templateAudit.summaries.demigod.assets.frigates === 1 &&
    templateAudit.summaries.demigod.populatedAssets.ships === 1 &&
    templateAudit.summaries.demigod.populatedAssets.multitools === 1 &&
    templateAudit.summaries.missions.recordCount === 511 &&
    templateAudit.summaries.missions.uniqueMissionCount === 511,
  "save-template audit counts do not match the verified tier contract",
);
requireReleaseMatch(
  templateAudit.privacy.godIdentityPlaceholders === 138 &&
    templateAudit.privacy.demigodIdentityPlaceholders === 137,
  "save-template source identity sanitization counts changed without review",
);
requireReleaseMatch(
  templateAudit.completionComparison.sourceOnlyCandidates.knownTechnologies
    .sort().join("|") === "^DUMMY_SCAN|^OBSOLETE" &&
    templateAudit.completionComparison.sourceOnlyCandidates.wordGroups.length === 0,
  "save-template completion-candidate classification changed without review",
);

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

await mkdir(releaseDir, { recursive: true });
const standalonePath = path.join(releaseDir, "NMSA.html");
await writeFile(standalonePath, appBytes);
await copyFile(standalonePath, path.join(distributionRoot, "NMSA.html"));

const zip = new JSZip();
const root = zip.folder(releaseName);
const portableLauncher = [
  "@echo off",
  "start \"NMSA - No Man's Sky Atlas\" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0app\\NMSA-Host.ps1\"",
  "",
].join("\r\n");
root.file("NMSA - No Man's Sky Atlas.cmd", portableLauncher);
root.file("app/NMSA.html", appBytes);
root.file("app/NMSA-Host.ps1", bridgeText);
if (developerBuild) {
  root.file(
    "DEVELOPER-BUILD.txt",
    [
      `NMSA developer build based on v${version}`,
      "",
      "Purpose: verify the physical save-point and completion-baseline corrections.",
      "This build updates one selected saveNN.hg file and only its matching mf_saveNN.hg metadata file.",
      "Autosave and Restore Point are separate and are never synchronized automatically.",
      "It is for local testing only. Do not publish or distribute it.",
      "",
      "Before testing: fully close No Man's Sky and make a separate copy of your save folder.",
    ].join("\r\n"),
  );
}
root.file("Legal/LICENSE", await readFile(path.join(distributionRoot, "LICENSE")));
root.file(
  "Legal/THIRD_PARTY_NOTICES.md",
  await readFile(path.join(distributionRoot, "THIRD_PARTY_NOTICES.md")),
);
await addDependencyNoticesToZip(root, distributionRoot, "portable");

normalizeZipEntryDates(zip);
const zipBytes = await zip.generateAsync({
  type: "uint8array",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
const zipPath = path.join(releaseDir, `${releaseName}.zip`);
await writeFile(zipPath, zipBytes);
const checksums = [
  `${hash(appBytes)}  NMSA.html`,
  `${hash(zipBytes)}  ${releaseName}.zip`,
  "",
].join("\n");
await writeFile(
  path.join(releaseDir, `${releaseName}-SHA256.txt`),
  checksums,
  "utf8",
);
console.log(`wrote ${zipPath} (${zipBytes.length.toLocaleString()} bytes)`);
