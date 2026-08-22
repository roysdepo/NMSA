import lz4 from "lz4js";
import {
  isSafeNumber,
  isLosslessNumber,
  parse as parseLossless,
  parseLosslessNumber,
  stringify as stringifyLossless,
} from "lossless-json";

export const NMS_BLOCK_MAGIC = 0xfeed_a1e5;
export const NMS_META_MAGIC = 0xeeee_eebe;
export const NMS_BLOCK_SIZE = 0x80_000;
export const MAX_NMS_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_NMS_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

const META_LENGTHS = new Set([0x68, 0x168, 0x180, 0x1b0]);
const MAX_NMS_BLOCKS = 4096;
const MAX_JSON_DEPTH = 128;
const TEA_DELTA = 0x9e37_79b9;
const TEA_REVERSE_DELTA = 0x61c8_8647;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

function parseNmsJson(text) {
  return parseLossless(text, undefined, {
    parseNumber: (value) =>
      isSafeNumber(value) ? Number(value) : parseLosslessNumber(value),
  });
}

function u32(value) {
  return value >>> 0;
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    value >>> 0,
    true,
  );
}

function concatBytes(chunks, totalLength = null) {
  const length =
    totalLength ?? chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function decodeLatin1(bytes) {
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return chunks.join("");
}

function decodeNmsText(bytes) {
  try {
    return { text: textDecoder.decode(bytes), textEncoding: "utf-8" };
  } catch {
    return { text: decodeLatin1(bytes), textEncoding: "latin1" };
  }
}

function encodeLatin1Json(text) {
  let byteSafeText = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    byteSafeText += code <= 0xff
      ? text[index]
      : "\\u" + code.toString(16).padStart(4, "0");
  }
  const bytes = new Uint8Array(byteSafeText.length);
  for (let index = 0; index < byteSafeText.length; index += 1) {
    bytes[index] = byteSafeText.charCodeAt(index);
  }
  return bytes;
}

function encodeNmsText(text, textEncoding) {
  return textEncoding === "latin1" ? encodeLatin1Json(text) : textEncoder.encode(text);
}

function literalOnlyBlock(source) {
  const extraLengthBytes =
    source.length < 15 ? 0 : Math.floor((source.length - 15) / 255) + 1;
  const result = new Uint8Array(1 + extraLengthBytes + source.length);
  result[0] = Math.min(source.length, 15) << 4;
  let output = 1;
  if (source.length >= 15) {
    let remaining = source.length - 15;
    while (remaining >= 255) {
      result[output++] = 255;
      remaining -= 255;
    }
    result[output++] = remaining;
  }
  result.set(source, output);
  return result;
}

export function isNmsCompressed(bytes) {
  return bytes.length >= 4 && readU32(bytes, 0) === NMS_BLOCK_MAGIC;
}

export function decompressNms(bytes) {
  assertSupportedInputSize(bytes);
  const chunks = [];
  let totalLength = 0;
  let offset = 0;
  let blockCount = 0;

  while (offset < bytes.length) {
    blockCount += 1;
    if (blockCount > MAX_NMS_BLOCKS) {
      throw new Error("NMS save contains too many compressed blocks.");
    }
    if (bytes.length - offset < 16) {
      throw new Error(`Truncated NMS compression header at byte ${offset}.`);
    }
    const magic = readU32(bytes, offset);
    const compressedSize = readU32(bytes, offset + 4);
    const uncompressedSize = readU32(bytes, offset + 8);
    const padding = readU32(bytes, offset + 12);
    if (magic !== NMS_BLOCK_MAGIC || padding !== 0) {
      throw new Error(`Invalid NMS compression header at byte ${offset}.`);
    }
    const blockStart = offset + 16;
    if (compressedSize === 0 || compressedSize > bytes.length - blockStart) {
      throw new Error(`Truncated NMS compression block at byte ${offset}.`);
    }
    if (
      uncompressedSize === 0 ||
      uncompressedSize > MAX_NMS_DECOMPRESSED_BYTES - totalLength
    ) {
      throw new Error("NMS save exceeds the decompressed safety limit.");
    }
    const blockEnd = blockStart + compressedSize;

    const output = new Uint8Array(uncompressedSize);
    const decodedSize = lz4.decompressBlock(
      bytes,
      output,
      blockStart,
      compressedSize,
      0,
    );
    if (decodedSize !== uncompressedSize) {
      throw new Error(
        `LZ4 block decoded to ${decodedSize} bytes; expected ${uncompressedSize}.`,
      );
    }
    chunks.push(output);
    totalLength += output.length;
    offset = blockEnd;
  }

  return concatBytes(chunks, totalLength);
}

