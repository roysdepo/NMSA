import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageData = JSON.parse(
  await readFile(path.join(project, "package.json"), "utf8"),
);
const version = packageData.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid NMSA package version: ${version}`);
}
const result = await build({
  entryPoints: [path.join(project, "src", "app.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome100", "edge100", "firefox100", "safari16"],
  minify: true,
  legalComments: "none",
  write: false,
});

const javascript = new TextDecoder()
  .decode(result.outputFiles[0].contents)
  .replaceAll("</script", "<\\/script");
const [template, css, coverImage, headerMarkImage] = await Promise.all([
  readFile(path.join(project, "src", "index.html"), "utf8"),
  readFile(path.join(project, "src", "styles.css"), "utf8"),
  readFile(path.join(project, "src", "assets", "nmsa-cover-v1.jpg")),
  readFile(path.join(project, "src", "assets", "nmsa-header-mark-v1.jpg")),
]);
const coverImageDataUri = `data:image/jpeg;base64,${coverImage.toString("base64")}`;
const headerMarkImageDataUri = `data:image/jpeg;base64,${headerMarkImage.toString("base64")}`;
const renderedCss = css.replaceAll("__NMSA_COVER_IMAGE__", coverImageDataUri);
const html = template
  .replaceAll("__ATLAS_VERSION__", version)
  .replaceAll("__NMSA_HEADER_MARK_IMAGE__", headerMarkImageDataUri)
  .replace("/*__INLINE_CSS__*/", () => renderedCss)
  .replace("/*__INLINE_JS__*/", () => javascript);
if (
  html.includes("__ATLAS_VERSION__") ||
  html.includes("__NMSA_COVER_IMAGE__") ||
  html.includes("__NMSA_HEADER_MARK_IMAGE__")
) {
  throw new Error("NMSA build placeholder remained in the built HTML.");
}
const desktopHtml = template
  .replaceAll("__ATLAS_VERSION__", version)
  .replaceAll("__NMSA_HEADER_MARK_IMAGE__", headerMarkImageDataUri)
  .replace(
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'",
  )
  .replace(
    "<style>/*__INLINE_CSS__*/</style>",
    '<link rel="stylesheet" href="nmsa.css" />',
  )
  .replace(
    "<script>/*__INLINE_JS__*/</script>",
    '<script src="nmsa.js"></script>',
  );
if (
  desktopHtml.includes("__ATLAS_VERSION__") ||
  desktopHtml.includes("__NMSA_COVER_IMAGE__") ||
  desktopHtml.includes("__NMSA_HEADER_MARK_IMAGE__") ||
  renderedCss.includes("__NMSA_COVER_IMAGE__") ||
  desktopHtml.includes("unsafe-inline") ||
  desktopHtml.includes("/*__INLINE_")
) {
  throw new Error("NMSA desktop assets did not receive the strict CSP build.");
}

const dist = path.join(project, "dist");
const desktop = path.join(dist, "desktop");
await Promise.all([
  mkdir(dist, { recursive: true }),
  mkdir(desktop, { recursive: true }),
]);
const destination = path.join(project, "dist", "NMSA.html");
await Promise.all([
  writeFile(destination, html),
  writeFile(path.join(desktop, "NMSA.html"), desktopHtml),
  writeFile(path.join(desktop, "nmsa.css"), renderedCss),
  writeFile(path.join(desktop, "nmsa.js"), javascript),
]);
console.log(`wrote ${destination} (${Buffer.byteLength(html).toLocaleString()} bytes)`);
console.log(`wrote strict desktop assets to ${desktop}`);
