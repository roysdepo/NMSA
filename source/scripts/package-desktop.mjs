import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import JSZip from "jszip";
import { addDependencyNoticesToZip } from "./dependency-notices.mjs";
import { normalizeZipEntryDates } from "./release-zip.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = path.resolve(project, "..");
const packageData = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
const version = packageData.version;
const runtime = "win-x64";
const publishDirectory = path.join(project, "desktop", "publish", runtime);
const releaseDirectory = path.join(project, "release");
const allowUnsigned = process.argv.includes("--allow-unsigned");
const revisionArgument = process.argv.find((argument) => argument.startsWith("--developer-revision="));
const developerRevision = revisionArgument?.split("=", 2)[1];
if (developerRevision && !/^[1-9]\d*$/.test(developerRevision)) {
  throw new Error("Developer revision must be a positive integer.");
}
if (developerRevision && !allowUnsigned) {
  throw new Error("Developer revision labels are only valid for unsigned development builds.");
}
const developerSuffix = allowUnsigned
  ? `${developerRevision ? `-safe-save-point-fix-r${developerRevision}` : ""}-${runtime}-UNSIGNED-DEV`
  : `-${runtime}`;
const releaseName = `NMSA-Desktop-v${version}${developerSuffix}`;

async function filesBelow(directory, relative = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesBelow(childAbsolute, childRelative)));
    else if (entry.isFile() && ![".pdb", ".xml"].includes(path.extname(entry.name).toLowerCase())) {
      output.push(childRelative);
    }
  }
  return output;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const executablePath = path.join(publishDirectory, "NMSA.exe");
const htmlPath = path.join(publishDirectory, "Web", "NMSA.html");
await readFile(executablePath);
const packagedHtml = await readFile(htmlPath);
const canonicalHtml = await readFile(path.join(project, "dist", "desktop", "NMSA.html"));
if (sha256(packagedHtml) !== sha256(canonicalHtml)) {
  throw new Error("Published NMSA workspace does not match the canonical verified build.");
}

const publishFiles = (await filesBelow(publishDirectory)).sort();
const forbiddenWorker = publishFiles.find((filename) => path.extname(filename).toLowerCase() === ".ps1");
if (forbiddenWorker) {
  throw new Error(`Desktop package still contains a PowerShell worker: ${forbiddenWorker}`);
}
const webAssets = publishFiles
  .filter((filename) => filename.startsWith(`Web${path.sep}`))
  .map((filename) => filename.split(path.sep).join("/"));
assertExactWebAssets(webAssets);

function assertExactWebAssets(files) {
  const expected = ["Web/NMSA.html", "Web/nmsa.css", "Web/nmsa.js"];
  if (files.length !== expected.length || expected.some((item) => !files.includes(item))) {
    throw new Error(`Published web asset boundary is invalid: ${files.join(", ")}`);
  }
}

if (!allowUnsigned) {
  const verification = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(project, "scripts", "sign-windows.ps1"),
      "-Path", executablePath,
      "-VerifyOnly",
    ],
    { stdio: "inherit" },
  );
  if (verification.status !== 0) {
    throw new Error("Production packaging requires a valid, trusted, timestamped NMSA.exe signature.");
  }
}

const signatureLabel = allowUnsigned
  ? "UNSIGNED DEVELOPMENT BUILD — DO NOT DISTRIBUTE"
  : "SIGNED PRODUCTION BUILD";
const correctionLabel = developerRevision
  ? `Physical save-point correction build r${developerRevision}`
  : null;
const zip = new JSZip();
const root = zip.folder(releaseName);
for (const relativePath of publishFiles) {
  root.file(
    relativePath.split(path.sep).join(path.posix.sep),
    await readFile(path.join(publishDirectory, relativePath)),
  );
}
root.file("Legal/LICENSE", await readFile(path.join(distributionRoot, "LICENSE")));
root.file(
  "Legal/THIRD_PARTY_NOTICES.md",
  await readFile(path.join(distributionRoot, "THIRD_PARTY_NOTICES.md")),
);
await addDependencyNoticesToZip(root, distributionRoot, "desktop");
if (!allowUnsigned) {
  for (const filename of ["README.md", "ARCHITECTURE.md"]) {
    root.file(filename, await readFile(path.join(distributionRoot, filename)));
  }
}
root.file(
  allowUnsigned ? "DEVELOPER-BUILD.txt" : "DESKTOP-README.txt",
  [
    `NMSA — No Man's Sky Atlas v${version}`,
    signatureLabel,
    ...(correctionLabel ? [correctionLabel] : []),
    "",
    "Run NMSA.exe. The .NET runtime is included.",
    "Microsoft Edge WebView2 Evergreen Runtime is required and ships with current Windows installations.",
    "NMSA processes save content locally and does not upload it.",
    "Back up irreplaceable saves and fully close No Man's Sky before install or rollback.",
    ...(developerRevision
      ? [
          "Each physical save point is one saveNN.hg file plus its exact mf_saveNN.hg metadata file.",
          "NMSA edits only the selected physical save point and never synchronizes Autosave and Restore Point.",
        ]
      : []),
    "The desktop host is implemented in-process in C#; no PowerShell worker or loopback listener is included.",
    "",
  ].join("\r\n"),
);
if (!allowUnsigned) root.file("SIGNING-STATUS.txt", `${signatureLabel}\r\n`);

normalizeZipEntryDates(zip);
const zipBytes = await zip.generateAsync({
  type: "uint8array",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
await mkdir(releaseDirectory, { recursive: true });
const zipPath = path.join(releaseDirectory, `${releaseName}.zip`);
await writeFile(zipPath, zipBytes);

const executable = await readFile(executablePath);
const css = await readFile(path.join(publishDirectory, "Web", "nmsa.css"));
const javascript = await readFile(path.join(publishDirectory, "Web", "nmsa.js"));
await writeFile(
  path.join(releaseDirectory, `${releaseName}-SHA256.txt`),
  [
    `${sha256(executable)}  NMSA.exe`,
    `${sha256(packagedHtml)}  Web/NMSA.html`,
    `${sha256(css)}  Web/nmsa.css`,
    `${sha256(javascript)}  Web/nmsa.js`,
    `${sha256(zipBytes)}  ${releaseName}.zip`,
    "",
  ].join("\n"),
  "utf8",
);

console.log(`wrote ${zipPath} (${zipBytes.length.toLocaleString()} bytes; ${signatureLabel})`);
