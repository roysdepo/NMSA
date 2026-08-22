import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  dependencyNoticeFiles,
  loadDependencyNoticeManifest,
} from "../scripts/dependency-notices.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(project, "..");

function balancedPowerShell(source) {
  const stack = [];
  const pairs = new Map([["}", "{"], [")", "("], ["]", "["]]);
  let quote = null;
  let lineComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (quote) {
      if (char === "`" && quote === '"') index += 1;
      else if (char === quote) {
        if (quote === "'" && next === "'") index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "#") { lineComment = true; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "{" || char === "(" || char === "[") stack.push(char);
    else if (pairs.has(char)) {
      assert.equal(stack.pop(), pairs.get(char), `unbalanced PowerShell token at ${index}`);
    }
  }
  assert.equal(quote, null, "unterminated PowerShell string");
  assert.deepEqual(stack, [], "unclosed PowerShell token");
}

test("legacy portable bridge remains guarded during the desktop migration", async () => {
  const [source, client] = await Promise.all([
    readFile(path.join(root, "Atlas-Complete.ps1"), "utf8"),
    readFile(path.join(project, "src", "native-bridge.js"), "utf8"),
  ]);
  balancedPowerShell(source);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /X-Atlas-Session/);
  assert.match(source, /\$script:ApiVersion = 1/);
  assert.match(source, /apiVersion = \$script:ApiVersion/);
  assert.match(source, /Get-GameRunning/);
  assert.match(source, /New-BackupForPaths/);
  assert.match(source, /Restore-BackupManifest/);
  assert.match(source, /post-write verification/i);
  assert.match(source, /Parse-XboxContainerIndex/);
  assert.match(source, /GCUSERSETTINGSDATA\.MXML/);
  assert.match(source, /Test-PlatformSettingsBytes/);
  assert.match(source, /platformSettingsRequired/);
  assert.match(source, /accountChanged/);
  assert.match(source, /platformSettingsChanged/);
  assert.match(source, /templateState/);
  assert.match(source, /save-template/);
  assert.match(source, /\$script:FileTokenLifetime = \[TimeSpan\]::FromMinutes\(30\)/);
  assert.match(source, /IssuedUtc = \[DateTime\]::UtcNow/);
  assert.match(source, /Get-FileTokenTarget \$token/);
  assert.match(source, /\$Request\.InputStream\.Read\(\$buffer/);
  assert.match(source, /\$total -gt \$MaxBytes/);
  assert.match(source, /Read-JsonBody \$context\.Request \$script:InstallJsonBodyLimit/);
  assert.doesNotMatch(source, /ReadToEnd\(\)/);
  assert.match(source, /Cross-Origin-Resource-Policy/);
  assert.match(client, /status\.apiVersion !== 1/);
  assert.match(client, /X-NMSA-Session/);
  assert.match(source, /\$requested\.Count -lt 2/);
  assert.doesNotMatch(source, /requires one matched save\/account set/);
  assert.doesNotMatch(source, /HttpListener\.Pending/);
});

