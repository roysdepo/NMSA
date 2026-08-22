import lz4 from "lz4js";
import {
  MAX_NMS_DECOMPRESSED_BYTES,
  MAX_NMS_INPUT_BYTES,
  decodeJsonFile,
  encodeJsonFile,
  isNmsCompressed,
} from "./nms-codec.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const HGSAVEV2 = new TextEncoder().encode("HGSAVEV2\0");
const NOMANSKY = new TextEncoder().encode("NOMANSKY");
const PORTABLE_META_MAGIC = 0xca55_e77e;
const PORTABLE_META_LENGTHS = new Set([100, 356, 372, 380]);
const CONTAINER_PRESERVING_WRITERS = new Set(["steam", "gog"]);
const WRITE_BLOCKERS = Object.freeze({
  "xbox-game-pass":
    "Xbox writing is disabled until the containers.index, GUID blobs, sync state, and companion metadata can be preserved as one verified transaction.",
  "playstation-extracted":
    "PlayStation writing is disabled until its source container, manifest, and streaming or SaveWizard layout can be preserved exactly.",
  "switch-extracted":
    "Nintendo Switch writing is disabled until its save-data and manifest container can be preserved exactly.",
});

export const HGSAVEV2_LIMITS = Object.freeze({
  maxInputBytes: MAX_NMS_INPUT_BYTES,
  maxDecompressedBytes: MAX_NMS_DECOMPRESSED_BYTES,
  maxFrameDecompressedBytes: 1024 * 1024,
  maxFrames: 512,
});

export function adapterWriteCapability(adapter) {
  if (CONTAINER_PRESERVING_WRITERS.has(adapter)) {
    return Object.freeze({ adapter, writeAllowed: true, reason: null });
  }
  return Object.freeze({
    adapter,
    writeAllowed: false,
    reason:
      WRITE_BLOCKERS[adapter] ||
      "Writing is disabled because no exact container-preserving encoder is verified for this platform.",
  });
}

