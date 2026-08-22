import JSZip from "jszip";
import builtinMaster from "./data/index.js";
import {
  activateDataPackage,
  deactivateDataPackage,
  loadActiveDataPackage,
} from "./data-package.js";
import {
  accountEntitlements,
  analyzeCompletion,
  canonicalNmsName,
  completePreparedUnlocks,
  completeUnlocks,
  expectedSlotFromSaveName,
  verifyCompletion,
} from "./completion.js";
import {
  buildChangePreview,
  completionOptionsChangeAccount,
  completionOptionsRequirePlatformSettings,
} from "./change-preview.js";
import { contextSummary, resolveSaveContext } from "./context-resolver.js";
import {
  assertWritableCompatibility,
  inspectCompatibility,
  platformLabel,
} from "./compatibility.js";
import {
  bytesEqual,
  decodeMetadata,
  sha256Hex,
  updateMetadata,
  validateMetadata,
} from "./nms-codec.js";
import {
  adapterForRecord,
  decodeAdapterFile,
  decodePortableManifest,
  discoverPortableFileSets,
  encodeAdapterFile,
  looksLikePortableEntries,
  updatePortableManifest,
  updateXboxMeta,
  validatePortableManifest,
  validateXboxMeta,
} from "./platform-adapters.js";
import {
  completePlatformSettings,
  decodePlatformSettings,
  verifyPlatformSettings,
} from "./platform-settings.js";
import {
  choosePreferredSaveSets,
  discoverSaveFileSets,
} from "./save-discovery.js";
import {
  assertCompletionReloaded,
  findMatchingSaveSet,
  prepareTargetedReload,
  saveSetIdentity,
} from "./post-install.js";
import {
  connectNativeBridge,
  nativeBackups,
  nativeDiscover,
  nativeInstall,
  nativeRefreshStatus,
  nativeRollback,
  nativeSelectFolder,
  readNativeRecord,
  toNativeRecord,
} from "./native-bridge.js";
import { addHistory, createSafeDiagnostic, loadHistory } from "./history.js";
import { createOperationController, setRegionEnabled } from "./ui-state.js";
import {
  SAVE_TEMPLATE_DEFINITIONS,
  applySaveTemplate,
  getSaveTemplateDefinition,
  templateVerificationJson,
} from "./save-templates.js";

const MAX_DATA_PACKAGE_BYTES = 8 * 1024 * 1024;

