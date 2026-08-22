export function createOperationController({ root, onChange = () => {} }) {
  if (!root) throw new Error("An operation root is required.");
  let activeOperation = null;

  return Object.freeze({
    get activeOperation() {
      return activeOperation;
    },

    async run(label, operation) {
      if (activeOperation) {
        throw new Error(`Wait for ${activeOperation} to finish before starting another action.`);
      }
      if (typeof operation !== "function") throw new Error("An operation callback is required.");

      activeOperation = String(label || "the current action");
      root.inert = true;
      root.setAttribute("aria-busy", "true");
      onChange(activeOperation);
      try {
        return await operation();
      } finally {
        root.inert = false;
        root.removeAttribute("aria-busy");
        activeOperation = null;
        onChange(null);
      }
    },
  });
}

export function setRegionEnabled(region, enabled) {
  if (!region) throw new Error("A region is required.");
  const disabled = !enabled;
  region.inert = disabled;
  region.classList.toggle("disabled", disabled);
  region.setAttribute("aria-disabled", String(disabled));
}
