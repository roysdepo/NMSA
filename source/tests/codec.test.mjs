import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import master from "../src/data/index.js";
import {
  bytesEqual,
  compressNms,
  decodeJsonFile,
  decodeJsonFileForPreview,
  decodeMetadata,
  decompressNms,
  encodeJsonFile,
  encodeMetadata,
  isNmsCompressed,
  updateMetadata,
  validateMetadata,
} from "../src/nms-codec.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(project, "../../..");
const save8FixturePaths = [
  "samples/save8.hg",
  "samples/mf_save8.hg",
];
const legacyFixturePaths = [
  "samples/save6.hg",
  "samples/save2(2).hg",
];
const hasSave8Fixtures = save8FixturePaths.every((relativePath) =>
  existsSync(path.join(workspace, relativePath)),
);
const hasLegacyFixtures = legacyFixturePaths.every((relativePath) =>
  existsSync(path.join(workspace, relativePath)),
);

async function bytes(relativePath) {
  return new Uint8Array(await readFile(path.join(workspace, relativePath)));
}

test("raw NMS LZ4 blocks round-trip Save8", { skip: !hasSave8Fixtures }, async () => {
  for (const filename of ["save8.hg"]) {
    const input = await bytes(`samples/${filename}`);
    assert.equal(isNmsCompressed(input), true);
    const raw = decompressNms(input);
    const rebuilt = compressNms(raw);
    assert.deepEqual(decompressNms(rebuilt), raw, filename);
  }
});

test("raw NMS LZ4 blocks round-trip legacy one-byte saves", { skip: !hasLegacyFixtures }, async () => {
  for (const filename of ["save6.hg", "save2(2).hg"]) {
    const input = await bytes(`samples/${filename}`);
    assert.equal(isNmsCompressed(input), true);
    const raw = decompressNms(input);
    const rebuilt = compressNms(raw);
    assert.deepEqual(decompressNms(rebuilt), raw, filename);
  }
});

test("metadata decrypts and re-encrypts byte-identically", { skip: !hasSave8Fixtures }, async () => {
  const fixtures = [["samples/mf_save8.hg", 9]];
  for (const [filename, slot] of fixtures) {
    const input = await bytes(filename);
    const decoded = decodeMetadata(input, slot);
    assert.equal(decoded.slot, slot);
    assert.equal(decoded.words[0], 0xeeee_eebe);
    assert.equal(decoded.words[1], 2004);
    assert.equal(
      bytesEqual(
        encodeMetadata(decoded.words, decoded.slot, decoded.byteLength),
        input,
      ),
      true,
      filename,
    );
  }
});

test("Save8 decodes, re-encodes, and decodes without semantic loss", { skip: !hasSave8Fixtures }, async () => {
  const input = await bytes("samples/save8.hg");
  const decoded = decodeJsonFile(input, master.saveMap);
  const encoded = encodeJsonFile(
    decoded.value,
    master.saveMap,
    true,
    decoded.textEncoding,
  );
  const roundTrip = decodeJsonFile(encoded.bytes, master.saveMap);
  assert.deepEqual(roundTrip.value, decoded.value);
  assert.equal(roundTrip.decompressedLength, encoded.decompressedLength);
  assert.equal(encoded.compressed, true);
  assert.equal(encoded.trailingNullBytes, decoded.trailingNullBytes);
});

test("Save8 output produces a strict current-format manifest", { skip: !hasSave8Fixtures }, async () => {
  const decoded = decodeJsonFile(await bytes("samples/save8.hg"), master.saveMap);
  const encoded = encodeJsonFile(
    decoded.value,
    master.saveMap,
    decoded.compressed,
    decoded.textEncoding,
    decoded.trailingNullBytes,
  );
  const originalMeta = decodeMetadata(await bytes("samples/mf_save8.hg"), 9);
  const updated = updateMetadata(
    originalMeta,
    encoded.bytes,
    encoded.decompressedLength,
    encoded.compressed,
  );
  const checkedMeta = decodeMetadata(updated.bytes, originalMeta.slot);
  const checkedSave = decodeJsonFile(encoded.bytes, master.saveMap);

  assert.equal(encoded.compressed, true);
  assert.equal(checkedMeta.words[14], checkedSave.decompressedLength);
  assert.equal(checkedMeta.words[15], encoded.bytes.length);
  assert.equal(checkedMeta.words[21], checkedSave.decompressedLength);
  assert.equal(
    validateMetadata(
      checkedMeta,
      encoded.bytes,
      checkedSave.decompressedLength,
      checkedSave.compressed,
      { strict: true },
    ),
    true,
  );
});

