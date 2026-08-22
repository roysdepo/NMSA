const initialUrl = new URL(location.href);
const sessionCandidate = new URLSearchParams(initialUrl.hash.slice(1)).get("session")
  || initialUrl.searchParams.get("session");
const session = /^[a-f0-9]{64}$/i.test(sessionCandidate || "")
  ? sessionCandidate
  : null;
const isLegacyLoopback =
  location.protocol === "http:" &&
  (location.hostname === "127.0.0.1" || location.hostname === "localhost");

if (session) {
  initialUrl.searchParams.delete("session");
  initialUrl.hash = "";
  history.replaceState(null, "", `${initialUrl.pathname}${initialUrl.search}`);
}

function headers(extra = {}) {
  if (!session) return extra;
  return isLegacyLoopback
    ? { ...extra, "X-Atlas-Session": session }
    : { ...extra, "X-NMSA-Session": session };
}

async function request(path, options = {}) {
  if (!session) throw new Error("Native NMSA session is unavailable.");
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: headers(options.headers || {}),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }
    throw new Error(message);
  }
  return response;
}

export async function connectNativeBridge() {
  if (!session || location.protocol === "file:") return null;
  try {
    const status = await (await request("/api/status")).json();
    if (status.apiVersion !== 1) {
      console.warn("NMSA desktop host uses an unsupported API version.");
      return null;
    }
    return status;
  } catch {
    return null;
  }
}

export async function nativeDiscover() {
  return (await request("/api/discover")).json();
}

export async function nativeSelectFolder() {
  return (await request("/api/select-folder", { method: "POST" })).json();
}

export async function readNativeRecord(record) {
  const response = await request(`/api/file?token=${encodeURIComponent(record.token)}`);
  return new Uint8Array(await response.arrayBuffer());
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function nativeInstall(files, report) {
  const payload = {
    files: files.map((item) => ({
      token: item.token,
      role: item.role,
      sha256: item.sha256,
      bytesBase64: bytesToBase64(item.bytes),
    })),
    report,
  };
  return (
    await request("/api/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  ).json();
}

export async function nativeBackups() {
  return (await request("/api/backups")).json();
}

export async function nativeRollback(backupId) {
  return (
    await request("/api/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backupId }),
    })
  ).json();
}

export async function nativeRefreshStatus() {
  return (await request("/api/status")).json();
}

export function toNativeRecord(record) {
  return {
    ...record,
    name: record.name,
    size: Number(record.size || 0),
    lastModified: Number(record.lastModified || 0),
    relativePath: record.relativePath || record.name,
    adapter: record.adapter || record.platform || "steam",
    platform: record.platform || record.adapter || "steam",
    native: true,
  };
}
