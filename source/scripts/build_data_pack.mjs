import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import master from "../src/data/index.js";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destinationDirectory = path.join(project, "dist");
const payload = JSON.parse(JSON.stringify(master));
const canonical = JSON.stringify(stable(payload));
const payloadSha256 = createHash("sha256").update(canonical).digest("hex");
const packageFile = {
  packageSchema: 1,
  packageId: master.activePackage,
  publisher: "NMSA — No Man's Sky Atlas",
  createdAt: new Date(`${master.snapshotDate}T00:00:00.000Z`).toISOString(),
  payloadSha256,
  payload,
};

await mkdir(destinationDirectory, { recursive: true });
const destination = path.join(
  destinationDirectory,
  `NMSA-Data-${master.activePackage.replace(/^builtin-/, "")}.atlaspack.json`,
);
await writeFile(destination, `${JSON.stringify(packageFile)}\n`, "utf8");
console.log(`wrote ${destination}`);