function assertContainerPreservingWriter(adapter) {
  const capability = adapterWriteCapability(adapter);
  if (!capability.writeAllowed) throw new Error(capability.reason);
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function concatBytes(chunks, knownLength = null) {
  const length = knownLength ?? chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function decompressRawLz4(bytes, expectedLength) {
  if (!Number.isInteger(expectedLength) || expectedLength <= 0 || expectedLength > 256 * 1024 * 1024) {
    throw new Error("Xbox account metadata has an invalid decompressed size.");
  }
  const output = new Uint8Array(expectedLength);
  const written = lz4.decompressBlock(bytes, output, 0, bytes.length, 0);
  if (written <= 0 || written > expectedLength) {
    throw new Error("Xbox account LZ4 data could not be decoded.");
  }
  return output.slice(0, written);
}

function scanHgSaveV2Frames(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > HGSAVEV2_LIMITS.maxInputBytes) {
    throw new Error("HGSAVEV2 input exceeds the safety limit.");
  }
  if (!startsWith(bytes, HGSAVEV2)) throw new Error("Not an HGSAVEV2 file.");

  const frames = [];
  let offset = HGSAVEV2.length;
  let totalLength = 0;
  while (offset < bytes.length) {
    if (frames.length >= HGSAVEV2_LIMITS.maxFrames) {
      throw new Error("HGSAVEV2 contains too many frames.");
    }
    if (offset + 8 > bytes.length) throw new Error("Truncated HGSAVEV2 frame header.");
    const rawLength = readU32(bytes, offset);
    const compressedLength = readU32(bytes, offset + 4);
    offset += 8;
    if (!rawLength || !compressedLength) {
      throw new Error("Invalid HGSAVEV2 frame lengths.");
    }
    if (rawLength > HGSAVEV2_LIMITS.maxFrameDecompressedBytes) {
      throw new Error("HGSAVEV2 frame exceeds the decompressed safety limit.");
    }
    if (compressedLength > lz4.compressBound(rawLength)) {
      throw new Error("HGSAVEV2 frame exceeds the compressed safety limit.");
    }
    if (compressedLength > bytes.length - offset) {
      throw new Error("Truncated HGSAVEV2 frame payload.");
    }
    if (rawLength > HGSAVEV2_LIMITS.maxDecompressedBytes - totalLength) {
      throw new Error("HGSAVEV2 aggregate output exceeds the decompressed safety limit.");
    }
    frames.push({ offset, rawLength, compressedLength });
    totalLength += rawLength;
    offset += compressedLength;
  }
  if (frames.length === 0) throw new Error("HGSAVEV2 contains no frames.");
  return { frames, totalLength };
}

function decompressHgSaveV2(bytes) {
  const { frames, totalLength } = scanHgSaveV2Frames(bytes);
  const chunks = [];
  for (const frame of frames) {
    const { offset, rawLength, compressedLength } = frame;
    const output = new Uint8Array(rawLength);
    const written = lz4.decompressBlock(bytes, output, offset, compressedLength, 0);
    if (written !== rawLength) {
      throw new Error(`HGSAVEV2 frame decoded to ${written}; expected ${rawLength}.`);
    }
    chunks.push(output);
  }
  return concatBytes(chunks, totalLength);
}

function extractNomanSkyPayload(bytes) {
  if (!startsWith(bytes, NOMANSKY) || bytes.length < 0x70) {
    throw new Error("Invalid NOMANSKY extracted-save header.");
  }
  let length = readU32(bytes, 0x5c);
  const available = bytes.length - 0x70;
  if (!length || length > available) length = available;
  return {
    header: bytes.slice(0, 0x70),
    payload: bytes.slice(0x70, 0x70 + length),
  };
}

export function adapterForRecord(record) {
  return record?.adapter || record?.platform || "steam";
}

export function decodeAdapterFile(record, mapping, companionMeta = null, role = "save") {
  const adapter = adapterForRecord(record);
  const bytes = record.bytes;

  if (adapter === "playstation-extracted" && startsWith(bytes, NOMANSKY)) {
    const extracted = extractNomanSkyPayload(bytes);
    const decoded = decodeJsonFile(extracted.payload, mapping);
    return {
      ...decoded,
      containerCompressed: false,
      platformEncoding: "nomansky",
      platformState: { header: extracted.header },
    };
  }

  if (adapter === "xbox-game-pass") {
    if (role === "account" && !isNmsCompressed(bytes) && !startsWith(bytes, HGSAVEV2)) {
      const expectedLength = companionMeta?.bytes?.length >= 20
        ? readU32(companionMeta.bytes, 16)
        : 0;
      let raw;
      try {
        raw = decompressRawLz4(bytes, expectedLength);
      } catch {
        raw = bytes;
      }
      const decoded = decodeJsonFile(raw, mapping);
      return {
        ...decoded,
        containerCompressed: true,
        platformEncoding: raw === bytes ? "plain" : "xbox-raw-lz4",
        platformState: {},
      };
    }
    if (startsWith(bytes, HGSAVEV2)) {
      const decoded = decodeJsonFile(decompressHgSaveV2(bytes), mapping);
      return {
        ...decoded,
        containerCompressed: true,
        platformEncoding: "hgsavev2",
        platformState: {},
      };
    }
  }

  const decoded = decodeJsonFile(bytes, mapping);
  return {
    ...decoded,
    containerCompressed: decoded.compressed,
    platformEncoding: decoded.compressed ? "nms-lz4" : "plain",
    platformState: {},
  };
}

export function encodeAdapterFile(value, mapping, loaded, role = "save") {
  const adapter = loaded.adapter;
  assertContainerPreservingWriter(adapter);
  const trailingNullBytes = loaded.trailingNullBytes ?? (loaded.compressed ? 1 : 0);
  return encodeJsonFile(
    value,
    mapping,
    loaded.compressed,
    loaded.textEncoding,
    trailingNullBytes,
  );
}

export function decodePortableManifest(bytes, expectedIndex = null) {
  if (!PORTABLE_META_LENGTHS.has(bytes.length)) {
    throw new Error(`Unsupported portable manifest length ${bytes.length}.`);
  }
  const magic = readU32(bytes, 0);
  const format = readU32(bytes, 4);
  const decompressedLength = readU32(bytes, 8);
  const index = readU32(bytes, 12);
  if (magic !== PORTABLE_META_MAGIC) throw new Error("Portable manifest magic is invalid.");
  if (expectedIndex !== null && index !== expectedIndex) {
    throw new Error(`Portable manifest index ${index} does not match file index ${expectedIndex}.`);
  }
  return { bytes: bytes.slice(), magic, format, decompressedLength, index };
}

export function validatePortableManifest(manifest, decoded) {
  return manifest.decompressedLength === decoded.decompressedLength;
}

export function updatePortableManifest() {
  throw new Error(
    "Portable console metadata writing is disabled until an exact container-preserving encoder is verified.",
  );
}

export function validateXboxMeta(record, decoded, role) {
  if (!record?.bytes?.length) return role === "save";
  if (role === "account" && record.bytes.length >= 20) {
    return readU32(record.bytes, 16) === decoded.decompressedLength;
  }
  return record.bytes.length >= 16;
}

export function updateXboxMeta() {
  throw new Error(WRITE_BLOCKERS["xbox-game-pass"]);
}

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function directoryOf(value) {
  const path = normalizedPath(value);
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function recordFromEntry(entry, adapter) {
  const file = entry?.file ?? entry;
  const relativePath = normalizedPath(entry?.relativePath || file?.webkitRelativePath || file?.name);
  return {
    ...entry,
    file,
    name: file?.name || entry?.name || relativePath.split("/").at(-1),
    size: Number(file?.size ?? entry?.size ?? 0),
    lastModified: Number(file?.lastModified ?? entry?.lastModified ?? 0),
    relativePath,
    directory: directoryOf(relativePath),
    adapter,
    platform: adapter,
  };
}

export function discoverPortableFileSets(entries) {
  const directories = new Map();
  for (const entry of entries) {
    const name = String(entry?.name || entry?.file?.name || "").toLowerCase();
    if (!/^(?:savedata|manifest)\d{2}\.hg$/.test(name) && name !== "accountdata.hg") continue;
    const directory = directoryOf(entry?.relativePath || entry?.file?.webkitRelativePath || name);
    if (!directories.has(directory)) directories.set(directory, []);
    directories.get(directory).push(entry);
  }

  const sets = [];
  for (const [directory, rawEntries] of directories) {
    const rawByName = new Map(
      rawEntries.map((entry) => [String(entry?.name || entry?.file?.name || "").toLowerCase(), entry]),
    );
    const isSwitch = rawByName.has("accountdata.hg");
    const adapter = isSwitch ? "switch-extracted" : "playstation-extracted";
    const accountName = isSwitch ? "accountdata.hg" : "savedata00.hg";
    const accountMetaName = isSwitch ? null : "manifest00.hg";
    const accountRaw = rawByName.get(accountName);
    const accountMetaRaw = accountMetaName ? rawByName.get(accountMetaName) : null;

    for (const [name, saveRaw] of rawByName) {
      const match = /^savedata(\d{2})\.hg$/.exec(name);
      if (!match) continue;
      const index = Number(match[1]);
      if ((!isSwitch && index < 2) || (isSwitch && name === accountName)) continue;
      const metaRaw = rawByName.get(`manifest${String(index).padStart(2, "0")}.hg`);
      const logicalSlot = isSwitch ? Math.floor(index / 2) + 1 : Math.floor((index - 2) / 2) + 1;
      const missing = [];
      if (!metaRaw) missing.push(`manifest${String(index).padStart(2, "0")}.hg`);
      if (!accountRaw) missing.push(accountName);
      if (!isSwitch && !accountMetaRaw) missing.push(accountMetaName);
      sets.push({
        id: `${adapter}|${directory}|${index}`,
        adapter,
        platform: adapter,
        directory,
        profileName: directory.split("/").at(-1) || directory,
        logicalSlot,
        storageOrdinal: index,
        save: recordFromEntry(saveRaw, adapter),
        saveMeta: metaRaw ? recordFromEntry(metaRaw, adapter) : null,
        account: accountRaw ? recordFromEntry(accountRaw, adapter) : null,
        accountMeta: accountMetaRaw ? recordFromEntry(accountMetaRaw, adapter) : null,
        portableManifestIndex: index,
        missing,
        complete: missing.length === 0,
      });
    }
  }
  return sets;
}

export function looksLikePortableEntries(entries) {
  return entries.some((entry) => /^savedata\d{2}\.hg$/i.test(entry?.name || entry?.file?.name || ""));
}

export function decodeUtf8Preview(bytes) {
  return textDecoder.decode(bytes);
}