const elements = Object.fromEntries(
  [
    "environmentBadge", "gameBadge", "browseButton", "otherFolderButton",
    "portableButton", "folderInput", "folderStatus",
    "sourceWarnings", "saveList", "loadButton", "sourceTitle",
    "sourceDescription", "baselineTitle", "baselineDetails", "baselineCounts",
    "dataSourceBadge", "importDataButton", "resetDataButton", "dataPackageInput",
    "dataPackageStatus", "analysisPanel", "analysisSummary", "verifiedBadge",
    "healthRing", "healthScore", "healthGrade", "healthDetail", "contextSelect",
    "contextDetail", "compatibilityCard", "compatibilityStatus",
    "compatibilityDetail", "compatibilityGrid", "auditCards", "ownershipAudit",
    "optionsPanel", "presetSelect", "previewTotal", "previewRows",
    "ownershipEnabled", "ownershipFields", "addAliasButton", "aliasRows", "aliasRowTemplate",
    "writeBlocker", "outputHeading", "outputDescription", "diagnosticButton",
    "completeButton", "installButton", "recoveryPanel", "refreshRecoveryButton",
    "backupList", "historyList", "resultPanel", "resultTitle", "resultSummary",
    "templatePanel", "templateChoices", "templateImpact", "templateTargetName",
    "templateConfirm", "templateWriteBlocker", "templateDownloadButton",
    "templateInstallButton",
    "activityPopup", "activityText", "activityProgress", "activityProgressFill",
    "toast",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

let master = builtinMaster;
const state = {
  dataSource: "built-in",
  native: null,
  saveSlots: [],
  selectedSaveId: null,
  loaded: null,
  contextPreference: "active",
  selectedTemplateId: "god",
  lastOutput: null,
};

let activityDepth = 0;
let toastTimer = null;
const operationController = createOperationController({
  root: document.querySelector("main"),
});

function updateActivity(message, progress = null) {
  elements.activityText.textContent = message;
  elements.activityProgress.setAttribute("aria-valuetext", message);
  const numericProgress = Number(progress);
  const determinate =
    progress !== null &&
    progress !== undefined &&
    Number.isFinite(numericProgress);
  elements.activityPopup.classList.toggle("determinate", determinate);
  if (determinate) {
    const bounded = Math.max(0, Math.min(100, numericProgress));
    elements.activityProgress.setAttribute("aria-valuemin", "0");
    elements.activityProgress.setAttribute("aria-valuemax", "100");
    elements.activityProgress.setAttribute("aria-valuenow", String(Math.round(bounded)));
    elements.activityProgressFill.style.transform = `scaleX(${bounded / 100})`;
  } else {
    elements.activityProgress.removeAttribute("aria-valuemin");
    elements.activityProgress.removeAttribute("aria-valuemax");
    elements.activityProgress.removeAttribute("aria-valuenow");
    elements.activityProgressFill.style.removeProperty("transform");
  }
}

function setActivity(active, message = "Working…", progress = null) {
  if (active) {
    activityDepth += 1;
    updateActivity(message, progress);
  } else {
    activityDepth = Math.max(0, activityDepth - 1);
  }
  const visible = activityDepth > 0;
  elements.activityPopup.classList.toggle("hidden", !visible);
  document.body.setAttribute("aria-busy", visible ? "true" : "false");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function showError(error) {
  console.error(error);
  elements.toast.textContent = errorMessage(error);
  elements.toast.classList.remove("hidden");
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.add("hidden");
    toastTimer = null;
  }, 9000);
}

function runUiOperation(label, operation) {
  return operationController.run(label, async () => {
    setActivity(true, label);
    try {
      return await operation();
    } finally {
      setActivity(false);
    }
  }).catch(showError);
}

function clearLoaded() {
  state.loaded = null;
  state.lastOutput = null;
  elements.analysisPanel.classList.add("hidden");
  elements.optionsPanel.classList.add("hidden");
  elements.templatePanel.classList.add("hidden");
  elements.templateConfirm.checked = false;
  elements.resultPanel.classList.add("hidden");
}

function formatPlayTime(seconds) {
  const totalMinutes = Math.max(0, Math.floor(Number(seconds || 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours.toLocaleString()}h ${minutes}m` : `${minutes}m`;
}

function formatModified(timestamp) {
  if (!timestamp) return "Date unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return "Date unavailable";
  }
}

function formatDateTime(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return String(timestamp || "Unknown time");
  }
}

function saveDetails(value, logicalSlot) {
  const common = value?.CommonStateData ?? {};
  let context = null;
  try {
    context = resolveSaveContext(value, "active");
  } catch {
    // Preview can still show the save name when the player context is malformed.
  }
  const player = context?.playerState ?? {};
  const rawName = typeof common.SaveName === "string" ? common.SaveName.trim() : "";
  const rawSummary = typeof player.SaveSummary === "string" ? player.SaveSummary.trim() : "";
  return {
    name: rawName || `Save slot ${logicalSlot}`,
    summary: rawSummary || "No location summary",
    mode:
      player.DifficultyState?.Preset?.DifficultyPresetType ||
      common.SeasonData?.GameMode?.PresetGameMode ||
      "Unknown mode",
    totalPlayTime: Number(common.TotalPlayTime || 0),
    context,
  };
}

async function hydrateRecord(record) {
  if (!record) return null;
  if (!record.bytes) {
    if (record.native && record.token) {
      record.bytes = await readNativeRecord(record);
    } else if (record.file?.arrayBuffer) {
      record.bytes = new Uint8Array(await record.file.arrayBuffer());
    } else {
      throw new Error(`Cannot read ${record.name || "save file"}.`);
    }
  }
  record.size = Number(record.size || record.bytes.length);
  return record;
}

function stampAdapter(set, adapter) {
  set.adapter = adapter;
  set.platform = adapter;
  for (const key of ["save", "saveMeta", "account", "accountMeta", "platformSettings"]) {
    if (set[key]) {
      set[key].adapter = adapter;
      set[key].platform = adapter;
    }
  }
  return set;
}

function platformForPcSet(set) {
  const fromRecord = set.save?.platform || set.save?.adapter;
  if (fromRecord === "gog" || fromRecord === "steam") return fromRecord;
  return String(set.profileName || "").toLowerCase() === "defaultuser" ? "gog" : "steam";
}

async function decodeSet(set) {
  const bundle = {
    save: await hydrateRecord(set.save),
    saveMeta: await hydrateRecord(set.saveMeta),
    account: await hydrateRecord(set.account),
    accountMeta: await hydrateRecord(set.accountMeta),
    platformSettings: await hydrateRecord(set.platformSettings),
  };
  if (!bundle.save || !bundle.account) throw new Error("Save or account data is missing.");

  const adapter = set.adapter || adapterForRecord(bundle.save);
  const accountManifestRequired = adapter !== "steam" && adapter !== "gog";
  const save = decodeAdapterFile(bundle.save, master.saveMap, bundle.saveMeta, "save");
  const account = decodeAdapterFile(bundle.account, master.accountMap, bundle.accountMeta, "account");
  save.adapter = adapter;
  account.adapter = adapter;

  let saveMeta = null;
  let accountMeta = null;
  let manifestFormat = null;
  let accountManifestFormat = null;
  let saveManifestValid = false;
  let accountManifestValid =
    !accountManifestRequired || (adapter === "switch-extracted" && !bundle.accountMeta);
  const validationErrors = [];
  const platformSettingsRequired = adapter === "steam" || adapter === "gog";
  let platformSettings = null;
  let platformSettingsValid = !platformSettingsRequired;

  if (platformSettingsRequired && bundle.platformSettings) {
    try {
      platformSettings = decodePlatformSettings(bundle.platformSettings.bytes);
      platformSettingsValid = true;
    } catch (error) {
      validationErrors.push(`PC platform settings: ${errorMessage(error)}`);
    }
  }

  if (adapter === "steam" || adapter === "gog") {
    try {
      saveMeta = decodeMetadata(bundle.saveMeta.bytes, expectedSlotFromSaveName(bundle.save.name));
      manifestFormat = saveMeta.words[1];
      saveManifestValid = validateMetadata(
        saveMeta,
        bundle.save.bytes,
        save.decompressedLength,
        save.compressed,
      );
      if (!saveManifestValid) validationErrors.push("Save manifest does not match save data.");
    } catch (error) {
      validationErrors.push(`Save manifest: ${errorMessage(error)}`);
    }
  } else if (adapter === "playstation-extracted" || adapter === "switch-extracted") {
    try {
      saveMeta = decodePortableManifest(bundle.saveMeta.bytes, set.portableManifestIndex);
      manifestFormat = saveMeta.format;
      saveManifestValid = validatePortableManifest(saveMeta, save);
      if (!saveManifestValid) validationErrors.push("Portable save manifest length does not match.");
    } catch (error) {
      validationErrors.push(`Portable save manifest: ${errorMessage(error)}`);
    }
    if (bundle.accountMeta) {
      try {
        accountMeta = decodePortableManifest(bundle.accountMeta.bytes, 0);
        accountManifestFormat = accountMeta.format;
        accountManifestValid = validatePortableManifest(accountMeta, account);
        if (!accountManifestValid) validationErrors.push("Portable account manifest length does not match.");
      } catch (error) {
        validationErrors.push(`Portable account manifest: ${errorMessage(error)}`);
      }
    }
  } else if (adapter === "xbox-game-pass") {
    saveManifestValid = validateXboxMeta(bundle.saveMeta, save, "save");
    accountManifestValid = validateXboxMeta(bundle.accountMeta, account, "account");
    if (!saveManifestValid) validationErrors.push("Xbox save metadata is missing or invalid.");
    if (!accountManifestValid) validationErrors.push("Xbox account metadata length does not match.");
  } else {
    validationErrors.push("Unknown platform adapter.");
  }

  const compatibility = inspectCompatibility({
    save: save.value,
    account: account.value,
    manifestFormat,
    accountManifestFormat,
    platform: adapter,
    manifestValid: saveManifestValid,
    accountManifestValid,
    master,
  });
  const context = resolveSaveContext(save.value, "active");
  return {
    adapter,
    bundle,
    save,
    account,
    saveMeta,
    accountMeta,
    platformSettings,
    compatibility,
    context,
    validation: {
      saveDecoded: true,
      accountDecoded: true,
      saveManifestValid,
      accountManifestValid,
      accountManifestRequired,
      platformSettingsRequired,
      platformSettingsFound: Boolean(bundle.platformSettings),
      platformSettingsValid,
      errors: validationErrors,
    },
  };
}

async function inspectSaveSet(set) {
  const inspected = {
    ...set,
    details: saveDetails(null, set.logicalSlot),
    ready: false,
    writeAllowed: false,
    analysisOnly: false,
    error: null,
  };
  if (!set.complete) {
    inspected.error = `Missing ${set.missing.join(", ")}`;
    return inspected;
  }
  try {
    const decoded = await decodeSet(set);
    inspected._inspection = decoded;
    inspected.details = saveDetails(decoded.save.value, set.logicalSlot);
    inspected.ready = decoded.compatibility.analysisAllowed;
    inspected.writeAllowed = decoded.compatibility.writeAllowed;
    inspected.analysisOnly = inspected.ready && !inspected.writeAllowed;
    if (inspected.analysisOnly) {
      inspected.error = decoded.compatibility.reasons.join(" ");
    }
  } catch (error) {
    inspected.error = errorMessage(error);
  }
  return inspected;
}

function renderSaveSlots() {
  elements.saveList.replaceChildren();
  if (!state.saveSlots.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "save-placeholder";
    placeholder.textContent = "No save profiles scanned yet.";
    elements.saveList.append(placeholder);
    elements.loadButton.disabled = true;
    return;
  }

  const multipleProfiles = new Set(state.saveSlots.map((slot) => slot.directory)).size > 1;
  for (const slot of state.saveSlots) {
    const status = !slot.ready ? "unavailable" : slot.writeAllowed ? "ready" : "analysis-only";
    const label = document.createElement("label");
    label.className = `save-card ${status}`;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "saveSlot";
    radio.value = slot.id;
    radio.disabled = !slot.ready;
    radio.checked = slot.id === state.selectedSaveId;
    radio.addEventListener("change", () => {
      state.selectedSaveId = slot.id;
      clearLoaded();
      elements.loadButton.disabled = false;
    });

    const body = document.createElement("span");
    body.className = "save-card-body";
    const top = document.createElement("span");
    top.className = "save-card-top";
    const title = document.createElement("strong");
    title.textContent = slot.details.name;
    const badge = document.createElement("span");
    badge.className = `save-status ${status}`;
    badge.textContent = status === "ready" ? "Ready" : status === "analysis-only" ? "Analysis only" : "Cannot load";
    top.append(title, badge);

    const meta = document.createElement("span");
    meta.className = "save-meta";
    const profile = multipleProfiles ? ` · ${slot.profileName}` : "";
    const context = slot.details.context ? ` · ${contextSummary(slot.details.context)}` : "";
    const savePoint = slot.savePointLabel ? ` · ${slot.savePointLabel}` : "";
    meta.textContent = `${platformLabel(slot.platform)} · Slot ${slot.logicalSlot}${savePoint} · ${slot.details.mode} · ${formatPlayTime(slot.details.totalPlayTime)}${context}${profile}`;
    const summary = document.createElement("span");
    summary.className = "save-summary";
    summary.textContent = slot.details.summary;
    const source = document.createElement("span");
    source.className = "save-source";
    const dataName = slot.save.originalName || slot.save.name;
    const metadataName = slot.saveMeta?.originalName || slot.saveMeta?.name;
    source.textContent = metadataName
      ? `${dataName} + ${metadataName} · ${formatModified(slot.save.lastModified)}`
      : `${dataName} · ${formatModified(slot.save.lastModified)}`;
    body.append(top, meta, summary, source);
    if (slot.error) {
      const error = document.createElement("span");
      error.className = "save-error";
      error.textContent = slot.error;
      body.append(error);
    }
    label.append(radio, body);
    elements.saveList.append(label);
  }
  elements.loadButton.disabled = !state.selectedSaveId;
}

function discoveredFromEntries(entries) {
  const discovered = discoverSaveFileSets(entries).map((set) =>
    stampAdapter(set, platformForPcSet(set)),
  );
  if (looksLikePortableEntries(entries)) {
    discovered.push(...discoverPortableFileSets(entries));
  }
  return discovered;
}

async function scanDiscoveredSets(discovered, label, warnings = []) {
  clearLoaded();
  state.saveSlots = [];
  state.selectedSaveId = null;
  elements.folderStatus.textContent = `${label}: scanning…`;
  renderSaveSlots();
  renderWarnings(warnings);
  setActivity(true, "Checking your saves…", discovered.length ? 4 : null);
  try {
    const inspected = [];
    for (let index = 0; index < discovered.length; index += 1) {
      inspected.push(await inspectSaveSet(discovered[index]));
      updateActivity(
        "Checking your saves…",
        4 + ((index + 1) / discovered.length) * 92,
      );
    }
    state.saveSlots = choosePreferredSaveSets(inspected);
    const analyzable = state.saveSlots.filter((slot) => slot.ready).length;
    const writable = state.saveSlots.filter((slot) => slot.writeAllowed).length;
    elements.folderStatus.textContent = state.saveSlots.length
      ? `${label}: ${state.saveSlots.length} physical save point${state.saveSlots.length === 1 ? "" : "s"}; ${analyzable} analyzable, ${writable} verified for writing.`
      : `${label}: no supported save points found.`;
    renderSaveSlots();
    if (!state.saveSlots.length) {
      throw new Error("No complete No Man’s Sky save points were found in that location.");
    }
    updateActivity("Your saves are ready.", 100);
  } finally {
    setActivity(false);
  }
}

async function scanEntries(entries, label, warnings = []) {
  await scanDiscoveredSets(discoveredFromEntries(entries), label, warnings);
}

function normalizeXboxSet(set) {
  const normalized = {
    ...set,
    adapter: "xbox-game-pass",
    platform: "xbox-game-pass",
  };
  for (const key of ["save", "saveMeta", "account", "accountMeta"]) {
    if (set[key]) normalized[key] = toNativeRecord(set[key]);
  }
  return normalized;
}

async function scanNativeResponse(response, label = "Installed saves") {
  state.native = { ...state.native, ...response.status };
  renderEnvironment();
  const entries = (response.files || []).map(toNativeRecord);
  const discovered = discoveredFromEntries(entries);
  discovered.push(...(response.xboxSets || []).map(normalizeXboxSet));
  await scanDiscoveredSets(discovered, label, response.warnings || []);
}

function renderWarnings(warnings) {
  elements.sourceWarnings.replaceChildren();
  elements.sourceWarnings.classList.toggle("hidden", !warnings.length);
  for (const warning of warnings) {
    const line = document.createElement("p");
    line.textContent = warning;
    elements.sourceWarnings.append(line);
  }
}

async function findInstalledSaves() {
  if (state.native) {
    setActivity(true, "Finding installed No Man’s Sky profiles…");
    try {
      await scanNativeResponse(await nativeDiscover());
      await refreshRecovery();
    } finally {
      setActivity(false);
    }
    return;
  }
  await chooseBrowserFolder();
}

async function chooseOtherFolder() {
  if (state.native) {
    const response = await nativeSelectFolder();
    if (!response.cancelled) await scanNativeResponse(response, response.label || "Selected folder");
    return;
  }
  await chooseBrowserFolder();
}

async function collectDirectoryEntries(rootHandle) {
  const output = [];
  async function walk(directoryHandle, prefix, depth) {
    if (depth > 6) return;
    for await (const [name, handle] of directoryHandle.entries()) {
      const relativePath = `${prefix}/${name}`;
      if (handle.kind === "directory") await walk(handle, relativePath, depth + 1);
      else output.push({ file: await handle.getFile(), relativePath, name });
    }
  }
  await walk(rootHandle, rootHandle.name, 0);
  return output;
}

async function chooseBrowserFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    elements.folderInput.click();
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: "atlas-nms-save-folder", mode: "read" });
    await scanEntries(await collectDirectoryEntries(handle), handle.name);
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  }
}

function selectedOptions() {
  return {
    rewards: document.querySelector("#optionRewards").checked,
    // Platform/store entitlements are ownership-scoped and are never granted by
    // a normal completion operation. A future, platform-aware UI may expose an
    // explicit opt-in after ownership can be verified.
    licensedEntitlements: false,
    blueprints: document.querySelector("#optionBlueprints").checked,
    languageAndSlots: document.querySelector("#optionLanguage").checked,
    catalogue: document.querySelector("#optionCatalogue").checked,
    naturalProgression: document.querySelector("#optionMilestones").checked,
    repairIntegrity: document.querySelector("#optionRepair").checked,
    progressionConveniences: document.querySelector("#optionProgression").checked,
  };
}

function readIdentity(row) {
  return Object.fromEntries(
    ["PTK", "USN", "UID", "LID"].map((field) => [
      field,
      row.querySelector(`[data-field="${field}"]`)?.value?.trim() ?? "",
    ]),
  );
}

function selectedOwnership() {
  if (!elements.ownershipEnabled.checked) return { enabled: false };
  return {
    enabled: true,
    primary: readIdentity(document.querySelector(".primary-identity")),
    aliases: [...document.querySelectorAll(".alias-row")]
      .map(readIdentity)
      .filter((identity) => Object.values(identity).some(Boolean)),
    normalizeBases: document.querySelector("#normalizeBases").checked,
    normalizeMatchingDiscoveries: document.querySelector("#normalizeDiscoveries").checked,
    clearBaseEditorLabels: document.querySelector("#clearEditorLabels").checked,
  };
}

function addAliasRow(values = {}) {
  const row = elements.aliasRowTemplate.content.firstElementChild.cloneNode(true);
  for (const field of ["PTK", "USN", "UID", "LID"]) {
    if (values[field]) row.querySelector(`[data-field="${field}"]`).value = values[field];
  }
  row.querySelector(".remove-alias").addEventListener("click", () => {
    row.remove();
    renderPreview();
  });
  elements.aliasRows.append(row);
}

async function loadSelectedSave() {
  const slot = state.saveSlots.find((item) => item.id === state.selectedSaveId);
  if (!slot?.ready) throw new Error("Select an analyzable save first.");
  setActivity(true, "Loading the selected save…");
  try {
    const inspection = slot._inspection ?? (await decodeSet(slot));
    state.contextPreference = inspection.context.type;
    state.loaded = {
      ...inspection,
      selectedSlot: slot,
    };
    refreshLoadedAnalysis();
    elements.analysisPanel.classList.remove("hidden");
    elements.optionsPanel.classList.remove("hidden");
    elements.templatePanel.classList.remove("hidden");
    elements.templateConfirm.checked = false;
    renderTemplateControls();
    elements.resultPanel.classList.add("hidden");
    elements.analysisPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    setActivity(false);
  }
}

function refreshLoadedAnalysis() {
  if (!state.loaded) return;
  const context = resolveSaveContext(state.loaded.save.value, state.contextPreference);
  state.loaded.context = context;
  state.loaded.analysis = applyPlatformSettingsAnalysis(analyzeCompletion(
    state.loaded.save.value,
    state.loaded.account.value,
    master,
    state.contextPreference,
  ), state.loaded.account.value, state.loaded.platformSettings, state.loaded.adapter);
  renderAnalysis();
}

function applyPlatformSettingsAnalysis(analysis, account, platformSettings, adapter) {
  const pcSettings = adapter === "steam" || adapter === "gog";
  const accountRewards = new Set(
    (account?.UserSettingsData?.UnlockedPlatformRewards || []).map((value) =>
      String(value).toUpperCase(),
    ),
  );
  const settingsRewards = new Set(
    (pcSettings ? platformSettings?.rewards || [] : []).map((value) =>
      String(value).toUpperCase()
    ),
  );
  const entitlements = accountEntitlements(master);
  const accountPresent = entitlements.filter((value) =>
    accountRewards.has(value.toUpperCase())
  );
  const settingsPresent = entitlements.filter((value) =>
    settingsRewards.has(value.toUpperCase())
  );
  analysis.contextual ??= {};
  analysis.contextual.licensedEntitlements = {
    tracked: entitlements.length,
    accountPresent: accountPresent.length,
    settingsPresent: settingsPresent.length,
    informational: true,
  };
  analysis.platformSettings = {
    required: false,
    detected: pcSettings && Boolean(platformSettings),
    informational: true,
    tracked: entitlements.length,
    accountPresent: accountPresent.length,
    settingsPresent: settingsPresent.length,
  };
  return analysis;
}

function sum(...values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function renderContextSelector(context) {
  elements.contextSelect.replaceChildren();
  for (const available of context.available) {
    const option = document.createElement("option");
    option.value = available.type;
    option.textContent = available.label;
    option.selected = available.type === context.type;
    elements.contextSelect.append(option);
  }
  elements.contextSelect.disabled = context.available.length < 2;
  elements.contextDetail.textContent = context.type === "expedition"
    ? `ActiveContext=${context.activeTag}${context.seasonNumber ? ` · Expedition ${context.seasonNumber}` : ""}`
    : `ActiveContext=${context.activeTag} · expedition data is left untouched`;
}

function renderAnalysis() {
  const { analysis, compatibility, context, selectedSlot, validation } = state.loaded;
  const missing = analysis.missing;
  const contextual = analysis.contextual || {};
  elements.analysisSummary.textContent = analysis.totalMissing
    ? `${selectedSlot.details.name}: ${analysis.totalMissing.toLocaleString()} safe core entries are pending across the ${context.label.toLowerCase()} and its account settings.`
    : `${selectedSlot.details.name}: the ${context.label.toLowerCase()} and account settings cover the safe core completion baseline.`;

  const score = analysis.health.score;
  elements.healthScore.textContent = `${score.toFixed(score % 1 ? 1 : 0)}%`;
  elements.healthGrade.textContent = analysis.health.grade;
  elements.healthDetail.textContent = `${analysis.health.completedEntries.toLocaleString()} of ${analysis.health.targetEntries.toLocaleString()} safe core entries`;
  elements.healthRing.style.setProperty("--health", `${score * 3.6}deg`);
  renderContextSelector(context);

  elements.compatibilityCard.className = `compatibility-card ${compatibility.status}`;
  elements.compatibilityStatus.textContent = compatibility.writeAllowed ? "Verified for writing" : "Analysis only";
  elements.compatibilityDetail.textContent = compatibility.writeAllowed
    ? `${compatibility.platformLabel} · format ${compatibility.saveFormat} · ${compatibility.mappingVersion}`
    : compatibility.reasons[0] || "Writing is not verified.";
  elements.verifiedBadge.className = `verified-badge ${compatibility.writeAllowed ? "" : "analysis-only"}`.trim();
  elements.verifiedBadge.textContent = compatibility.writeAllowed
    ? "Verified save + metadata"
    : "Analysis only";

  const groups = [
    ["Rewards & titles", sum(
      missing.knownSpecials,
      missing.accountSpecials,
      missing.seasonRewards,
      missing.twitchRewards,
      missing.redeemedSeasonRewards,
      missing.redeemedTwitchRewards,
      missing.redeemedPlatformRewards,
      missing.titles,
    )],
    ["Products & tech", sum(
      missing.knownProducts,
      missing.knownTechnologies,
      missing.disallowedKnownTechnologies,
      missing.refinerRecipes,
    )],
    ["Language groups", sum(
      missing.wordGroups,
      missing.wordGroupsExpanded,
      missing.portalRunes,
      missing.petSlots,
      missing.squadronSlots,
    )],
    ["Catalogue & records", sum(
      missing.wikiTopics,
      missing.seenWikiTopics,
      missing.seenSubstances,
      state.loaded.analysis.projections.catalogue.both.seenKnownProducts,
      state.loaded.analysis.projections.catalogue.both.seenKnownTechnologies,
      state.loaded.analysis.projections.catalogue.both.productRecords,
      missing.fishingRecords,
      missing.baseBuildingRecords,
      missing.storyRecords,
      missing.anomalousBasePartRecords,
    )],
    ["Natural milestones", contextual.naturalProgression, "optional"],
    ["Integrity issues", analysis.integrity.structuralIssues],
    ["Conveniences", analysis.conveniencesMissing],
  ];
  elements.auditCards.replaceChildren();
  for (const [label, count, kind = "core"] of groups) {
    const card = document.createElement("div");
    card.className = `audit-card ${kind === "optional" ? "optional" : count ? "missing" : "complete"}`;
    const heading = document.createElement("span");
    heading.textContent = label;
    const value = document.createElement("strong");
    value.textContent = kind === "optional"
      ? count
        ? `${Number(count).toLocaleString()} optional`
        : "No optional targets"
      : count
        ? `${Number(count).toLocaleString()} pending`
        : "Complete";
    card.append(heading, value);
    elements.auditCards.append(card);
  }

  const detailItems = [
    ["Platform", compatibility.platformLabel],
    ["Codec", compatibility.codec],
    ["Save format", compatibility.saveFormat ?? "Unknown"],
    ["Game save version", compatibility.gameVersion || "Unknown"],
    ["Mapping", compatibility.mappingVersion],
    ["Data package", compatibility.dataPackage],
    ["Save metadata", validation.saveManifestValid ? "Verified" : "Not verified"],
    [
      "Account metadata",
      validation.accountManifestRequired
        ? (validation.accountManifestValid ? "Verified" : "Not verified")
        : "Not required on PC",
    ],
    [
      "Licensed/platform entitlements",
      validation.platformSettingsRequired
        ? validation.platformSettingsValid
          ? `${analysis.platformSettings?.settingsPresent || 0} settings flags detected · informational only`
          : validation.platformSettingsFound
            ? "Found but invalid"
            : "Not found"
        : "Platform-managed · not changed by completion",
    ],
    ["Player context", contextSummary(context)],
    [
      "Context-specific products",
      `${Number(contextual.knownProducts || 0).toLocaleString()} excluded from core completion`,
    ],
    [
      "Internal catalogue history",
      `${Number(contextual.internalSeenTechnologies || 0).toLocaleString()} records preserved`,
    ],
    [
      "Speculative ship identifiers",
      `${Number(contextual.speculativeShipComponentRecords || 0).toLocaleString()} excluded from core completion`,
    ],
  ];
  elements.compatibilityGrid.replaceChildren();
  for (const [label, value] of detailItems) {
    const item = document.createElement("div");
    item.className = "detail-item";
    const key = document.createElement("span");
    const data = document.createElement("strong");
    key.textContent = label;
    data.textContent = String(value);
    item.append(key, data);
    elements.compatibilityGrid.append(item);
  }
  renderOwnershipAudit(analysis.ownership);
  renderWriteControls();
  renderTemplateControls();
  renderPreview();
}

function ownerText(owner) {
  return `${owner.USN || "(blank username)"} · ${owner.PTK || "?"} · UID ${owner.UID || "?"} · ${owner.count}`;
}

function renderOwnershipAudit(audit) {
  elements.ownershipAudit.replaceChildren();
  const sections = [
    ["Persistent base owners", audit.baseOwners],
    ["Discovery record owners", audit.discoveryOwners],
    ["Registered identities", audit.registeredOwners],
  ];
  for (const [heading, owners] of sections) {
    const section = document.createElement("div");
    section.className = "owner-list";
    const title = document.createElement("h3");
    title.textContent = heading;
    section.append(title);
    if (!owners.length) {
      const empty = document.createElement("p");
      empty.textContent = "No records";
      section.append(empty);
    } else {
      for (const owner of owners.slice(0, 12)) {
        const line = document.createElement("p");
        line.textContent = ownerText(owner);
        section.append(line);
      }
      if (owners.length > 12) {
        const more = document.createElement("p");
        more.textContent = `+ ${owners.length - 12} additional cached owners`;
        section.append(more);
      }
    }
    elements.ownershipAudit.append(section);
  }
}

function renderWriteControls() {
  const compatibility = state.loaded.compatibility;
  const pcContentEntitlements =
    ["steam", "gog"].includes(state.loaded.adapter) &&
    selectedOptions().licensedEntitlements;
  const requiredKeys = ["steam", "gog", "switch-extracted"].includes(state.loaded.adapter)
    ? ["save", "saveMeta", "account"]
    : ["save", "saveMeta", "account", "accountMeta"];
  if (pcContentEntitlements) requiredKeys.push("platformSettings");
  const nativeWritable = Boolean(
    state.native &&
      requiredKeys.every(
        (key) => state.loaded.bundle[key]?.native && state.loaded.bundle[key]?.token,
      ),
  );
  const platformSettingsBlocked =
    pcContentEntitlements &&
    (!state.loaded.validation.platformSettingsFound ||
      !state.loaded.validation.platformSettingsValid);
  const blocked = !compatibility.writeAllowed || platformSettingsBlocked;
  elements.writeBlocker.classList.toggle("hidden", !blocked);
  elements.writeBlocker.textContent = blocked
    ? platformSettingsBlocked
      ? "Licensed entitlement changes are blocked because GCUSERSETTINGSDATA.MXML was not found or could not be parsed."
      : `Writing is blocked: ${compatibility.reasons.join(" ")}`
    : "";
  elements.completeButton.disabled = blocked;
  elements.installButton.classList.toggle("hidden", !nativeWritable);
  elements.installButton.disabled = blocked || Boolean(state.native?.gameRunning);
  elements.installButton.textContent = state.native?.gameRunning
    ? "Close No Man's Sky to save"
    : "Save changes to game";
  elements.outputHeading.textContent = nativeWritable ? "Save completed changes" : "Verified recovery output";
  elements.outputDescription.textContent = nativeWritable
    ? "Press Save changes to game. Atlas backs up the selected save data, its matching metadata, and any changed account data, then verifies the transaction."
    : "Download the selected save data, its matching metadata, untouched originals, and a verification report.";
}

function selectedTemplateDefinition() {
  return getSaveTemplateDefinition(state.selectedTemplateId);
}

function templateRequiredKeys(definition) {
  const keys = ["save", "saveMeta"];
  const completionOptions = definition.completionOptions || {};
  if (!completionOptionsChangeAccount(completionOptions)) return keys;
  keys.push("account");
  if (["playstation-extracted", "xbox-game-pass"].includes(state.loaded?.adapter)) {
    keys.push("accountMeta");
  }
  if (completionOptionsRequirePlatformSettings(
    completionOptions,
    state.loaded?.adapter,
  )) {
    keys.push("platformSettings");
  }
  return keys;
}

function renderTemplateControls() {
  if (!state.loaded) return;
  const definition = selectedTemplateDefinition();
  const selectedRadio = elements.templateChoices.querySelector(
    `input[value="${definition.id}"]`,
  );
  if (selectedRadio) selectedRadio.checked = true;
  elements.templateTargetName.textContent =
    `${state.loaded.selectedSlot.details.name} · ${contextSummary(state.loaded.context)}`;
  elements.templateImpact.textContent =
    `${definition.detail} This action replaces ${definition.destructiveLabel} in the selected context. ` +
    (definition.kind === "full"
      ? "If the destination has one clear base owner, every imported owner-bound record is rebound to it; otherwise the destination's existing bases, settlement, pets and eggs are preserved."
      : "Everything outside MissionProgress stays unchanged.");

  const compatibility = state.loaded.compatibility;
  const platformSettingsBlocked =
    completionOptionsRequirePlatformSettings(
      definition.completionOptions,
      state.loaded.adapter,
    ) &&
    (!state.loaded.validation.platformSettingsFound ||
      !state.loaded.validation.platformSettingsValid);
  const blocked = !compatibility.writeAllowed || platformSettingsBlocked;
  const nativeWritable = Boolean(
    state.native &&
      templateRequiredKeys(definition).every(
        (key) => state.loaded.bundle[key]?.native && state.loaded.bundle[key]?.token,
      ),
  );
  elements.templateWriteBlocker.classList.toggle("hidden", !blocked);
  elements.templateWriteBlocker.textContent = blocked
    ? platformSettingsBlocked
      ? "Licensed entitlement changes require a valid GCUSERSETTINGSDATA.MXML file. Rescan the installed game before applying them."
      : `Template writing is blocked: ${compatibility.reasons.join(" ")}`
    : "";
  const confirmed = elements.templateConfirm.checked;
  elements.templateDownloadButton.disabled = blocked || !confirmed;
  elements.templateInstallButton.classList.toggle("hidden", !nativeWritable);
  elements.templateInstallButton.disabled =
    blocked || !confirmed || Boolean(state.native?.gameRunning);
  elements.templateInstallButton.textContent = state.native?.gameRunning
    ? "Close No Man's Sky to overwrite"
    : `Overwrite with ${definition.name}`;
}

function renderPreview() {
  if (!state.loaded) return;
  const preview = buildChangePreview(
    state.loaded.analysis,
    selectedOptions(),
    selectedOwnership(),
  );
  elements.previewTotal.textContent = `${preview.total.toLocaleString()} pending change${preview.total === 1 ? "" : "s"}`;
  elements.previewRows.replaceChildren();
  for (const item of preview.categories.filter((value) => value.enabled)) {
    const row = document.createElement("div");
    row.className = "preview-row";
    const label = document.createElement("span");
    const count = document.createElement("strong");
    label.textContent = item.label;
    count.textContent = item.additions ? `+${item.additions.toLocaleString()}` : "Verify";
    row.append(label, count);
    elements.previewRows.append(row);
  }
  if (!elements.previewRows.children.length) {
    const row = document.createElement("div");
    row.className = "preview-row";
    row.textContent = "No completion action selected.";
    elements.previewRows.append(row);
  }
}

function applyPreset(name) {
  const presets = {
    safe: [true, true, true, true, false, true, false],
    rewards: [true, false, false, false, false, true, false],
    catalogue: [false, true, false, true, false, true, false],
    repair: [false, false, false, false, false, true, false],
    full: [true, true, true, true, true, true, true],
  };
  const values = presets[name] || presets.safe;
  ["#optionRewards", "#optionBlueprints", "#optionLanguage", "#optionCatalogue", "#optionMilestones", "#optionRepair", "#optionProgression"]
    .forEach((selector, index) => {
      document.querySelector(selector).checked = values[index];
    });
  renderPreview();
  renderWriteControls();
}

function unchangedMetadataWords(before, after) {
  if (before.length !== after.length) return false;
  const mutable = new Set([14, 15, 21, 89, 90]);
  for (let index = 0; index < before.length; index += 1) {
    if (!mutable.has(index) && before[index] !== after[index]) return false;
  }
  return true;
}

function portableProtectedBytesUnchanged(before, after) {
  if (before.length !== after.length) return false;
  const mutable = new Set([
    8, 9, 10, 11,
    16, 17, 18, 19,
    36, 37, 38, 39,
  ]);
  for (let index = 0; index < before.length; index += 1) {
    if (!mutable.has(index) && before[index] !== after[index]) return false;
  }
  return true;
}

function otherContextUnchanged(beforeSave, afterSave, selectedContext) {
  const otherKey = selectedContext.key === "BaseContext" ? "ExpeditionContext" : "BaseContext";
  if (!(otherKey in beforeSave) && !(otherKey in afterSave)) return true;
  return JSON.stringify(beforeSave[otherKey]) === JSON.stringify(afterSave[otherKey]);
}

function outputName(record, fallback) {
  return record?.exportName || record?.originalName || canonicalNmsName(record?.name || fallback);
}

async function fileHashes(entries) {
  const output = {};
  for (const entry of entries) output[entry.name] = await sha256Hex(entry.bytes);
  return output;
}

async function hashTemplateState(save, templateId, contextPreference) {
  return sha256Hex(
    new TextEncoder().encode(
      templateVerificationJson(save, templateId, contextPreference),
    ),
  );
}

async function buildVerifiedOutput(operation = { type: "completion" }) {
  if (!state.loaded) throw new Error("Load a save first.");
  assertWritableCompatibility(state.loaded.compatibility);
  const isTemplate = operation.type === "template";
  let options = selectedOptions();
  let ownership = selectedOwnership();
  let completed;
  let templateResult = null;
  let templateExpectation = null;

  if (isTemplate) {
    const templateId = operation.templateId || state.selectedTemplateId;
    templateResult = applySaveTemplate(
      state.loaded.save.value,
      templateId,
      master,
      state.contextPreference,
    );
    options = templateResult.definition.completionOptions || {
      rewards: false,
      licensedEntitlements: false,
      blueprints: false,
      languageAndSlots: false,
      catalogue: false,
      naturalProgression: false,
      repairIntegrity: false,
      progressionConveniences: false,
    };
    ownership = { enabled: false };
    if (templateResult.definition.completionOptions) {
      completed = completePreparedUnlocks(
        templateResult.save,
        state.loaded.account.value,
        master,
        options,
        ownership,
        state.contextPreference,
        { beforeAnalysis: state.loaded.analysis },
      );
    } else {
      const context = resolveSaveContext(templateResult.save, state.contextPreference);
      completed = {
        save: templateResult.save,
        account: state.loaded.account.value,
        report: {
          context: {
            key: context.key,
            type: context.type,
            label: context.label,
            activeTag: context.activeTag,
            seasonNumber: context.seasonNumber,
          },
          options,
          additions: {},
          ownership: { enabled: false, totalChanges: 0 },
        },
      };
    }
    completed.report.additions = {
      ...completed.report.additions,
      templateFieldsReplaced: templateResult.changedFields.length,
      templateMissionRecords:
        templateResult.definition.kind === "missions" ? templateResult.missionCount : 0,
      templateIntegrityRemovals:
        templateResult.sanitization.duplicatesRemoved +
        templateResult.sanitization.removedTechnologies.length,
      templateBasesRebound: templateResult.basesRebound,
    };
    templateExpectation = {
      id: templateResult.definition.id,
      name: templateResult.definition.name,
      kind: templateResult.definition.kind,
      sourcePlayerStateFields:
        templateResult.definition.kind === "full" ? 243 : 0,
      missionCount: templateResult.missionCount,
      expectedHash: await hashTemplateState(
        completed.save,
        templateResult.definition.id,
        state.contextPreference,
      ),
    };
  } else {
    if (!Object.values(options).some(Boolean) && !ownership.enabled) {
      throw new Error("Select at least one completion or repair action.");
    }
    completed = completeUnlocks(
      state.loaded.save.value,
      state.loaded.account.value,
      master,
      options,
      ownership,
      state.contextPreference,
      { beforeAnalysis: state.loaded.analysis },
    );
  }
  if (!otherContextUnchanged(state.loaded.save.value, completed.save, state.loaded.context)) {
    throw new Error("The inactive player context changed unexpectedly.");
  }

  const saveOutput = encodeAdapterFile(
    completed.save,
    master.saveMap,
    state.loaded.save,
    "save",
  );
  const accountChanged =
    JSON.stringify(completed.account) !== JSON.stringify(state.loaded.account.value);
  const accountOutput = accountChanged
    ? encodeAdapterFile(
        completed.account,
        master.accountMap,
        state.loaded.account,
        "account",
      )
    : null;
  const adapter = state.loaded.adapter;
  const platformSettingsRequired = completionOptionsRequirePlatformSettings(
    options,
    adapter,
  );
  let platformSettingsOutput = null;
  let verifiedPlatformSettings = state.loaded.platformSettings;
  let platformSettingsVerified = !platformSettingsRequired;
  if (platformSettingsRequired) {
    const requiredPlatformRewards = accountEntitlements(master);
    if (!state.loaded.platformSettings || !state.loaded.bundle.platformSettings) {
      throw new Error(
        "GCUSERSETTINGSDATA.MXML is required for an explicit licensed-entitlement operation on PC.",
      );
    }
    platformSettingsOutput = completePlatformSettings(
      state.loaded.platformSettings,
      requiredPlatformRewards,
    );
    verifiedPlatformSettings = decodePlatformSettings(platformSettingsOutput.bytes);
    platformSettingsVerified = verifyPlatformSettings(
      verifiedPlatformSettings,
      requiredPlatformRewards,
    );
    if (!platformSettingsVerified) {
      throw new Error("PC account/platform-entitlement verification failed.");
    }
  }
  let saveMetaOutput = null;
  let accountMetaOutput = null;

  if (adapter === "steam" || adapter === "gog") {
    saveMetaOutput = updateMetadata(
      state.loaded.saveMeta,
      saveOutput.bytes,
      saveOutput.decompressedLength,
      saveOutput.compressed,
    );
  } else if (adapter === "playstation-extracted" || adapter === "switch-extracted") {
    saveMetaOutput = updatePortableManifest(state.loaded.saveMeta, saveOutput.decompressedLength);
    if (accountChanged && state.loaded.accountMeta) {
      accountMetaOutput = updatePortableManifest(
        state.loaded.accountMeta,
        accountOutput.decompressedLength,
      );
    }
  } else if (adapter === "xbox-game-pass") {
    saveMetaOutput = updateXboxMeta(
      state.loaded.bundle.saveMeta,
      saveOutput.decompressedLength,
      "save",
    );
    if (accountChanged) {
      accountMetaOutput = updateXboxMeta(
        state.loaded.bundle.accountMeta,
        accountOutput.decompressedLength,
        "account",
      );
    }
  }

  const verifiedSaveRecord = { ...state.loaded.bundle.save, bytes: saveOutput.bytes };
  const verifiedAccountRecord = accountChanged
    ? { ...state.loaded.bundle.account, bytes: accountOutput.bytes }
    : null;
  const verifiedSaveMetaRecord = saveMetaOutput
    ? { ...state.loaded.bundle.saveMeta, bytes: saveMetaOutput.bytes }
    : null;
  const verifiedAccountMetaRecord = accountMetaOutput
    ? { ...state.loaded.bundle.accountMeta, bytes: accountMetaOutput.bytes }
    : null;
  const verifiedSave = decodeAdapterFile(
    verifiedSaveRecord,
    master.saveMap,
    verifiedSaveMetaRecord,
    "save",
  );
  const verifiedAccount = accountChanged
    ? decodeAdapterFile(
        verifiedAccountRecord,
        master.accountMap,
        verifiedAccountMetaRecord,
        "account",
      )
    : state.loaded.account;
  const semantic = verifyCompletion(
    verifiedSave.value,
    verifiedAccount.value,
    master,
    options,
    state.contextPreference,
  );
  if (!semantic.ok) throw new Error(`Output verification failed: ${semantic.failures.join(", ")}`);
  let templateHashVerified = null;
  if (templateExpectation) {
    const reopenedTemplateHash = await hashTemplateState(
      verifiedSave.value,
      templateExpectation.id,
      state.contextPreference,
    );
    templateHashVerified = reopenedTemplateHash === templateExpectation.expectedHash;
    if (!templateHashVerified) {
      throw new Error(`${templateExpectation.name} changed during save encoding.`);
    }
  }
  if (verifiedSave.value.ActiveContext !== state.loaded.save.value.ActiveContext) {
    throw new Error("ActiveContext changed unexpectedly.");
  }

  let metadataVerified = true;
  let protectedMetadataPreserved = true;
  if (adapter === "steam" || adapter === "gog") {
    const decodedSaveMeta = decodeMetadata(saveMetaOutput.bytes, state.loaded.saveMeta.slot);
    metadataVerified = validateMetadata(
      decodedSaveMeta,
      saveOutput.bytes,
      verifiedSave.decompressedLength,
      verifiedSave.compressed,
      { strict: true },
    );
    protectedMetadataPreserved = unchangedMetadataWords(
      state.loaded.saveMeta.words,
      decodedSaveMeta.words,
    );
  } else if (adapter === "playstation-extracted" || adapter === "switch-extracted") {
    metadataVerified = validatePortableManifest(saveMetaOutput, verifiedSave) &&
      (!accountMetaOutput || validatePortableManifest(accountMetaOutput, verifiedAccount));
    protectedMetadataPreserved = portableProtectedBytesUnchanged(
      state.loaded.saveMeta.bytes,
      saveMetaOutput.bytes,
    ) && (!accountMetaOutput || portableProtectedBytesUnchanged(
      state.loaded.accountMeta.bytes,
      accountMetaOutput.bytes,
    ));
  } else if (adapter === "xbox-game-pass") {
    metadataVerified = validateXboxMeta(verifiedSaveMetaRecord, verifiedSave, "save") &&
      (!accountChanged ||
        validateXboxMeta(verifiedAccountMetaRecord, verifiedAccount, "account"));
    protectedMetadataPreserved = bytesEqual(
      state.loaded.bundle.saveMeta.bytes,
      saveMetaOutput.bytes,
    );
  }
  if (!metadataVerified) throw new Error("Output metadata verification failed.");
  if (!protectedMetadataPreserved) throw new Error("A protected metadata field changed unexpectedly.");

  completed.report.before = state.loaded.analysis;
  completed.report.after = applyPlatformSettingsAnalysis(
    analyzeCompletion(
      verifiedSave.value,
      verifiedAccount.value,
      master,
      state.contextPreference,
    ),
    verifiedAccount.value,
    verifiedPlatformSettings,
    adapter,
  );

  const platformSettingsChanged = Boolean(
    platformSettingsOutput &&
      !bytesEqual(
        platformSettingsOutput.bytes,
        state.loaded.bundle.platformSettings?.bytes || new Uint8Array(),
      ),
  );
  const completedEntries = [
    {
      role: "save",
      record: state.loaded.bundle.save,
      name: outputName(state.loaded.bundle.save, "save.hg"),
      bytes: saveOutput.bytes,
    },
    saveMetaOutput && {
      role: "saveMeta",
      record: state.loaded.bundle.saveMeta,
      name: outputName(state.loaded.bundle.saveMeta, "save-meta.hg"),
      bytes: saveMetaOutput.bytes,
    },
    accountChanged && { role: "account", record: state.loaded.bundle.account, name: outputName(state.loaded.bundle.account, "accountdata.hg"), bytes: accountOutput.bytes },
    accountMetaOutput && { role: "accountMeta", record: state.loaded.bundle.accountMeta, name: outputName(state.loaded.bundle.accountMeta, "account-meta.hg"), bytes: accountMetaOutput.bytes },
    platformSettingsChanged && {
      role: "platformSettings",
      record: state.loaded.bundle.platformSettings,
      name: outputName(state.loaded.bundle.platformSettings, "GCUSERSETTINGSDATA.MXML"),
      bytes: platformSettingsOutput.bytes,
    },
  ].filter(Boolean);
  const includeOriginals = operation.includeOriginals !== false;
  const originalEntries = includeOriginals
    ? completedEntries.map(({ record, name }) => ({
        name,
        bytes: record.bytes,
      }))
    : [];
  const additions = Object.values(completed.report.additions).reduce(
    (total, value) => total + (typeof value === "number" ? value : value.added + value.expanded),
    0,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    tool: "NMSA — No Man's Sky Atlas",
    toolVersion: master.toolVersion,
    operation: isTemplate ? "save-template" : "completion",
    dataPackage: master.activePackage,
    baseline: master.gameBaseline,
    selectedSaveName: state.loaded.selectedSlot.savePointLabel
      ? `${state.loaded.selectedSlot.details.name} — ${state.loaded.selectedSlot.savePointLabel}`
      : state.loaded.selectedSlot.details.name,
    savePointType: state.loaded.selectedSlot.savePointType || null,
    saveDataFile: outputName(state.loaded.bundle.save, "save.hg"),
    saveMetadataFile: outputName(state.loaded.bundle.saveMeta, "save-meta.hg"),
    platform: adapter,
    platformLabel: platformLabel(adapter),
    logicalSlot: state.loaded.selectedSlot.logicalSlot,
    storageOrdinal: state.loaded.selectedSlot.storageOrdinal,
    context: completed.report.context,
    compatibility: state.loaded.compatibility,
    verification: {
      semantic: true,
      metadata: metadataVerified,
      protectedMetadataFieldsPreserved: protectedMetadataPreserved,
      inactiveContextPreserved: true,
      activeContextPreserved: true,
      platformSettings: platformSettingsVerified,
      templateState: templateHashVerified,
      accountChanged,
      platformSettingsChanged,
    },
    platformSettingsRequired,
    platformRewards: platformSettingsRequired ? accountEntitlements(master) : [],
    completion: completed.report,
    template: templateExpectation
      ? {
          ...templateExpectation,
          removedInternalTechnologies:
            templateResult.sanitization.removedTechnologies,
          duplicateRecordsRemoved: templateResult.sanitization.duplicatesRemoved,
          basesRebound: templateResult.basesRebound,
          identityRecordsRebound: templateResult.identityRecordsRebound,
          ownerBoundFieldsPreserved: templateResult.ownerBoundFieldsPreserved,
          destinationOwnerDetected: templateResult.destinationOwnerDetected,
        }
      : null,
    completedSha256: await fileHashes(completedEntries),
    originalSha256: includeOriginals ? await fileHashes(originalEntries) : {},
  };
  for (const entry of completedEntries) entry.sha256 = report.completedSha256[entry.name];
  return {
    completedEntries,
    originalEntries,
    report,
    additions,
    templateExpectation,
  };
}

function timestampSlug() {
  const date = new Date();
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function installationText(output) {
  const names = output.completedEntries.map((entry) => entry.name).join("\n   - ");
  const platform = output.report.platformLabel;
  const scope = output.report.template
    ? `${output.report.template.name} replaces ${getSaveTemplateDefinition(output.report.template.id).destructiveLabel} in the selected context. Other logical save slots and the inactive context are preserved.`
    : "Atlas intentionally leaves missions, inventories, settlements, eggs, currencies, sane uncapped lifetime counters and foreign downloaded world-cache ownership untouched. Recognized editor sentinel values are repaired without inventing a fake maximum.";
  return `ATLAS COMPLETE v${master.toolVersion} — INSTALL / RECOVERY\n\nPlatform: ${platform}\nSave: ${output.report.selectedSaveName}\nContext: ${output.report.context.label}\n\n1. Fully close No Man's Sky.\n2. Make a copy of the entire platform save directory.\n3. Copy the matched files from completed into their original locations:\n   - ${names}\n4. Do not mix these files with an older save/account set.\n5. Start the game, load the slot, and save once normally.\n\nFor Xbox Game Pass containers, use Atlas desktop's Save changes to game button; do not manually rename blob files.\n\nRECOVERY\nRestore every file from backup-originals together. Atlas desktop backups can be restored from the Recovery panel with one click.\n\n${scope}\n`;
}

function recordHistory(output, installed, backupId = null) {
  addHistory({
    id: crypto.randomUUID(),
    generatedAt: output.report.generatedAt,
    action: output.report.template
      ? installed ? "template-installed" : "template-downloaded"
      : installed ? "installed" : "downloaded",
    template: output.report.template?.id || null,
    platform: output.report.platform,
    slot: output.report.logicalSlot,
    context: output.report.context.type,
    additions: output.additions,
    healthBefore: output.report.completion.before.health.score,
    healthAfter: output.report.completion.after.health.score,
    installed,
    backupId,
  });
  renderHistory();
}

function sameInstalledProfile(left, right) {
  const leftIdentity = saveSetIdentity(left);
  const rightIdentity = saveSetIdentity(right);
  return leftIdentity.platform === rightIdentity.platform &&
    leftIdentity.directory === rightIdentity.directory &&
    leftIdentity.profileName === rightIdentity.profileName;
}

function mergeTargetedReload(reopenedSlot, changedRoles) {
  const reopenedIdentity = saveSetIdentity(reopenedSlot);
  const sharedRoles = changedRoles.filter((role) =>
    ["account", "accountMeta", "platformSettings"].includes(role)
  );
  state.saveSlots = state.saveSlots.map((slot) => {
    if (findMatchingSaveSet([slot], reopenedIdentity)) return reopenedSlot;
    if (sharedRoles.length && sameInstalledProfile(slot, reopenedSlot)) {
      return prepareTargetedReload(slot, sharedRoles);
    }
    return slot;
  });
}

async function completeAndDownload(operation = { type: "completion" }) {
  const isTemplate = operation.type === "template";
  const definition = isTemplate
    ? getSaveTemplateDefinition(operation.templateId || state.selectedTemplateId)
    : null;
  setActivity(
    true,
    isTemplate ? `Preparing ${definition.name}…` : "Preparing the selected save…",
    8,
  );
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    const output = await buildVerifiedOutput(operation);
    state.lastOutput = output;
    updateActivity("Building the recovery ZIP…", 25);
    const zip = new JSZip();
    for (const entry of output.completedEntries) zip.file(`completed/${entry.name}`, entry.bytes);
    for (const entry of output.originalEntries) zip.file(`backup-originals/${entry.name}`, entry.bytes);
    zip.file("completion-report.json", JSON.stringify(output.report, null, 2));
    zip.file("INSTALL-AND-RECOVERY.txt", installationText(output));
    const archive = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
      (progress) => {
        updateActivity("Building the recovery ZIP…", 25 + (progress.percent * 0.74));
      },
    );
    const slotName = outputName(state.loaded.bundle.save, "save").replace(/\.[^.]+$/i, "");
    const prefix = isTemplate
      ? `Atlas-Template-${definition.id}-${slotName}`
      : `NMSA-${slotName}`;
    downloadBlob(archive, `${prefix}-${timestampSlug()}.zip`);
    recordHistory(output, false);
    showResult(
      isTemplate
        ? `${definition.name} recovery ZIP downloaded`
        : "Verified recovery ZIP downloaded",
      isTemplate
        ? `${definition.name} was encoded and verified for ${output.report.selectedSaveName}. The archive contains the replacement, untouched originals, hashes and a full rollback report.`
        : `${output.additions.toLocaleString()} entries added or repaired. The archive contains the matched output, untouched originals, hashes and a full audit report.`,
    );
  } finally {
    setActivity(false);
  }
}

async function installCompletedSave(operation = { type: "completion" }) {
  if (!state.native) throw new Error("Automatic installation requires Atlas desktop mode.");
  const isTemplate = operation.type === "template";
  const definition = isTemplate
    ? getSaveTemplateDefinition(operation.templateId || state.selectedTemplateId)
    : null;
  const status = await nativeRefreshStatus();
  state.native = { ...state.native, ...status };
  renderEnvironment();
  if (state.native.gameRunning) throw new Error("Fully close No Man’s Sky before installation.");
  setActivity(
    true,
    isTemplate ? `Preparing ${definition.name}…` : "Preparing the edited save…",
    8,
  );
  let installed = null;
  try {
    const installedSaveIdentity = saveSetIdentity(state.loaded?.selectedSlot);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    const output = await buildVerifiedOutput({ ...operation, includeOriginals: false });
    state.lastOutput = output;
    const files = output.completedEntries.map((entry) => {
      if (!entry.record?.token) throw new Error(`${entry.name} has no verified installation target.`);
      return { token: entry.record.token, role: entry.role, bytes: entry.bytes, sha256: entry.sha256 };
    });
    updateActivity(
      isTemplate
        ? `Backing up and installing ${definition.name}…`
        : "Creating a backup and saving changes…",
      42,
    );
    installed = await nativeInstall(files, {
      platform: output.report.platform,
      logicalSlot: output.report.logicalSlot,
      context: output.report.context.type,
      additions: output.additions,
      healthBefore: output.report.completion.before.health.score,
      healthAfter: output.report.completion.after.health.score,
      verification: output.report.verification,
      platformSettingsRequired: output.report.platformSettingsRequired,
      platformRewards: output.report.platformRewards,
      operation: output.report.operation,
      template: output.report.template,
    });
    updateActivity("Verifying the edited save…", 76);
    const changedRoles = output.completedEntries.map((entry) => entry.role);
    const targetedSlot = prepareTargetedReload(
      state.loaded.selectedSlot,
      changedRoles,
    );
    const reopenedSlot = await inspectSaveSet(targetedSlot);
    const exactReopenedSlot = findMatchingSaveSet(
      [reopenedSlot],
      installedSaveIdentity,
    );
    if (!exactReopenedSlot?.ready || !exactReopenedSlot._inspection) {
      throw new Error(
        "Files were written, but Atlas could not reopen and validate the edited save slot. " +
        "The transaction will be rolled back automatically.",
      );
    }
    mergeTargetedReload(exactReopenedSlot, changedRoles);
    state.selectedSaveId = exactReopenedSlot.id;
    state.contextPreference = output.report.context.type;
    state.loaded = {
      ...exactReopenedSlot._inspection,
      selectedSlot: exactReopenedSlot,
    };
    renderSaveSlots();
    refreshLoadedAnalysis();
    if (output.templateExpectation) {
      const reopenedHash = await hashTemplateState(
        state.loaded.save.value,
        output.templateExpectation.id,
        state.contextPreference,
      );
      if (reopenedHash !== output.templateExpectation.expectedHash) {
        throw new Error(
          `${output.templateExpectation.name} was written, but its reopened state did not match the verified output. The transaction will be rolled back automatically.`,
        );
      }
    } else {
      assertCompletionReloaded(output.report.completion.after, state.loaded.analysis);
    }
    updateActivity("The edited save is verified.", 100);
    recordHistory(output, true, installed.backupId);
    await refreshRecovery();
    const health = state.loaded.analysis.health;
    showResult(
      isTemplate
        ? `${definition.name} installed and verified`
        : "Changes saved, reopened, and verified",
      isTemplate
        ? `Atlas reopened only ${output.report.selectedSaveName}, verified the template state, and preserved every other physical save point. Rollback point: ${installed.backupId}.`
        : `${output.additions.toLocaleString()} entries added or repaired. Atlas reopened only the edited save and its required account companions, then confirmed ${health.completedEntries.toLocaleString()} of ${health.targetEntries.toLocaleString()} tracked entries complete. Rollback point: ${installed.backupId}.`,
    );
  } catch (error) {
    if (installed?.backupId) {
      try {
        await nativeRollback(installed.backupId);
        clearLoaded();
        await refreshRecovery();
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(error)} Automatic rollback also failed: ${errorMessage(rollbackError)}. ` +
          `Use Recovery backup ${installed.backupId} before starting the game.`,
        );
      }
      throw new Error(
        `${errorMessage(error)} The original files were restored automatically from ${installed.backupId}. Rescan before trying again.`,
      );
    }
    throw error;
  } finally {
    setActivity(false);
  }
}

