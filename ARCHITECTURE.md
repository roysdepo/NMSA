# NMSA architecture

NMSA is a local desktop system. Save bytes are decoded, analyzed, edited,
verified, backed up, and recovered on the user's computer; there is no hosted
save-processing service or application database.

```text
Installed or selected save folder
              |
              v
Discovery and exact companion pairing
              |
              v
Platform codec and compatibility checks
              |
              v
Health analysis -> change preview -> explicit operation
              |
              v
Encode -> reopen -> semantic/hash verification
              |
              v
Backup -> transactional install -> rollback on failure
```

## Components

| Component | Responsibility |
|---|---|
| `.NET 10 WPF host` | Native lifecycle, accessibility, WebView2 isolation, discovery, backup, install, verification, and rollback |
| `IAtlasHostApi` | Typed in-process boundary between the UI and privileged local file operations |
| `platform-adapters.js` | Steam/GOG, Xbox, and extracted console container decoding and encoding |
| `completion.js` | Context-aware health analysis and explicitly selected completion/repair changes |
| `save-discovery.js` | Logical-slot discovery and exact data/metadata companion pairing |
| `post-install.js` | Targeted disk reload and verification of the installed save point |
| `nms-codec.js` | NMS compression, lossless JSON mapping, metadata encryption, and hashing |
| `source/src/data/` | Versioned compatibility and completion datasets bundled with the app |

The WPF application hosts verified local HTML/JavaScript assets in WebView2.
The browser surface receives short-lived opaque file tokens, not filesystem
paths. API requests are handled inside the process; no loopback web server or
network listener is created. The PowerShell launcher remains a portable
compatibility path and is not included in the WPF desktop package.

## Write-safety invariants

1. A writable set belongs to one profile, one platform, one physical save
   point, and its exact companions.
2. Unknown or untested versions remain readable but cannot be written.
3. The selected player context is explicit; inactive contexts and unrelated
   save points are preserved.
4. Output is reopened and semantically verified before installation.
5. Every target is backed up before replacement, and any failed transaction
   restores the complete original set.
6. Post-write verification reopens the exact edited point and compares it with
   the verified output rather than trusting cached state.
7. Only one state-changing UI operation can run at a time.
8. Raw-file capabilities expire and request bodies are bounded.

## Build and release boundary

`source/scripts/build.mjs` creates the offline web assets.
`source/scripts/package-desktop.mjs` packages the self-contained WPF build, and
`source/scripts/package-msix.ps1` creates the MSIX staging boundary. Release
packages include the project license and exact WebView2/.NET dependency notices
under `Legal/`. GitHub Actions rebuilds and verifies the source on every change
to `main`; public binaries should be created only from a validated tag.

NMSA scales through local execution and immutable release artifacts: additional
users do not create centralized save uploads, storage, or codec compute.
