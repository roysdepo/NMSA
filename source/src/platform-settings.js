const REWARD_PROPERTY = "UnlockedPlatformRewards";
const utf8Encoder = new TextEncoder();

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function escapeXmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function attributesFromTag(source) {
  const attributes = {};
  const expression = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  for (const match of source.matchAll(expression)) {
    attributes[match[1]] = decodeXmlEntities(match[3]);
  }
  return attributes;
}

function propertyTags(text) {
  const tags = [];
  const expression = /<\s*\/?\s*Property\b[^>]*>/gi;
  for (const match of text.matchAll(expression)) {
    const source = match[0];
    const closing = /^<\s*\//.test(source);
    tags.push({
      source,
      start: match.index,
      end: match.index + source.length,
      closing,
      selfClosing: !closing && /\/\s*>$/.test(source),
      attributes: closing ? {} : attributesFromTag(source),
    });
  }
  return tags;
}

function normalizeRewardId(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  return trimmed.startsWith("^") ? trimmed : `^${trimmed}`;
}

function uniqueRewards(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = normalizeRewardId(value);
    if (!normalized) continue;
    const key = normalized.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

export function readPlatformRewards(text) {
  return uniqueRewards(
    propertyTags(text)
      .filter(
        (tag) =>
          !tag.closing &&
          tag.attributes.name === REWARD_PROPERTY &&
          typeof tag.attributes.value === "string",
      )
      .map((tag) => tag.attributes.value),
  );
}

function decodeUtf16(bytes, littleEndian) {
  const evenLength = bytes.length - (bytes.length % 2);
  let text = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < evenLength; offset += chunkSize * 2) {
    const end = Math.min(evenLength, offset + chunkSize * 2);
    const codes = [];
    for (let index = offset; index < end; index += 2) {
      codes.push(
        littleEndian
          ? bytes[index] | (bytes[index + 1] << 8)
          : (bytes[index] << 8) | bytes[index + 1],
      );
    }
    text += String.fromCharCode(...codes);
  }
  return text;
}

function encodeUtf16(text, littleEndian) {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[index * 2] = littleEndian ? code & 0xff : code >>> 8;
    bytes[index * 2 + 1] = littleEndian ? code >>> 8 : code & 0xff;
  }
  return bytes;
}

function concatBytes(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

export function decodePlatformSettings(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Platform settings must be provided as bytes.");
  }
  let encoding = "utf-8";
  let bom = new Uint8Array();
  let body = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = bytes.slice(0, 3);
    body = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    bom = bytes.slice(0, 2);
    body = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    bom = bytes.slice(0, 2);
    body = bytes.subarray(2);
  }

  const text = encoding === "utf-8"
    ? new TextDecoder("utf-8", { fatal: true }).decode(body)
    : decodeUtf16(body, encoding === "utf-16le");
  if (!/<\s*Data\b/i.test(text) || !/<\s*\/\s*Data\s*>/i.test(text)) {
    throw new Error("GCUSERSETTINGSDATA.MXML is not a supported NMS settings document.");
  }
  return {
    bytes,
    text,
    encoding,
    bom,
    rewards: readPlatformRewards(text),
  };
}

function lineIndentAt(text, index) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  return /^[\t ]*/.exec(text.slice(lineStart, index))?.[0] || "";
}

function containerRange(text) {
  const tags = propertyTags(text);
  for (let index = 0; index < tags.length; index += 1) {
    const opening = tags[index];
    if (
      opening.closing ||
      opening.attributes.name !== REWARD_PROPERTY ||
      typeof opening.attributes.value === "string"
    ) continue;
    if (opening.selfClosing) return { opening, closing: null };
    let depth = 1;
    for (let cursor = index + 1; cursor < tags.length; cursor += 1) {
      const tag = tags[cursor];
      if (tag.closing) depth -= 1;
      else if (!tag.selfClosing) depth += 1;
      if (depth === 0) return { opening, closing: tag };
    }
    throw new Error("UnlockedPlatformRewards has no closing Property element.");
  }
  return null;
}