export function compressNms(rawBytes) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length > MAX_NMS_DECOMPRESSED_BYTES) {
    throw new Error("NMS save exceeds the compression safety limit.");
  }
  const chunks = [];
  let totalLength = 0;

  for (let offset = 0; offset < rawBytes.length; offset += NMS_BLOCK_SIZE) {
    const source = rawBytes.subarray(
      offset,
      Math.min(offset + NMS_BLOCK_SIZE, rawBytes.length),
    );
    const destination = new Uint8Array(lz4.compressBound(source.length));
    const hashTable = new Uint32Array(1 << 16);
    const compressedSize = lz4.compressBlock(
      source,
      destination,
      0,
      source.length,
      hashTable,
    );
    const payload =
      compressedSize > 0
        ? destination.slice(0, compressedSize)
        : literalOnlyBlock(source);
    const block = new Uint8Array(16 + payload.length);
    writeU32(block, 0, NMS_BLOCK_MAGIC);
    writeU32(block, 4, payload.length);
    writeU32(block, 8, source.length);
    writeU32(block, 12, 0);
    block.set(payload, 16);
    chunks.push(block);
    totalLength += block.length;
  }

  return concatBytes(chunks, totalLength);
}

function isJsonRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

function defineOwn(result, key, value) {
  Object.defineProperty(result, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function mappedKey(mapping, key) {
  return Object.hasOwn(mapping, key) ? mapping[key] : key;
}

function assertJsonDepth(depth) {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error("NMS save JSON exceeds the nesting safety limit.");
  }
}

function assertSafeRecord(value) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("NMS save JSON contains an unsafe object prototype.");
  }
}

function assertSupportedInputSize(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_NMS_INPUT_BYTES) {
    throw new Error("NMS save exceeds the input safety limit.");
  }
}

export function unmapKeys(value, mapping, depth = 0) {
  assertJsonDepth(depth);
  if (Array.isArray(value)) {
    return value.map((item) => unmapKeys(item, mapping, depth + 1));
  }
  if (isJsonRecord(value)) {
    assertSafeRecord(value);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      defineOwn(
        result,
        mappedKey(mapping, key),
        unmapKeys(item, mapping, depth + 1),
      );
    }
    return result;
  }
  return value;
}

export function reverseMap(mapping) {
  const result = {};
  for (const [obfuscated, readable] of Object.entries(mapping)) {
    defineOwn(result, readable, obfuscated);
  }
  return result;
}

export function mapKeys(value, mappingOrReverse, isReverse = false) {
  const mapping = isReverse ? mappingOrReverse : reverseMap(mappingOrReverse);

  function visit(item, depth = 0) {
    assertJsonDepth(depth);
    if (Array.isArray(item)) {
      return item.map((child) => visit(child, depth + 1));
    }
    if (isJsonRecord(item)) {
      assertSafeRecord(item);
      const result = {};
      for (const [key, child] of Object.entries(item)) {
        defineOwn(result, mappedKey(mapping, key), visit(child, depth + 1));
      }
      return result;
    }
    return item;
  }

  return visit(value);
}

export function cloneJson(value) {
  return unmapKeys(parseNmsJson(stringifyLossless(value)), {});
}

export function decodeJsonFile(bytes, mapping) {
  assertSupportedInputSize(bytes);
  const compressed = isNmsCompressed(bytes);
  const rawBytes = compressed ? decompressNms(bytes) : bytes;
  let end = rawBytes.length;
  while (end > 0 && rawBytes[end - 1] === 0) {
    end -= 1;
  }
  const { text, textEncoding } = decodeNmsText(rawBytes.subarray(0, end));
  const mappedValue = parseNmsJson(text);
  return {
    value: unmapKeys(mappedValue, mapping),
    mappedValue,
    compressed,
    decompressedLength: rawBytes.length,
    trailingNullBytes: rawBytes.length - end,
    textEncoding,
  };
}