function exportDiagnostic() {
  if (!state.loaded) throw new Error("Load a save before exporting diagnostics.");
  const diagnostic = createSafeDiagnostic(state.loaded, master);
  downloadBlob(
    new Blob([JSON.stringify(diagnostic, null, 2)], { type: "application/json" }),
    `Atlas-Safe-Diagnostic-${timestampSlug()}.json`,
  );
}

function showResult(title, summary) {
  elements.resultTitle.textContent = title;
  elements.resultSummary.textContent = summary;
  elements.resultPanel.classList.remove("hidden");
  window.setTimeout(() => {
    elements.resultTitle.focus({ preventScroll: true });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    elements.resultPanel.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center",
    });
  }, 0);
}

function renderBaseline() {
  elements.baselineTitle.textContent = master.gameBaseline;
  elements.baselineDetails.textContent = `Tested save version ${master.testedGameVersion} · writable format ${master.writableSaveFormats.join(", ")} · ${master.mappingVersion}`;
  elements.dataSourceBadge.textContent = state.dataSource === "imported" ? "Imported" : "Built in";
  elements.resetDataButton.classList.toggle("hidden", state.dataSource !== "imported");
  const counts = [
    ["Products", master.knownProducts.length],
    ["Specials", master.knownSpecials.length],
    ["Learnable tech", master.knownTechnologies.length],
    ["Recipes", master.refinerRecipes.length],
    ["Words", master.wordGroups.length],
    ["Season", master.seasonRewards.length],
    ["Twitch", master.twitchRewards.length],
    ["Fossils", master.fossilRecords.length],
    [
      "Verified catalogue records",
      (master.authoritativeCatalogueRecordProducts || master.fossilRecords).length,
    ],
    [
      "Speculative IDs excluded",
      (master.speculativeShipComponentRecords || []).length,
    ],
    ["Fish records", master.fishingRecords.length],
    ["Build records", master.seenBaseBuildingObjects.length],
    ["Story pages", master.storyRecords.length],
    ["Reality glitches", master.anomalousBasePartRecords.length],
    ["Titles", master.titles.length],
    ["Title stat families", master.sourceCounts.titleBackedStatFamilies],
    ["Ranked stats", master.naturalProgressionTargets.length],
    ["Sentinel repairs", master.naturalStatRepairs.length],
    ["Finite families", master.completionCoverage.finiteFamilies.length],
    [
      "Procedural preserved",
      master.completionCoverage.preservedProceduralFamilies.length,
    ],
    [
      "Definition-only",
      master.completionCoverage.definitionOnlyFamilies.length,
    ],
  ];
  elements.baselineCounts.replaceChildren();
  for (const [label, value] of counts) {
    const container = document.createElement("div");
    const term = document.createElement("dt");
    const data = document.createElement("dd");
    term.textContent = label;
    data.textContent = value.toLocaleString();
    container.append(term, data);
    elements.baselineCounts.append(container);
  }
}

