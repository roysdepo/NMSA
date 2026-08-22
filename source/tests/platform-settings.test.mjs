import assert from "node:assert/strict";
import test from "node:test";
import {
  completePlatformSettings,
  decodePlatformSettings,
  readPlatformRewards,
  verifyPlatformSettings,
} from "../src/platform-settings.js";

const required = [
  "^TGA_SHIP1",
  "^SW_PREORDER",
  "^SW_PREORDER2",
  "^ENT_BOLTCASTER",
  "^ENT_PHOCORE",
  "^ENT_XO_HELMET",
];

function utf8(text, bom = false) {
  const bytes = new TextEncoder().encode(text);
  if (!bom) return bytes;
  const output = new Uint8Array(bytes.length + 3);
  output.set([0xef, 0xbb, 0xbf]);
  output.set(bytes, 3);
  return output;
}

function utf16le(text) {
  const output = new Uint8Array(2 + text.length * 2);
  output.set([0xff, 0xfe]);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    output[2 + index * 2] = code & 0xff;
    output[3 + index * 2] = code >>> 8;
  }
  return output;
}

const nested = `<?xml version="1.0" encoding="utf-8"?>\r
<Data template="GcUserSettingsData">\r
  <Property name="SomeOtherSetting" value="true" />\r
  <Property name="UnlockedPlatformRewards">\r
    <Property name="UnlockedPlatformRewards" value="TGA_SHIP1" _index="0" />\r
  </Property>\r
</Data>`;

test("PC platform settings add every TGA, Switch, and content entitlement without touching other settings", () => {
  const decoded = decodePlatformSettings(utf8(nested, true));
  const completed = completePlatformSettings(decoded, required);
  assert.deepEqual(completed.added, required.slice(1));
  assert.equal(completed.encoding, "utf-8");
  assert.deepEqual([...completed.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(completed.text, /SomeOtherSetting" value="true"/);
  assert.equal(completed.text.includes("\r\n"), true);
  assert.equal(verifyPlatformSettings(completed, required), true);
  assert.deepEqual(readPlatformRewards(completed.text), required);
  assert.equal(completed.text.includes("SW_PREORDER"), true);
});

test("legacy flat rewards migrate to the current nested structure", () => {
  const source = `<?xml version="1.0" encoding="utf-8"?>
<Data template="GcUserSettingsData">
  <Property name="UnlockedPlatformRewards" value="TGA_SHIP1" _index="0" />
</Data>`;
  const completed = completePlatformSettings(decodePlatformSettings(utf8(source)), required);
  assert.match(completed.text, /<Property name="UnlockedPlatformRewards">/);
  assert.equal(
    /<Data[^>]*>\s*<Property name="UnlockedPlatformRewards" value=/s.test(completed.text),
    false,
  );
  assert.equal(verifyPlatformSettings(completed, required), true);
  assert.deepEqual(readPlatformRewards(completed.text), required);
});

test("an empty settings document gains a complete sequential reward container", () => {
  const source = `<?xml version="1.0" encoding="utf-8"?>
<Data template="GcUserSettingsData">
</Data>`;
  const completed = completePlatformSettings(decodePlatformSettings(utf8(source)), required);
  for (const [index, reward] of required.entries()) {
    assert.match(
      completed.text,
      new RegExp(`value="${reward.slice(1)}" _index="${index}"`),
    );
  }
});

test("UTF-16LE encoding and BOM survive platform settings completion", () => {
  const decoded = decodePlatformSettings(utf16le(nested.replaceAll("\r\n", "\n")));
  const completed = completePlatformSettings(decoded, required);
  assert.equal(completed.encoding, "utf-16le");
  assert.deepEqual([...completed.bytes.slice(0, 2)], [0xff, 0xfe]);
  assert.equal(verifyPlatformSettings(decodePlatformSettings(completed.bytes), required), true);
});

test("already-complete platform settings round-trip byte-for-byte", () => {
  const initial = completePlatformSettings(decodePlatformSettings(utf8(nested)), required);
  const second = completePlatformSettings(decodePlatformSettings(initial.bytes), required);
  assert.equal(second.changed, false);
  assert.deepEqual(second.bytes, initial.bytes);
});

test("unrelated XML is rejected before any output is produced", () => {
  assert.throws(
    () => decodePlatformSettings(utf8("<Settings></Settings>")),
    /not a supported NMS settings document/,
  );
});