export function decodeJsonFileForPreview(bytes, mapping) {
  assertSupportedInputSize(bytes);
  const compressed = isNmsCompressed(bytes);
  const rawBytes = compressed ? decompressNms(bytes) : bytes;
  let end = rawBytes.length;
  while (end > 0 && rawBytes[end - 1] === 0) {
    end -= 1;
  }
  const { text, textEncoding } = decodeNmsText(rawBytes.subarray(0, end));
  return {
    value: unmapKeys(parseNmsJson(text), mapping),
    compressed,
    decompressedLength: rawBytes.length,
    trailingNullBytes: rawBytes.length - end,
    textEncoding,
  };
}

export function encodeJsonFile(
  value,
  mapping,
  compressed,
  textEncoding = "utf-8",
  trailingNullBytes = compressed ? 1 : 0,
) {
  const mappedValue = mapKeys(value, mapping);
  const encodedText = encodeNmsText(stringifyLossless(mappedValue), textEncoding);
  const nullCount = Math.max(0, Number.isInteger(trailingNullBytes) ? trailingNullBytes : 0);
  if (encodedText.length > MAX_NMS_DECOMPRESSED_BYTES - nullCount) {
    throw new Error("NMS save exceeds the output safety limit.");
  }
  const rawBytes = new Uint8Array(encodedText.length + nullCount);
  rawBytes.set(encodedText);
  return {
    bytes: compressed ? compressNms(rawBytes) : rawBytes,
    compressed: Boolean(compressed),
    decompressedLength: rawBytes.length,
    mappedValue,
    trailingNullBytes: nullCount,
    textEncoding,
  };
}

export function deriveMetaKey(slot) {
  let value = u32(slot ^ 0x1422_cb8c);
  value = u32((value << 13) | (value >>> 19));
  value = u32(Math.imul(value, 5) + 0xe654_6b64);
  return [value, 0x4441_5645, 0x5259_414e, 0x4752_4e54];
}

export function decryptMetaWords(inputWords, slot, iterations = 6) {
  const data = Uint32Array.from(inputWords);
  const key = deriveMetaKey(slot);
  const last = data.length - 1;
  let hashValue = u32(Math.imul(TEA_DELTA, iterations));

  for (let round = 0; round < iterations; round += 1) {
    const keyIndex = (hashValue >>> 2) & 3;
    let current = data[0];
    for (let index = last; index > 0; index -= 1) {
      const previous = data[index - 1];
      const t1 = u32((current >>> 3) ^ (previous << 4));
      const t2 = u32(Math.imul(current, 4) ^ (previous >>> 5));
      const t3 = u32(previous ^ key[(index & 3) ^ keyIndex]);
      const t4 = u32(current ^ hashValue);
      const mixed = u32(u32(t1 + t2) ^ u32(t3 + t4));
      data[index] = u32(data[index] - mixed);
      current = data[index];
    }
    const previous = data[last];
    const t1 = u32((current >>> 3) ^ (previous << 4));
    const t2 = u32(Math.imul(current, 4) ^ (previous >>> 5));
    const t3 = u32(previous ^ key[keyIndex]);
    const t4 = u32(current ^ hashValue);
    const mixed = u32(u32(t1 + t2) ^ u32(t3 + t4));
    data[0] = u32(data[0] - mixed);
    hashValue = u32(hashValue + TEA_REVERSE_DELTA);
  }
  return data;
}

export function encryptMetaWords(inputWords, slot, iterations = 6) {
  const data = Uint32Array.from(inputWords);
  const key = deriveMetaKey(slot);
  const last = data.length - 1;
  let hashValue = 0;

  for (let round = 0; round < iterations; round += 1) {
    hashValue = u32(hashValue + TEA_DELTA);
    const keyIndex = (hashValue >>> 2) & 3;
    let nextValue = data[1];
    let previous = data[last];
    let t1 = u32((nextValue >>> 3) ^ (previous << 4));
    let t2 = u32(Math.imul(nextValue, 4) ^ (previous >>> 5));
    let t3 = u32(previous ^ key[keyIndex]);
    let t4 = u32(nextValue ^ hashValue);
    let mixed = u32(u32(t1 + t2) ^ u32(t3 + t4));
    data[0] = u32(data[0] + mixed);

    for (let index = 1; index <= last; index += 1) {
      nextValue = index === last ? data[0] : data[index + 1];
      previous = data[index - 1];
      t1 = u32((nextValue >>> 3) ^ (previous << 4));
      t2 = u32(Math.imul(nextValue, 4) ^ (previous >>> 5));
      t3 = u32(previous ^ key[(index & 3) ^ keyIndex]);
      t4 = u32(nextValue ^ hashValue);
      mixed = u32(u32(t1 + t2) ^ u32(t3 + t4));
      data[index] = u32(data[index] + mixed);
    }
  }
  return data;
}