test("WPF desktop uses the typed in-process C# host with no worker or loopback listener", async () => {
  const desktop = path.join(project, "desktop", "AtlasComplete.Desktop");
  const [windowSource, hostSource, transactionSource, routerSource, projectSource, appSource, bridgeSource] = await Promise.all([
    readFile(path.join(desktop, "MainWindow.xaml.cs"), "utf8"),
    readFile(path.join(desktop, "Infrastructure", "Host", "AtlasHostApi.cs"), "utf8"),
    readFile(path.join(desktop, "Infrastructure", "Host", "TransactionService.cs"), "utf8"),
    readFile(path.join(desktop, "Infrastructure", "Host", "WebViewApiRouter.cs"), "utf8"),
    readFile(path.join(desktop, "AtlasComplete.Desktop.csproj"), "utf8"),
    readFile(path.join(project, "src", "app.js"), "utf8"),
    readFile(path.join(root, "Atlas-Complete.ps1"), "utf8"),
  ]);

  assert.match(windowSource, /AtlasHostApi _hostApi = new\(\)/);
  assert.match(windowSource, /SetVirtualHostNameToFolderMapping/);
  assert.match(windowSource, /WebViewApiRouter\.VirtualHost}\/NMSA\.html#session=/);
  assert.match(windowSource, /Path\.Combine\(AppContext\.BaseDirectory, "Web"\)/);
  assert.match(windowSource, /IsWebMessageEnabled = false/);
  assert.doesNotMatch(windowSource, /Process\.Start|PowerShell|HttpListener|127\.0\.0\.1|localhost/);
  assert.match(hostSource, /class AtlasHostApi : IAtlasHostApi/);
  assert.match(hostSource, /"in-process-host"/);
  assert.match(transactionSource, /CreateBackup/);
  assert.match(transactionSource, /RestoreBackupManifest/);
  assert.match(transactionSource, /post-write verification/i);
  assert.match(transactionSource, /UpdateXboxIndexes/);
  assert.match(transactionSource, /ValidateMatchedSavePointTargets/);
  assert.match(transactionSource, /ValidateSourcesUnchanged/);
  assert.match(transactionSource, /Count is < 2 or > 4/);
  assert.match(bridgeSource, /Assert-MatchedSavePointTargets/);
  assert.match(bridgeSource, /Assert-SourcesUnchanged/);
  assert.match(bridgeSource, /\$requested\.Count -lt 2 -or \$requested\.Count -gt 4/);
  assert.doesNotMatch(appSource, /pairedSnapshotInspections|completeSnapshotsIndependently|snapshotOutputs/);
  assert.match(appSource, /slot\.savePointLabel/);
  assert.match(appSource, /dataName.*metadataName/s);
  assert.match(appSource, /await nativeRollback\(installed\.backupId\)/);
  assert.match(
    appSource,
    /async function installCompletedSave[\s\S]*?let installed = null;[\s\S]*?installed = await nativeInstall/,
  );
  assert.match(routerSource, /X-NMSA-Session/);
  assert.match(routerSource, /InstallBodyLimit = 192L \* 1024L \* 1024L/);
  assert.match(routerSource, /Unverified result was accepted|unverified result was accepted/i);
  assert.doesNotMatch(projectSource, /\.ps1/);
  assert.match(projectSource, /dist\\desktop\\NMSA\.html/);
  assert.match(projectSource, /<ApplicationIcon>Assets\\nmsa\.ico<\/ApplicationIcon>/);
});

test("Windows launcher and packaged app versions stay aligned", async () => {
  const [script, command, app, compatibility] = await Promise.all([
    readFile(path.join(root, "Atlas-Complete.ps1"), "utf8"),
    readFile(path.join(root, "Open NMSA Portable.cmd"), "utf8"),
    readFile(path.join(project, "package.json"), "utf8"),
    readFile(path.join(project, "src", "data", "compatibility.json"), "utf8"),
  ]);
  const version = JSON.parse(app).version;
  assert.match(script, new RegExp(`\\$script:Version = "${version.replaceAll(".", "\\.")}"`));
  assert.match(command, /Atlas-Complete\.ps1/i);
  assert.equal(JSON.parse(compatibility).toolVersion, version);
});

