function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contextCandidate(save, key, type, label) {
  const root = save?.[key];
  if (!isRecord(root) || !isRecord(root.PlayerStateData)) return null;
  return {
    key,
    type,
    label,
    root,
    playerState: root.PlayerStateData,
    spawnState: isRecord(root.SpawnStateData) ? root.SpawnStateData : null,
  };
}

export function listSaveContexts(save) {
  const contexts = [
    contextCandidate(save, "BaseContext", "main", "Main save"),
    contextCandidate(save, "ExpeditionContext", "expedition", "Expedition save"),
  ].filter(Boolean);

  if (isRecord(save?.PlayerStateData)) {
    contexts.push({
      key: "PlayerStateData",
      type: "legacy",
      label: "Legacy save",
      root: save,
      playerState: save.PlayerStateData,
      spawnState: isRecord(save.SpawnStateData) ? save.SpawnStateData : null,
    });
  }
  return contexts;
}

export function resolveSaveContext(save, preference = "active") {
  const contexts = listSaveContexts(save);
  if (!contexts.length) {
    throw new Error("Save has no supported player context.");
  }

  const activeTag = String(save?.ActiveContext ?? "").trim();
  const wantsExpedition = activeTag.toLowerCase() === "season";
  let selected = null;

  if (preference === "main") {
    selected = contexts.find((item) => item.type === "main") ?? null;
  } else if (preference === "expedition") {
    selected = contexts.find((item) => item.type === "expedition") ?? null;
  } else if (wantsExpedition) {
    selected = contexts.find((item) => item.type === "expedition") ?? null;
  } else {
    selected = contexts.find((item) => item.type === "main") ?? null;
  }

  selected ??= contexts[0];
  const seasonNumber = Number(
    selected.playerState?.StartingSeasonNumber ??
      save?.CommonStateData?.SeasonData?.SeasonNumber ??
      0,
  );

  return {
    ...selected,
    requested: preference,
    activeTag: activeTag || "Unspecified",
    seasonNumber: Number.isFinite(seasonNumber) ? seasonNumber : 0,
    available: contexts.map(({ key, type, label }) => ({ key, type, label })),
    usedFallback:
      (preference === "main" && selected.type !== "main") ||
      (preference === "expedition" && selected.type !== "expedition") ||
      (preference === "active" && wantsExpedition && selected.type !== "expedition"),
  };
}

export function contextSummary(context) {
  if (context.type === "expedition") {
    return context.seasonNumber
      ? `${context.label} · Expedition ${context.seasonNumber}`
      : context.label;
  }
  return context.label;
}