function renderEnvironment() {
  if (state.native) {
    elements.environmentBadge.textContent = `Desktop mode · ${state.native.version || "v2"}`;
    elements.environmentBadge.className = "environment-badge success";
    elements.sourceTitle.textContent = "Installed saves detected automatically";
    elements.sourceDescription.textContent = "Steam, GOG and Xbox companion files are paired without drag-and-drop.";
    elements.gameBadge.classList.remove("hidden");
    elements.gameBadge.textContent = state.native.gameRunning ? "No Man’s Sky is running" : "No Man’s Sky is closed";
    elements.gameBadge.className = `environment-badge ${state.native.gameRunning ? "warning" : "success"}`;
  } else {
    elements.environmentBadge.textContent = "Portable browser mode";
    elements.environmentBadge.className = "environment-badge";
    elements.sourceTitle.textContent = "Scan a save folder";
    elements.sourceDescription.textContent = "Select the NMS profile folder once; Atlas finds every companion file.";
    elements.gameBadge.classList.add("hidden");
  }
  if (state.loaded) {
    renderWriteControls();
    renderTemplateControls();
  }
}

function renderHistory() {
  const history = loadHistory();
  elements.historyList.replaceChildren();
  if (!history.length) {
    const empty = document.createElement("p");
    empty.textContent = "No completion history yet.";
    elements.historyList.append(empty);
    return;
  }
  for (const item of history.slice(0, 12)) {
    const entry = document.createElement("div");
    entry.className = "history-entry";
    const body = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    const templateName = item.template
      ? getSaveTemplateDefinition(item.template).name
      : null;
    title.textContent = `${item.installed ? "Installed" : "Downloaded"}${templateName ? ` ${templateName}` : ""} · ${platformLabel(item.platform)} slot ${item.slot}`;
    detail.textContent = `${formatDateTime(item.generatedAt)} · ${item.context} · +${item.additions.toLocaleString()} · ${item.healthBefore}% → ${item.healthAfter}%`;
    body.append(title, detail);
    entry.append(body);
    elements.historyList.append(entry);
  }
}

