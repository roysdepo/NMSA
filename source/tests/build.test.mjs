import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(project, "dist", "NMSA.html");
const desktopOutput = path.join(project, "dist", "desktop");

test("release is one self-contained offline HTML file", async () => {
  const info = await stat(output);
  const [html, packageText] = await Promise.all([
    readFile(output, "utf8"),
    readFile(path.join(project, "package.json"), "utf8"),
  ]);
  const version = JSON.parse(packageText).version;
  assert(info.size > 400_000);
  assert.match(html, /No Man’s Sky Atlas/);
  assert.match(html, new RegExp(`<title>NMSA v${version.replaceAll(".", "\\.")} — No Man's Sky Atlas<\/title>`));
  assert.match(html, new RegExp(`<span class="version">v${version.replaceAll(".", "\\.")}<\\/span>`));
  assert.doesNotMatch(html, /__ATLAS_VERSION__/);
  assert.doesNotMatch(html, /__NMSA_COVER_IMAGE__/);
  assert.doesNotMatch(html, /__NMSA_HEADER_MARK_IMAGE__/);
  assert.match(html, /url\("data:image\/jpeg;base64,[^"]+"\)/);
  assert.equal((html.match(/data:image\/jpeg;base64/g) || []).length, 2);
  assert.match(html, /class="hero-brand-mark" aria-hidden="true"/);
  assert.match(html, /<img src="data:image\/jpeg;base64,[^"]+" alt="" width="360" height="360" decoding="async"/);
  assert.match(html, /class="landscape-footer" aria-hidden="true"/);
  assert.match(html, /Files stay on this device/);
  assert.match(html, /Find my saves/);
  assert.match(html, /Load selected save/);
  assert.match(html, /class="activity-popup hidden"/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /ownershipFields[^>]+inert[^>]+aria-disabled="true"/);
  assert.match(html, /Wait for .* to finish before starting another action/);
  assert.match(html, /resultTitle" tabindex="-1"/);
  assert.match(html, /Verifying the edited save/);
  assert.match(html, /reopened only the edited save and its required account companions/);
  assert.doesNotMatch(html, /busy-overlay/);
  assert.doesNotMatch(html, /Checking save .* of/);
  assert.doesNotMatch(html, /Rescanning installed files and verifying completion state/);
  assert.match(html, /Changes saved, reopened, and verified/);
  assert.match(html, /Save State Templates/);
  assert.match(html, /Full Progression/);
  assert.match(html, /Explorer Progression/);
  assert.match(html, /Mission Progress/);
  assert.match(html, /511 unique completed Voyagers mission-progress records/);
  assert.match(html, /Overwrite selected save/);
  assert.match(html, /template-installed/);
  assert.match(html, /templateState/);
  assert.match(html, /Other save slots are not changed/);
  assert.match(html, /Natural milestones &amp; standing|Natural milestones & standing/);
  assert.match(html, /licensed\/platform entitlements are preserved/);
  assert.doesNotMatch(html, /all six account\/platform entitlements on PC/);
  assert.match(html, /explicit licensed-entitlement operation on PC/);
  assert.match(html, /GCUSERSETTINGSDATA\.MXML/);
  assert.doesNotMatch(html, /Drop four/);
  assert.equal(html.includes("/*__INLINE_CSS__*/"), false);
  assert.equal(html.includes("/*__INLINE_JS__*/"), false);
  assert.equal(/<script[^>]+src=/i.test(html), false);
  assert.equal(/<link[^>]+href=/i.test(html), false);
});

test("desktop web assets enforce a strict external-resource CSP", async () => {
  const [html, css, javascript] = await Promise.all([
    readFile(path.join(desktopOutput, "NMSA.html"), "utf8"),
    readFile(path.join(desktopOutput, "nmsa.css"), "utf8"),
    readFile(path.join(desktopOutput, "nmsa.js"), "utf8"),
  ]);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /style-src 'self'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|blob:/);
  assert.match(html, /<link rel="stylesheet" href="nmsa\.css"/);
  assert.match(html, /<script src="nmsa\.js"><\/script>/);
  assert.doesNotMatch(html, /<style>|<script>/);
  assert.doesNotMatch(css, /__NMSA_COVER_IMAGE__/);
  assert.match(css, /url\("data:image\/jpeg;base64,[^"]+"\)/);
  assert.equal((css.match(/data:image\/jpeg;base64/g) || []).length, 1);
  assert.match(css, /var\(--nmsa-cover-image\) center top \/ max\(100%, 1600px\) auto no-repeat/);
  assert.match(css, /var\(--nmsa-cover-image\) center bottom \/ max\(100%, 1600px\) auto no-repeat/);
  assert(css.length > 20_000);
  assert(javascript.length > 300_000);
});