test("unsafe JSON integers retain their exact decimal representation", () => {
  const source = new TextEncoder().encode(
    '{"small":7,"huge":9007199254740993123456789}',
  );
  const decoded = decodeJsonFile(source, {});
  const encoded = encodeJsonFile(decoded.value, {}, false);
  assert.equal(new TextDecoder().decode(encoded.bytes), new TextDecoder().decode(source));
});

test("legacy one-byte save strings retain their values across a round trip", { skip: !hasLegacyFixtures }, async () => {
  for (const filename of ["save6.hg", "save2(2).hg"]) {
    const decoded = decodeJsonFile(awaited.get(filename), master.saveMap);
    assert.equal(decoded.textEncoding, "latin1");
    const encoded = encodeJsonFile(
      decoded.value,
      master.saveMap,
      true,
      decoded.textEncoding,
    );
    const roundTrip = decodeJsonFile(encoded.bytes, master.saveMap);
    assert.deepEqual(roundTrip.value, decoded.value);
    assert.equal(roundTrip.textEncoding, "latin1");
  }
});

test("one-byte string values decode and encode without changing their bytes", () => {
  const prefix = new TextEncoder().encode('{"CommonStateData":{"SaveName":"Named save"},"legacy":"');
  const suffix = new TextEncoder().encode('"}');
  const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
  bytes.set(prefix);
  bytes[prefix.length] = 0x80;
  bytes.set(suffix, prefix.length + 1);
  const decoded = decodeJsonFile(bytes, {});
  assert.equal(decoded.textEncoding, "latin1");
  assert.equal(decoded.value.legacy.charCodeAt(0), 0x80);
  const encoded = encodeJsonFile(decoded.value, {}, false, decoded.textEncoding);
  assert.deepEqual(encoded.bytes, bytes);
  const preview = decodeJsonFileForPreview(bytes, {});
  assert.equal(preview.value.CommonStateData.SaveName, "Named save");
  assert.equal(preview.textEncoding, "latin1");
});

test("plain JSON preserves an explicit trailing terminator policy", () => {
  const value = { exact: 9007199254740993123456789n.toString() };
  const terminated = encodeJsonFile(value, {}, false, "utf-8", 1);
  const unterminated = encodeJsonFile(value, {}, false, "utf-8", 0);
  assert.equal(terminated.compressed, false);
  assert.equal(terminated.bytes.at(-1), 0);
  assert.equal(terminated.decompressedLength, unterminated.decompressedLength + 1);
  assert.equal(decodeJsonFile(terminated.bytes, {}).trailingNullBytes, 1);
  assert.equal(decodeJsonFile(unterminated.bytes, {}).trailingNullBytes, 0);
});

test("crafted compressed saves cannot request unbounded allocations", () => {
  const malicious = new Uint8Array(17);
  const header = new DataView(malicious.buffer);
  header.setUint32(0, 0xfeed_a1e5, true);
  header.setUint32(4, 1, true);
  header.setUint32(8, 0xffff_ffff, true);
  header.setUint32(12, 0, true);
  assert.throws(
    () => decompressNms(malicious),
    /decompressed safety limit/,
  );
});

test("save key mapping rejects dangerous keys without prototype mutation", () => {
  const source = new TextEncoder().encode(
    '{"__proto__":{"polluted":true},"constructor":"save-value","normal":1}',
  );
  assert.throws(
    () => decodeJsonFile(source, {}),
    /unsafe object prototype/,
  );
  assert.equal({}.polluted, undefined);
});

test("excessively nested save JSON is rejected before recursive processing", () => {
  const nested = `${'{"child":'.repeat(130)}null${"}".repeat(130)}`;
  assert.throws(
    () => decodeJsonFile(new TextEncoder().encode(nested), {}),
    /nesting safety limit/,
  );
});

const awaited = new Map();
if (hasLegacyFixtures) {
  for (const filename of ["save6.hg", "save2(2).hg"]) {
    awaited.set(filename, await bytes(`samples/${filename}`));
  }
}