async function refreshRecovery() {
  renderHistory();
  elements.backupList.replaceChildren();
  if (!state.native) {
    const empty = document.createElement("p");
    empty.textContent = "Automatic rollback is available when Atlas is opened with the desktop launcher.";
    elements.backupList.append(empty);
    return;
  }
  try {
    const response = await nativeBackups();
    const backups = response.backups || [];
    if (!backups.length) {
      const empty = document.createElement("p");
      empty.textContent = "No automatic backups yet.";
      elements.backupList.append(empty);
      return;
    }
    for (const backup of backups.slice(0, 12)) {
      const entry = document.createElement("div");
      entry.className = "history-entry";
      const body = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("small");
      title.textContent = `${backup.platformLabel || "NMS"} · ${backup.fileCount} files`;
      detail.textContent = `${formatDateTime(backup.createdAt)} · ${backup.backupId}`;
      body.append(title, detail);
      const restore = document.createElement("button");
      restore.className = "button ghost";
      restore.type = "button";
      restore.textContent = "Rollback";
      restore.addEventListener("click", () => runUiOperation(
        "Restoring the selected backup…",
        () => rollbackBackup(backup.backupId),
      ));
      entry.append(body, restore);
      elements.backupList.append(entry);
    }
  } catch (error) {
    const failed = document.createElement("p");
    failed.textContent = `Could not load backups: ${errorMessage(error)}`;
    elements.backupList.append(failed);
  }
}

