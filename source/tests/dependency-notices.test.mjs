import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import JSZip from "jszip";
import {
  DEPENDENCY_NOTICE_MANIFEST,
  addDependencyNoticesToZip,
  dependencyNoticeEntries,
  dependencyNoticeFiles,
  loadDependencyNoticeManifest,
} from "../scripts/dependency-notices.mjs";
import { normalizeZipEntryDates } from "../scripts/release-zip.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = path.resolve(project, "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageNameFromMetafileInput(input) {
  const normalized = input.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const segments = normalized.slice(markerIndex + marker.length).split("/");
  return segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

async function bundleMetafile() {
  return build({
    absWorkingDir: project,
    entryPoints: ["./src/app.js"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome100", "edge100", "firefox100", "safari16"],
    minify: true,
    legalComments: "none",
    nodePaths: [path.join(project, "node_modules")],
    tsconfigRaw: { compilerOptions: {} },
    metafile: true,
    write: false,
  });
}

test("common legal manifest exactly follows the JavaScript packages embedded by esbuild", async () => {
  const [{ metafile }, { manifest }, lockBytes] = await Promise.all([
    bundleMetafile(),
    loadDependencyNoticeManifest(distributionRoot),
    readFile(path.join(project, "package-lock.json")),
  ]);
  const bundledNames = [...new Set(
    Object.keys(metafile.inputs).map(packageNameFromMetafileInput).filter(Boolean),
  )].sort();
  const directManifestNames = manifest.groups.common
    .filter((entry) => !entry.bundledBy)
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(directManifestNames, bundledNames);

  const lock = JSON.parse(lockBytes);
  for (const entry of manifest.groups.common) {
    const locked = lock.packages[`node_modules/${entry.name}`];
    assert.ok(locked, `${entry.name} is not locked at the expected package path`);
    assert.equal(entry.version, locked.version, `${entry.name} version drifted`);
    assert.equal(
      entry.declaredLicense ?? entry.license,
      locked.license,
      `${entry.name} license declaration drifted`,
    );
  }

  for (const evidence of manifest.bundleEvidence) {
    const artifact = await readFile(
      path.join(project, "node_modules", evidence.package, ...evidence.upstreamFile.split("/")),
    );
    assert.equal(sha256(artifact), evidence.sha256, `${evidence.id} changed and requires a new embedded-code audit`);
    const indexedEmbedded = manifest.groups.common
      .filter((entry) => entry.bundledBy === evidence.id)
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(indexedEmbedded, [...evidence.embeddedDependencies].sort());
  }

  const jszipPackage = JSON.parse(
    await readFile(path.join(project, "node_modules", "jszip", "package.json")),
  );
  assert.equal(jszipPackage.browser["./lib/index"], "./dist/jszip.min.js");
  assert.ok(
    Object.keys(metafile.inputs).some((input) =>
      input.replaceAll("\\", "/").endsWith("node_modules/jszip/dist/jszip.min.js"),
    ),
    "esbuild no longer consumes JSZip's audited prebundled browser artifact",
  );
  const pako = manifest.groups.common.find((entry) => entry.name === "pako");
  assert.ok(pako.files.some((file) => file.upstreamFile === "lib/zlib/README"));
});

test("every distributed dependency notice is indexed, hash-locked, and provenance checked", async () => {
  const [{ manifest }, notices, legalDirectoryEntries] = await Promise.all([
    loadDependencyNoticeManifest(distributionRoot),
    readFile(path.join(distributionRoot, "THIRD_PARTY_NOTICES.md"), "utf8"),
    readdir(path.join(distributionRoot, "Legal"), { withFileTypes: true }),
  ]);
  const entries = dependencyNoticeEntries(manifest, "desktop");
  const files = dependencyNoticeFiles(manifest, "desktop");
  const indexedFilenames = files.map((file) => file.name).sort();
  const legalTextFilenames = legalDirectoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(legalTextFilenames, indexedFilenames, "Legal contains an unindexed or missing notice file");

  for (const entry of entries) {
    assert.ok(
      notices.toLowerCase().includes(`**${entry.name} ${entry.version}**`.toLowerCase()),
      `notice index omits ${entry.name}@${entry.version}`,
    );
    for (const file of entry.files) {
      const bytes = await readFile(path.join(distributionRoot, "Legal", file.name));
      assert.equal(sha256(bytes), file.sha256, `${file.name} changed from its audited bytes`);
      assert.ok(notices.includes(`Legal/${file.name}`), `notice index omits ${file.name}`);
      if (file.upstreamFile) {
        const upstreamBytes = await readFile(
          path.join(project, "node_modules", entry.name, ...file.upstreamFile.split("/")),
        );
        assert.deepEqual(bytes, upstreamBytes, `${file.name} is not the exact installed upstream artifact`);
      }
    }
  }

  const jszip = manifest.groups.common.find((entry) => entry.name === "jszip");
  assert.equal(jszip.license, "MIT");
  assert.equal(jszip.declaredLicense, "(MIT OR GPL-3.0-or-later)");
  assert.match(notices, /JSZip 3\.10\.1.*under the MIT option/);

  const lz4 = manifest.groups.common.find((entry) => entry.name === "lz4js");
  const lz4Terms = await readFile(
    path.join(distributionRoot, "Legal", "npm-lz4js-0.2.0-ISC-LICENSE.txt"),
    "utf8",
  );
  assert.equal(lz4.files.length, 2);
  assert.match(lz4Terms, /Canonical ISC License Terms/);
  assert.match(lz4Terms, /<copyright notice>/);
  assert.doesNotMatch(lz4Terms, /Copyright \(c\) John Chadwick/);
  assert.match(notices, /without inventing a missing copyright notice/);
});

async function buildLegalArchive(target, date) {
  const zip = new JSZip();
  const root = zip.folder("NMSA-test");
  root.file("Legal/LICENSE", await readFile(path.join(distributionRoot, "LICENSE")), { date });
  root.file(
    "Legal/THIRD_PARTY_NOTICES.md",
    await readFile(path.join(distributionRoot, "THIRD_PARTY_NOTICES.md")),
    { date },
  );
  await addDependencyNoticesToZip(root, distributionRoot, target);
  normalizeZipEntryDates(zip);
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

test("portable and desktop legal payloads are deterministic and contain the exact target boundary", async () => {
  const { manifest } = await loadDependencyNoticeManifest(distributionRoot);
  for (const target of ["portable", "desktop"]) {
    const first = await buildLegalArchive(target, new Date("2024-01-01T00:00:00Z"));
    const second = await buildLegalArchive(target, new Date("2026-08-21T00:00:00Z"));
    assert.deepEqual(first, second, `${target} legal archive is not deterministic`);

    const archive = await JSZip.loadAsync(first);
    const actualLegalFiles = Object.keys(archive.files)
      .filter((name) => name.startsWith("NMSA-test/Legal/") && !name.endsWith("/"))
      .map((name) => name.slice("NMSA-test/Legal/".length))
      .sort();
    const expectedLegalFiles = [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      DEPENDENCY_NOTICE_MANIFEST,
      ...dependencyNoticeFiles(manifest, target).map((file) => file.name),
    ].sort();
    assert.deepEqual(actualLegalFiles, expectedLegalFiles);

    for (const file of dependencyNoticeFiles(manifest, target)) {
      const bytes = await archive.file(`NMSA-test/Legal/${file.name}`).async("uint8array");
      assert.equal(sha256(bytes), file.sha256, `${target} archive changed ${file.name}`);
    }
  }
});

test("every release packager consumes the shared dependency notice manifest", async () => {
  const [portable, desktop, msix] = await Promise.all([
    readFile(path.join(project, "scripts", "package.mjs"), "utf8"),
    readFile(path.join(project, "scripts", "package-desktop.mjs"), "utf8"),
    readFile(path.join(project, "scripts", "package-msix.ps1"), "utf8"),
  ]);
  assert.match(portable, /addDependencyNoticesToZip\(root, distributionRoot, "portable"\)/);
  assert.match(desktop, /addDependencyNoticesToZip\(root, distributionRoot, "desktop"\)/);
  assert.doesNotMatch(portable, /npm-[\w-]+-LICENSE/);
  assert.doesNotMatch(desktop, /npm-[\w-]+-LICENSE/);
  assert.match(msix, /\$noticeManifestFilename = 'dependency-notices\.json'/);
  assert.match(msix, /@\('common', 'desktopOnly'\)/);
  assert.match(msix, /Get-FileHash -LiteralPath \$legalSource -Algorithm SHA256/);
  assert.match(msix, /\[IO\.File\]::Copy\(\$noticeManifestPath/);
  assert.doesNotMatch(msix, /npm-[\w-]+-LICENSE/);
});