function removeLegacyFlatEntries(text, range) {
  const removals = propertyTags(text).filter((tag) => {
    if (
      tag.closing ||
      tag.attributes.name !== REWARD_PROPERTY ||
      typeof tag.attributes.value !== "string"
    ) return false;
    if (!range) return true;
    const containerEnd = range.closing?.end ?? range.opening.end;
    return tag.start < range.opening.start || tag.end > containerEnd;
  });
  let output = text;
  for (const tag of removals.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, tag.start) + output.slice(tag.end);
  }
  return output;
}

function rewardLines(rewards, indent, newline) {
  return rewards
    .map((reward, index) => {
      const value = reward.startsWith("^") ? reward.slice(1) : reward;
      return `${indent}<Property name="${REWARD_PROPERTY}" value="${escapeXmlAttribute(value)}" _index="${index}" />`;
    })
    .join(newline);
}

function writePlatformRewards(text, rewards) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let output = removeLegacyFlatEntries(text, containerRange(text));
  const range = containerRange(output);

  if (range) {
    const parentIndent = lineIndentAt(output, range.opening.start);
    const childIndent = `${parentIndent}  `;
    const children = rewardLines(rewards, childIndent, newline);
    const inner = `${newline}${children}${newline}${parentIndent}`;
    if (range.closing) {
      return output.slice(0, range.opening.end) + inner + output.slice(range.closing.start);
    }
    const opening = range.opening.source.replace(/\/\s*>$/, ">");
    const replacement = `${opening}${inner}</Property>`;
    return output.slice(0, range.opening.start) + replacement + output.slice(range.opening.end);
  }

  const rootClose = /<\s*\/\s*Data\s*>/gi;
  let closing = null;
  for (const match of output.matchAll(rootClose)) closing = match;
  if (!closing) throw new Error("GCUSERSETTINGSDATA.MXML has no closing Data element.");
  const siblingMatch = /\r?\n([\t ]*)<Property\b/gi;
  let siblingIndent = "  ";
  for (const match of output.matchAll(siblingMatch)) siblingIndent = match[1];
  const childIndent = `${siblingIndent}  `;
  const block = [
    `${siblingIndent}<Property name="${REWARD_PROPERTY}">`,
    rewardLines(rewards, childIndent, newline),
    `${siblingIndent}</Property>`,
  ].join(newline);
  const before = output.slice(0, closing.index).replace(/[\t ]*$/, "");
  return `${before}${before.endsWith(newline) ? "" : newline}${block}${newline}${output.slice(closing.index)}`;
}

function encodeSettingsText(text, encoding, bom) {
  const body = encoding === "utf-8"
    ? utf8Encoder.encode(text)
    : encodeUtf16(text, encoding === "utf-16le");
  return bom?.length ? concatBytes(bom, body) : body;
}

export function completePlatformSettings(decoded, requiredRewards) {
  if (!decoded?.text || !decoded?.bytes) {
    throw new Error("PC platform settings were not loaded.");
  }
  const existing = uniqueRewards(decoded.rewards);
  const desired = [...existing];
  const known = new Set(existing.map((value) => value.toUpperCase()));
  const added = [];
  for (const reward of uniqueRewards(requiredRewards)) {
    const key = reward.toUpperCase();
    if (known.has(key)) continue;
    known.add(key);
    desired.push(reward);
    added.push(reward);
  }
  if (!added.length) {
    return { ...decoded, bytes: decoded.bytes.slice(), rewards: existing, added, changed: false };
  }

  const text = writePlatformRewards(decoded.text, desired);
  const bytes = encodeSettingsText(text, decoded.encoding, decoded.bom);
  const checked = decodePlatformSettings(bytes);
  const checkedSet = new Set(checked.rewards.map((value) => value.toUpperCase()));
  const missing = desired.filter((value) => !checkedSet.has(value.toUpperCase()));
  if (missing.length) {
    throw new Error(`Platform settings verification failed: ${missing.length} rewards are missing.`);
  }
  return { ...checked, added, changed: true };
}

export function verifyPlatformSettings(decoded, requiredRewards) {
  if (!decoded?.rewards) return false;
  const actual = new Set(decoded.rewards.map((value) => value.toUpperCase()));
  return uniqueRewards(requiredRewards).every((value) => actual.has(value.toUpperCase()));
}
