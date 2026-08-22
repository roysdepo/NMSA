# NMSA — No Man's Sky Atlas

NMSA is a local-first Windows utility for inspecting, completing, repairing,
backing up, and recovering compatible No Man's Sky saves. It identifies the
real save points in a profile, previews every proposed change, and keeps save
data on the user's device.

NMSA is an independent community project and is not affiliated with or endorsed
by Hello Games.

Copyright (C) 2026 NMSA Project.

## Current status

The current source version is **3.0.6**. This repository is the minimal public
source and release channel. Validated downloads will be published on the
[Releases page](../../releases); do not download builds offered elsewhere.

## What it does

- Finds Steam, GOG, and Xbox Game Pass saves, with manual folder selection for
  other legitimately extracted saves.
- Treats each physical save point correctly as its data file plus its exact
  `mf_*.hg` metadata companion.
- Shows completion health and an exact change preview before writing.
- Creates a timestamped backup, writes companion files transactionally,
  verifies hashes and reopened save semantics, and rolls back on failure.
- Provides separately confirmed progression templates without silently changing
  unrelated save slots or inactive player contexts.

Always close No Man's Sky before writing and keep an independent backup of any
save you value. Unknown or unverified save versions are analysis-only.

## Build and test

Requirements: Windows, Node.js 24, and the .NET 10 SDK.

```powershell
cd source
npm ci
npm run build
npm test
dotnet restore NMSA.slnx -p:PublishReadyToRun=true --locked-mode
dotnet build NMSA.slnx --configuration Release --no-restore -m:1
dotnet run --project desktop/AtlasComplete.Desktop.Verification/AtlasComplete.Desktop.Verification.csproj --configuration Release --no-build
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the component and safety boundaries,
[PRIVACY.md](PRIVACY.md) for local data handling, and [SECURITY.md](SECURITY.md)
for responsible vulnerability reporting.

## License and trademarks

Source code is licensed under [GNU AGPL-3.0-only](LICENSE). Required dependency
notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[`Legal/`](Legal/). No Man's Sky and related marks belong to Hello Games; see
[TRADEMARKS.md](TRADEMARKS.md).
