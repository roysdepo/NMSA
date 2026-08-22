import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEPENDENCY_NOTICE_MANIFEST = "dependency-notices.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireManifest(condition, message) {
  if (!condition) throw new Error(`Dependency notice manifest is invalid: ${message}`);
}

export function validateDependencyNoticeManifest(manifest) {
  requireManifest(manifest?.schemaVersion === 1, "schemaVersion must be 1");
  requireManifest(manifest.groups && typeof manifest.groups === "object", "groups are missing");
  requireManifest(Array.isArray(manifest.bundleEvidence), "bundleEvidence must be an array");
  for (const groupName of ["common", "desktopOnly"]) {
    const entries = manifest.groups[groupName];
    requireManifest(Array.isArray(entries) && entries.length > 0, `${groupName} must be a non-empty array`);
  }

  const identities = new Set();
  const filenames = new Set();
  const evidenceIds = new Set();
  for (const evidence of manifest.bundleEvidence) {
    requireManifest(typeof evidence.id === "string" && evidence.id.length > 0, "bundle evidence id is missing");
    requireManifest(!evidenceIds.has(evidence.id), `duplicate bundle evidence id ${evidence.id}`);
    evidenceIds.add(evidence.id);
    requireManifest(typeof evidence.package === "string" && evidence.package.length > 0, `${evidence.id} package is missing`);
    requireManifest(typeof evidence.version === "string" && evidence.version.length > 0, `${evidence.id} version is missing`);
    requireManifest(
      typeof evidence.upstreamFile === "string" &&
        evidence.upstreamFile.length > 0 &&
        !path.posix.isAbsolute(evidence.upstreamFile) &&
        !path.win32.isAbsolute(evidence.upstreamFile) &&
        path.posix.normalize(evidence.upstreamFile) === evidence.upstreamFile &&
        !evidence.upstreamFile.startsWith("../"),
      `${evidence.id} has an invalid upstream file`,
    );
    requireManifest(/^[a-f0-9]{64}$/.test(evidence.sha256), `${evidence.id} has an invalid SHA-256`);
    requireManifest(
      Array.isArray(evidence.embeddedDependencies) && evidence.embeddedDependencies.length > 0,
      `${evidence.id} embeddedDependencies must be a non-empty array`,
    );
  }
  for (const groupName of ["common", "desktopOnly"]) {
    for (const entry of manifest.groups[groupName]) {
      requireManifest(typeof entry.name === "string" && entry.name.length > 0, `${groupName} package name is missing`);
      requireManifest(typeof entry.version === "string" && entry.version.length > 0, `${entry.name} version is missing`);
      requireManifest(typeof entry.license === "string" && entry.license.length > 0, `${entry.name} license is missing`);
      requireManifest(Array.isArray(entry.files) && entry.files.length > 0, `${entry.name} files are missing`);
      if (entry.bundledBy !== undefined) {
        requireManifest(
          groupName === "common" && evidenceIds.has(entry.bundledBy),
          `${entry.name} references unknown bundle evidence ${entry.bundledBy}`,
        );
      }
      const identity = `${entry.name}@${entry.version}`;
      requireManifest(!identities.has(identity), `duplicate package ${identity}`);
      identities.add(identity);

      for (const file of entry.files) {
        requireManifest(typeof file.name === "string" && file.name.length > 0, `${identity} has an unnamed file`);
        requireManifest(
          path.posix.basename(file.name) === file.name && path.win32.basename(file.name) === file.name,
          `${identity} has a non-basename file`,
        );
        requireManifest(file.name.endsWith(".txt"), `${identity} notice must use a .txt filename`);
        requireManifest(/^[a-f0-9]{64}$/.test(file.sha256), `${identity}/${file.name} has an invalid SHA-256`);
        requireManifest(!filenames.has(file.name), `duplicate notice filename ${file.name}`);
        filenames.add(file.name);
      }
    }
  }
  for (const evidence of manifest.bundleEvidence) {
    const carrier = manifest.groups.common.find((entry) => entry.name === evidence.package);
    requireManifest(carrier?.version === evidence.version, `${evidence.id} carrier package/version is not in common`);
    const indexedDependencies = manifest.groups.common
      .filter((entry) => entry.bundledBy === evidence.id)
      .map((entry) => entry.name)
      .sort();
    requireManifest(
      JSON.stringify(indexedDependencies) === JSON.stringify([...evidence.embeddedDependencies].sort()),
      `${evidence.id} embedded dependency index does not match bundledBy entries`,
    );
  }
  return manifest;
}

export async function loadDependencyNoticeManifest(distributionRoot) {
  const manifestPath = path.join(distributionRoot, "Legal", DEPENDENCY_NOTICE_MANIFEST);
  const bytes = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Dependency notice manifest is not valid JSON: ${error.message}`);
  }
  return { bytes, manifest: validateDependencyNoticeManifest(manifest) };
}

export function dependencyNoticeEntries(manifest, target) {
  requireManifest(target === "portable" || target === "desktop", `unknown packaging target ${target}`);
  return target === "desktop"
    ? [...manifest.groups.common, ...manifest.groups.desktopOnly]
    : [...manifest.groups.common];
}

export function dependencyNoticeFiles(manifest, target) {
  return dependencyNoticeEntries(manifest, target).flatMap((entry) => entry.files);
}

export async function addDependencyNoticesToZip(zipRoot, distributionRoot, target) {
  const { bytes: manifestBytes, manifest } = await loadDependencyNoticeManifest(distributionRoot);
  zipRoot.file(`Legal/${DEPENDENCY_NOTICE_MANIFEST}`, manifestBytes);
  for (const file of dependencyNoticeFiles(manifest, target)) {
    const bytes = await readFile(path.join(distributionRoot, "Legal", file.name));
    const actualHash = sha256(bytes);
    if (actualHash !== file.sha256) {
      throw new Error(
        `Dependency notice hash mismatch for ${file.name}: expected ${file.sha256}, got ${actualHash}`,
      );
    }
    zipRoot.file(`Legal/${file.name}`, bytes);
  }
  return manifest;
}