async function rollbackBackup(backupId) {
  const status = await nativeRefreshStatus();
  if (status.gameRunning) throw new Error("Fully close No Man’s Sky before rollback.");
  setActivity(true, "Restoring the selected backup…");
  try {
    const result = await nativeRollback(backupId);
    await refreshRecovery();
    showResult("Rollback verified", `${result.restoredCount} files were restored and hash-verified from ${backupId}.`);
    if (state.native) await findInstalledSaves();
  } finally {
    setActivity(false);
  }
}

async function importDataPackage(file) {
  setActivity(true, "Validating the NMSA data package…");
  try {
    if (!file || !Number.isFinite(file.size) || file.size > MAX_DATA_PACKAGE_BYTES) {
      throw new Error("The selected data package exceeds the 8 MB safety limit.");
    }
    master = await activateDataPackage(await file.text(), builtinMaster);
    state.dataSource = "imported";
    elements.dataPackageStatus.textContent = `${master.activePackage} activated. Save compatibility will be recalculated.`;
    renderBaseline();
    state.saveSlots = [];
    state.selectedSaveId = null;
    clearLoaded();
    renderSaveSlots();
    if (state.native) await findInstalledSaves();
  } finally {
    setActivity(false);
  }
}

async function resetDataPackage() {
  deactivateDataPackage();
  master = builtinMaster;
  state.dataSource = "built-in";
  elements.dataPackageStatus.textContent = "Built-in verified data package restored.";
  renderBaseline();
  state.saveSlots = [];
  state.selectedSaveId = null;
  clearLoaded();
  renderSaveSlots();
  if (state.native) await findInstalledSaves();
}