function bytesToWords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = new Uint32Array(bytes.length / 4);
  for (let index = 0; index < words.length; index += 1) {
    words[index] = view.getUint32(index * 4, true);
  }
  return words;
}

function wordsToBytes(words) {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < words.length; index += 1) {
    view.setUint32(index * 4, words[index], true);
  }
  return bytes;
}

export function decodeMetadata(bytes, expectedSlot = null) {
  if (bytes.length % 4 !== 0 || !META_LENGTHS.has(bytes.length)) {
    throw new Error(`Unsupported NMS manifest length: ${bytes.length} bytes.`);
  }
  const encryptedWords = bytesToWords(bytes);
  const iterations = bytes.length === 0x68 ? 8 : 6;
  const candidates = [];
  if (expectedSlot !== null && expectedSlot !== undefined) {
    candidates.push(expectedSlot);
  }
  for (let slot = 0; slot < 32; slot += 1) {
    if (!candidates.includes(slot)) candidates.push(slot);
  }
  for (const slot of candidates) {
    const words = decryptMetaWords(encryptedWords, slot, iterations);
    if (words[0] === NMS_META_MAGIC) {
      return { slot, words, iterations, byteLength: bytes.length };
    }
  }
  throw new Error("Manifest did not decrypt with any supported NMS storage slot.");
}

export function encodeMetadata(words, slot, byteLength) {
  const iterations = byteLength === 0x68 ? 8 : 6;
  return wordsToBytes(encryptMetaWords(words, slot, iterations));
}

export function updateMetadata(meta, payloadBytes, decompressedLength, compressed) {
  const words = Uint32Array.from(meta.words);
  const format = words[1];
  const storedDecompressedLength = compressed
    ? decompressedLength
    : payloadBytes.length;

  words[14] = storedDecompressedLength;
  words[15] = compressed && format >= 2003 ? payloadBytes.length : 0;

  // Waypoint+ manifests repeat the decompressed length at offset 0x54.
  // Current-format saves require both copies; leaving this word stale can make
  // an otherwise valid save disagree with the game's slot metadata.
  if (format >= 2002 && words.length > 21) {
    words[21] = storedDecompressedLength;
  }

  // Worlds Part I+ stores an internal save timestamp and a copy of the
  // manifest format. Preserve every other opaque/game-owned word.
  if (format >= 2003 && words.length > 90) {
    words[89] = Math.floor(Date.now() / 1000);
    words[90] = format;
  }
  return {
    bytes: encodeMetadata(words, meta.slot, meta.byteLength),
    words,
    slot: meta.slot,
  };
}

export function validateMetadata(
  meta,
  payloadBytes,
  decompressedLength,
  compressed,
  { strict = false } = {},
) {
  const format = meta.words[1];
  const storedDecompressedLength = compressed
    ? decompressedLength
    : payloadBytes.length;
  const expectedCompressedLength = compressed && format >= 2003
    ? payloadBytes.length
    : 0;

  if (
    meta.words[14] !== storedDecompressedLength ||
    meta.words[15] !== expectedCompressedLength
  ) {
    return false;
  }

  // Older input saves may have a stale duplicate length even when the primary
  // fields are usable. Accept them for repair, but require every NMSA output to
  // carry the current game-compatible layout.
  if (
    strict &&
    format >= 2002 &&
    meta.words.length > 21 &&
    meta.words[21] !== storedDecompressedLength
  ) {
    return false;
  }
  if (
    strict &&
    format >= 2003 &&
    meta.words.length > 90 &&
    meta.words[90] !== format
  ) {
    return false;
  }
  return true;
}

export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
