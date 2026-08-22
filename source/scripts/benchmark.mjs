import { performance } from "node:perf_hooks";
import master from "../src/data/index.js";
import { completePreparedUnlocks } from "../src/completion.js";
import { decodeJsonFile, encodeJsonFile } from "../src/nms-codec.js";
import { applySaveTemplate } from "../src/save-templates.js";

if (typeof global.gc !== "function") {
  throw new Error("Run this benchmark with --expose-gc.");
}

function destinationSave() {
  const identity = {
    PTK: "ST",
    USN: "Benchmark",
    UID: "benchmark-uid",
    LID: "benchmark-local",
    TS: 1,
  };
  return {
    Version: master.testedGameVersion,
    ActiveContext: "Base",
    CommonStateData: { UsedDiscoveryOwnersV2: [identity] },
    BaseContext: {
      PlayerStateData: {
        PersistentPlayerBases: [{ Owner: identity }],
      },
      SpawnStateData: {},
    },
    ExpeditionContext: {
      PlayerStateData: { Marker: "inactive" },
      SpawnStateData: { Marker: "inactive" },
    },
    DiscoveryManagerData: {
      "DiscoveryData-v1": { Store: { Record: [] } },
    },
  };
}

function account() {
  return {
    UserSettingsData: {
      UnlockedSpecials: [],
      UnlockedSeasonRewards: [],
      UnlockedTwitchRewards: [],
      UnlockedPlatformRewards: [],
      UnlockedTitles: [],
      SeenWikiTopics: [],
      UnlockedWikiTopics: [],
      SeenSubstances: [],
      SeenTechnologies: [],
      SeenProducts: [],
    },
  };
}

function megabytes(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

function measure(label, operation) {
  global.gc();
  const startedHeap = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const value = operation();
  const milliseconds = performance.now() - startedAt;
  const heapAfterOperation = process.memoryUsage().heapUsed;
  global.gc();
  const retainedHeap = process.memoryUsage().heapUsed;
  return {
    value,
    result: {
      label,
      milliseconds: Number(milliseconds.toFixed(1)),
      heapAfterOperationMb: megabytes(heapAfterOperation),
      retainedHeapMb: megabytes(retainedHeap),
      retainedDeltaMb: megabytes(retainedHeap - startedHeap),
    },
  };
}

const results = [];
const applied = measure("apply God template", () =>
  applySaveTemplate(destinationSave(), "god", master, "active"),
);
results.push(applied.result);

const completed = measure("complete prepared God template", () =>
  completePreparedUnlocks(
    applied.value.save,
    account(),
    master,
    applied.value.definition.completionOptions,
    { enabled: false },
    "active",
  ),
);
results.push(completed.result);

const encoded = measure("encode completed save", () =>
  encodeJsonFile(completed.value.save, master.saveMap, true),
);
results.push({
  ...encoded.result,
  outputBytes: encoded.value.bytes.length,
});

const decoded = measure("decode completed save", () =>
  decodeJsonFile(encoded.value.bytes, master.saveMap),
);
results.push(decoded.result);

console.log(JSON.stringify({
  runtime: process.version,
  platform: `${process.platform}-${process.arch}`,
  results,
}, null, 2));