test("desktop ZIP and MSIX packaging preserve manifest-driven legal notices", async () => {
  const [desktopPackage, msix, notices, projectSource] = await Promise.all([
    readFile(path.join(project, "scripts", "package-desktop.mjs"), "utf8"),
    readFile(path.join(project, "scripts", "package-msix.ps1"), "utf8"),
    readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    readFile(
      path.join(project, "desktop", "AtlasComplete.Desktop", "AtlasComplete.Desktop.csproj"),
      "utf8",
    ),
  ]);
  const { manifest } = await loadDependencyNoticeManifest(root);

  assert.match(projectSource, /Microsoft\.Web\.WebView2" Version="1\.0\.4078\.44"/);
  assert.match(desktopPackage, /root\.file\("Legal\/LICENSE"/);
  assert.match(desktopPackage, /root\.file\(\s*"Legal\/THIRD_PARTY_NOTICES\.md"/);
  assert.match(desktopPackage, /addDependencyNoticesToZip\(root, distributionRoot, "desktop"\)/);
  assert.match(msix, /\$legalStage = Join-Path \$stage 'Legal'/);
  assert.match(msix, /Legal\\THIRD_PARTY_NOTICES\.md/);
  assert.match(msix, /\$noticeManifestFilename = 'dependency-notices\.json'/);
  assert.match(msix, /@\('common', 'desktopOnly'\)/);
  assert.match(msix, /Get-FileHash -LiteralPath \$legalSource -Algorithm SHA256/);
  assert.match(msix, /\[IO\.File\]::Copy\(\$legalSource, \(Join-Path \$legalStage \$legalFilename\), \$true\)/);

  for (const file of dependencyNoticeFiles(manifest, "desktop")) {
    assert.ok(notices.includes(`Legal/${file.name}`), `notice index omits ${file.name}`);
  }
});

test("production distribution separates signed downloads from Store-managed signing", async () => {
  const [signing, msix, desktopPackage, productionRelease, storeRelease, packageJson] = await Promise.all([
    readFile(path.join(project, "scripts", "sign-windows.ps1"), "utf8"),
    readFile(path.join(project, "scripts", "package-msix.ps1"), "utf8"),
    readFile(path.join(project, "scripts", "package-desktop.mjs"), "utf8"),
    readFile(path.join(project, "scripts", "release-desktop.ps1"), "utf8"),
    readFile(path.join(project, "scripts", "release-desktop-store.ps1"), "utf8"),
    readFile(path.join(project, "package.json"), "utf8"),
  ]);

  assert.match(signing, /NMSA_SIGNING_CERT_THUMBPRINT/);
  assert.match(signing, /ArtifactSigning/);
  assert.match(signing, /Azure\.CodeSigning\.Dlib\.dll/);
  assert.match(signing, /\.codesigning\.azure\.net/);
  assert.match(signing, /timestamp\.acs\.microsoft\.com/);
  assert.match(signing, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(signing, /'\/fd', 'SHA256', '\/td', 'SHA256', '\/tr'/);
  assert.match(signing, /verify \/pa \/all \/tw \/v/);
  assert.doesNotMatch(signing, /New-SelfSignedCertificate/);
  assert.match(msix, /Publisher="\$publisher"/);
  assert.match(msix, /NMSA_MSIX_PUBLISHER/);
  assert.match(msix, /sign-windows\.ps1.*-Path \$executable -VerifyOnly/s);
  assert.match(msix, /sign-windows\.ps1.*-Path \$output/s);
  assert.match(msix, /Get-ChildItem -LiteralPath \$publishRoot -Recurse -File -Force/);
  assert.match(msix, /\[IO\.File\]::Copy\(\$publishedFile\.FullName, \$destination, \$true\)/);
  assert.match(msix, /MSIX staging is missing required app files/);
  assert.match(msix, /\[DateTime\]::UtcNow\.AddSeconds\(30\)/);
  assert.match(msix, /\$_\.Extension -in @\('\.pdb', '\.xml'\)/);
  assert.doesNotMatch(msix, /-Recurse -Include/);
  assert.match(desktopPackage, /UNSIGNED DEVELOPMENT BUILD — DO NOT DISTRIBUTE/);
  assert.match(desktopPackage, /Production packaging requires a valid, trusted, timestamped NMSA\.exe signature/);
  assert.match(desktopPackage, /PowerShell worker/);
  assert.match(productionRelease, /Production release is fail-closed/);
  assert.match(msix, /StoreSubmission/);
  assert.match(msix, /NMSA_STORE_IDENTITY_NAME/);
  assert.match(msix, /store-upload-unsigned\.msix/);
  assert.match(storeRelease, /README-STORE-UPLOAD-ONLY\.txt/);
  assert.match(storeRelease, /must not be distributed directly/);
  assert.match(JSON.parse(packageJson).scripts["desktop:store"], /release-desktop-store\.ps1/);
  assert.doesNotMatch(JSON.parse(packageJson).scripts["desktop:publish"], /DebugType=embedded/);
});
