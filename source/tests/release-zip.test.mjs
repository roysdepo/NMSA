import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  RELEASE_ZIP_ENTRY_DATE_MS,
  normalizeZipEntryDates,
} from "../scripts/release-zip.mjs";

async function buildArchive(date) {
  const zip = new JSZip();
  const root = zip.folder("NMSA-test");
  root.file("README.md", "same release bytes", { date });
  root.file("source/app.js", "export const stable = true;", { date });
  normalizeZipEntryDates(zip);
  for (const entry of Object.values(zip.files)) {
    assert.equal(entry.date.getTime(), RELEASE_ZIP_ENTRY_DATE_MS);
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

test("release ZIP metadata is normalized for reproducible archives", async () => {
  const first = await buildArchive(new Date("2024-01-01T00:00:00Z"));
  const second = await buildArchive(new Date("2026-08-14T18:00:00Z"));
  assert.deepEqual(first, second);
});
