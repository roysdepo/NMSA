import test from "node:test";
import assert from "node:assert/strict";
import { createOperationController, setRegionEnabled } from "../src/ui-state.js";

function fakeRegion() {
  const attributes = new Map();
  const classes = new Set();
  return {
    inert: false,
    attributes,
    classes,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  };
}

test("operation controller serializes destructive UI actions and always unlocks", async () => {
  const root = fakeRegion();
  const changes = [];
  let release;
  const controller = createOperationController({
    root,
    onChange: (value) => changes.push(value),
  });
  const first = controller.run("save installation", () =>
    new Promise((resolve) => { release = resolve; }),
  );

  assert.equal(controller.activeOperation, "save installation");
  assert.equal(root.inert, true);
  assert.equal(root.attributes.get("aria-busy"), "true");
  await assert.rejects(
    controller.run("rollback", async () => {}),
    /Wait for save installation/,
  );

  release("installed");
  assert.equal(await first, "installed");
  assert.equal(controller.activeOperation, null);
  assert.equal(root.inert, false);
  assert.equal(root.attributes.has("aria-busy"), false);
  assert.deepEqual(changes, ["save installation", null]);
});

test("operation controller unlocks the UI after a failed action", async () => {
  const root = fakeRegion();
  const controller = createOperationController({ root });
  await assert.rejects(
    controller.run("scan", async () => { throw new Error("scan failed"); }),
    /scan failed/,
  );
  assert.equal(root.inert, false);
  assert.equal(controller.activeOperation, null);
});

test("disabled regions are inert and exposed to assistive technology", () => {
  const region = fakeRegion();
  setRegionEnabled(region, false);
  assert.equal(region.inert, true);
  assert.equal(region.attributes.get("aria-disabled"), "true");
  assert.equal(region.classes.has("disabled"), true);

  setRegionEnabled(region, true);
  assert.equal(region.inert, false);
  assert.equal(region.attributes.get("aria-disabled"), "false");
  assert.equal(region.classes.has("disabled"), false);
});
