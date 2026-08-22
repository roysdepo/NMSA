import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import master from "../src/data/index.js";
import { parseDataPackage, validateDataPayload } from "../src/data-package.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(project, "dist", "NMSA-Data-6.45.1.atlaspack.json");

const criticalClassificationFields = [
  "contextualKnownProducts",
  "authoritativeCatalogueRecordProducts",
  "authoritativeCatalogueOnlyProductRecords",
  "speculativeShipComponentRecords",
];

const requiredContextualFamilyModes = {
  contextualKnownProducts: "preserve-context",
  platformRewards: "licensed-opt-in",
  contentEntitlements: "licensed-opt-in",
  disallowedSeenTechnologies: "preserve-observed",
  speculativeShipComponentRecords: "diagnostic-only",
  naturalProgressionTargets: "explicit-opt-in",
};

function cloneMaster() {
  return structuredClone(master);
}

test("built-in NMSA payload passes strict classification validation", () => {
  assert.equal(master.schemaVersion, 7);
  assert.doesNotThrow(() => validateDataPayload(master));
});

test("incomplete schema-7 classification payloads fail closed", () => {
  for (const field of criticalClassificationFields) {
    const payload = cloneMaster();
    delete payload[field];
    assert.throws(
      () => validateDataPayload(payload),
      new RegExp(field, "i"),
      `deleting ${field} must invalidate the package`,
    );
  }

  const payload = cloneMaster();
  delete payload.completionCoverage.contextualFamilies;
  assert.throws(
    () => validateDataPayload(payload),
    /contextualFamilies/i,
    "deleting contextualFamilies must invalidate the package",
  );
});

test("classification arrays are validated", () => {
  const wrongAuthoritative = cloneMaster();
  wrongAuthoritative.authoritativeCatalogueRecordProducts[0] =
    wrongAuthoritative.speculativeShipComponentRecords[0];
  assert.throws(
    () => validateDataPayload(wrongAuthoritative),
    /authoritative catalogue classifications/i,
  );
});

test("every required contextual ledger entry fails closed when removed or changed", () => {
  for (const [key, mode] of Object.entries(requiredContextualFamilyModes)) {
    const missingEntry = cloneMaster();
    missingEntry.completionCoverage.contextualFamilies =
      missingEntry.completionCoverage.contextualFamilies.filter(
        (family) => family.key !== key,
      );
    assert.throws(
      () => validateDataPayload(missingEntry),
      new RegExp(`${key} ${mode} classification`, "i"),
      `removing the ${key} ledger entry must invalidate the package`,
    );

    const changedMode = cloneMaster();
    const family = changedMode.completionCoverage.contextualFamilies.find(
      (entry) => entry.key === key,
    );
    family.mode = "complete";
    assert.throws(
      () => validateDataPayload(changedMode),
      new RegExp(`${key} ${mode} classification`, "i"),
      `changing the ${key} ledger mode must invalidate the package`,
    );
  }
});

test("generated NMSA data package verifies and matches the built-in payload", async () => {
  const text = await readFile(packagePath, "utf8");
  const parsed = await parseDataPackage(text);
  assert.equal(parsed.master.schemaVersion, 7);
  assert.equal(parsed.master.activePackage, master.activePackage);
  assert.equal(parsed.master.testedGameVersion, master.testedGameVersion);
  assert.equal(parsed.master.knownProducts.length, master.knownProducts.length);
});

test("tampered NMSA data package is rejected", async () => {
  const text = await readFile(packagePath, "utf8");
  const packageFile = JSON.parse(text);
  packageFile.payload.knownProducts[0] = "^TAMPERED";
  await assert.rejects(() => parseDataPackage(JSON.stringify(packageFile)), /integrity/i);
});