function filesToEntries(files) {
  return files.map((file) => ({
    file,
    name: file.name,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

async function start() {
  const templateIds = new Set(
    [...elements.templateChoices.querySelectorAll('input[name="saveTemplate"]')]
      .map((input) => input.value),
  );
  if (
    SAVE_TEMPLATE_DEFINITIONS.length !== templateIds.size ||
    SAVE_TEMPLATE_DEFINITIONS.some((definition) => !templateIds.has(definition.id))
  ) {
    throw new Error("Save State Templates UI does not match the packaged template data.");
  }
  state.native = await connectNativeBridge();
  if (state.native) {
    deactivateDataPackage();
  }
  const active = state.native
    ? { master: builtinMaster, source: "built-in", error: null }
    : await loadActiveDataPackage(builtinMaster);
  master = active.master;
  state.dataSource = active.source;
  if (active.error) elements.dataPackageStatus.textContent = active.error;
  renderBaseline();
  if (state.native) {
    elements.importDataButton.classList.add("hidden");
    elements.dataPackageInput.disabled = true;
    elements.resetDataButton.classList.add("hidden");
    elements.dataPackageStatus.textContent =
      "Verified database updates are delivered with signed NMSA app updates.";
  }
  renderHistory();
  renderEnvironment();
  await refreshRecovery();
  if (state.native) {
    try {
      await findInstalledSaves();
    } catch (error) {
      showError(error);
      elements.folderStatus.textContent = "Automatic scan did not find a complete profile. Open another folder to continue.";
    }
  } else {
    elements.folderStatus.textContent = "Choose the NMS folder, or load extracted console files.";
  }
}

elements.browseButton.addEventListener("click", () => {
  if (state.native) {
    runUiOperation("Scanning installed saves…", findInstalledSaves);
  } else {
    findInstalledSaves().catch(showError);
  }
});
function openFolderFromUi(label) {
  if (state.native) {
    runUiOperation(label, chooseOtherFolder);
  } else {
    chooseOtherFolder().catch(showError);
  }
}

elements.otherFolderButton.addEventListener("click", () =>
  openFolderFromUi("Opening and scanning another save folder…"),
);
elements.portableButton.addEventListener("click", () =>
  openFolderFromUi("Opening and scanning extracted console files…"),
);
elements.folderInput.addEventListener("change", (event) => {
  const files = [...event.target.files];
  const label = files[0]?.webkitRelativePath?.split("/")[0] || "Selected folder";
  event.target.value = "";
  runUiOperation("Scanning the selected folder…", () =>
    scanEntries(filesToEntries(files), label),
  );
});
elements.loadButton.addEventListener("click", () => runUiOperation(
  "Loading and verifying the selected save…",
  loadSelectedSave,
));
elements.contextSelect.addEventListener("change", () => {
  state.contextPreference = elements.contextSelect.value;
  elements.templateConfirm.checked = false;
  refreshLoadedAnalysis();
  renderTemplateControls();
});
elements.presetSelect.addEventListener("change", () => applyPreset(elements.presetSelect.value));
for (const selector of [
  "#optionRewards", "#optionBlueprints", "#optionLanguage", "#optionCatalogue",
  "#optionMilestones", "#optionRepair", "#optionProgression", "#normalizeBases",
  "#normalizeDiscoveries", "#clearEditorLabels",
]) {
  document.querySelector(selector).addEventListener("change", () => {
    renderPreview();
    renderWriteControls();
  });
}
elements.ownershipEnabled.addEventListener("change", () => {
  setRegionEnabled(elements.ownershipFields, elements.ownershipEnabled.checked);
  renderPreview();
});
elements.ownershipFields.addEventListener("input", renderPreview);
elements.ownershipFields.addEventListener("change", renderPreview);
elements.addAliasButton.addEventListener("click", () => {
  addAliasRow();
  renderPreview();
});
elements.completeButton.addEventListener("click", () => runUiOperation(
  "Preparing the recovery ZIP…",
  completeAndDownload,
));
elements.installButton.addEventListener("click", () => runUiOperation(
  "Installing and verifying changes…",
  installCompletedSave,
));
elements.templateChoices.addEventListener("change", (event) => {
  if (!event.target.matches('input[name="saveTemplate"]')) return;
  state.selectedTemplateId = event.target.value;
  elements.templateConfirm.checked = false;
  renderTemplateControls();
});
elements.templateConfirm.addEventListener("change", renderTemplateControls);
elements.templateDownloadButton.addEventListener("click", () =>
  runUiOperation("Preparing the template recovery ZIP…", () =>
    completeAndDownload({
      type: "template",
      templateId: state.selectedTemplateId,
    }),
  ),
);
elements.templateInstallButton.addEventListener("click", () =>
  runUiOperation("Installing and verifying the template…", () =>
    installCompletedSave({
      type: "template",
      templateId: state.selectedTemplateId,
    }),
  ),
);
elements.diagnosticButton.addEventListener("click", () => {
  try { exportDiagnostic(); } catch (error) { showError(error); }
});
elements.refreshRecoveryButton.addEventListener("click", () => runUiOperation(
  "Refreshing recovery points…",
  refreshRecovery,
));
elements.importDataButton.addEventListener("click", () => elements.dataPackageInput.click());
elements.dataPackageInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) runUiOperation(
    "Validating the NMSA data package…",
    () => importDataPackage(file),
  );
});
elements.resetDataButton.addEventListener("click", () => runUiOperation(
  "Restoring the built-in data package…",
  resetDataPackage,
));
window.addEventListener("focus", async () => {
  if (!state.native || operationController.activeOperation) return;
  try {
    state.native = { ...state.native, ...(await nativeRefreshStatus()) };
    renderEnvironment();
  } catch {
    // The local bridge may have closed after a long idle period.
  }
});

setRegionEnabled(elements.ownershipFields, elements.ownershipEnabled.checked);
renderSaveSlots();
start().catch(showError);
