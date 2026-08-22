[CmdletBinding()]
param(
    [string] $PublishDirectory,
    [string] $OutputDirectory,
    [switch] $StoreSubmission,
    [ValidateSet('CertificateStore', 'ArtifactSigning')]
    [string] $SigningProvider = $(if ($env:NMSA_SIGNING_PROVIDER) { $env:NMSA_SIGNING_PROVIDER } else { 'CertificateStore' }),
    [string] $CertificateThumbprint = $env:NMSA_SIGNING_CERT_THUMBPRINT,
    [string] $ArtifactSigningDlibPath = $env:NMSA_ARTIFACT_SIGNING_DLIB,
    [string] $ArtifactSigningMetadataPath = $env:NMSA_ARTIFACT_SIGNING_METADATA,
    [string] $Publisher = $env:NMSA_MSIX_PUBLISHER,
    [string] $IdentityName = $env:NMSA_STORE_IDENTITY_NAME,
    [string] $StorePublisher = $env:NMSA_STORE_PUBLISHER,
    [string] $PublisherDisplayName = $env:NMSA_STORE_PUBLISHER_DISPLAY_NAME,
    [string] $TimestampUrl = $env:NMSA_TIMESTAMP_URL
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $PSCommandPath
if ([string]::IsNullOrWhiteSpace($PublishDirectory)) {
    $PublishDirectory = Join-Path $scriptRoot '..\desktop\publish\win-x64'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $scriptRoot '..\release'
}

if ($StoreSubmission) {
    if ([string]::IsNullOrWhiteSpace($IdentityName) -or [string]::IsNullOrWhiteSpace($StorePublisher) -or [string]::IsNullOrWhiteSpace($PublisherDisplayName)) {
        throw 'Store packaging requires NMSA_STORE_IDENTITY_NAME, NMSA_STORE_PUBLISHER, and NMSA_STORE_PUBLISHER_DISPLAY_NAME from Partner Center.'
    }
    $Publisher = $StorePublisher
    if ($IdentityName -notmatch '^[A-Za-z0-9.-]{3,50}$') {
        throw 'NMSA_STORE_IDENTITY_NAME is not a valid Partner Center package identity name.'
    }
}
elseif ($SigningProvider -eq 'CertificateStore') {
    if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
        throw 'MSIX CertificateStore packaging requires NMSA_SIGNING_CERT_THUMBPRINT or -CertificateThumbprint.'
    }
    $thumbprint = $CertificateThumbprint.Replace(' ', '').ToUpperInvariant()
    $certificate = $null
    foreach ($certificatePath in @("Cert:\CurrentUser\My\$thumbprint", "Cert:\LocalMachine\My\$thumbprint")) {
        if (Test-Path -LiteralPath $certificatePath) {
            $certificate = Get-Item -LiteralPath $certificatePath
            break
        }
    }
    if (-not $certificate) {
        throw "The MSIX publisher certificate '$thumbprint' was not found."
    }
    $Publisher = $certificate.Subject
}
elseif ([string]::IsNullOrWhiteSpace($Publisher)) {
    throw 'Artifact Signing MSIX packaging requires NMSA_MSIX_PUBLISHER or -Publisher to exactly match the certificate profile subject.'
}

$publish = (Resolve-Path -LiteralPath $PublishDirectory -ErrorAction Stop).Path
$executable = Join-Path $publish 'NMSA.exe'
if (-not $StoreSubmission) {
    & (Join-Path $PSScriptRoot 'sign-windows.ps1') -Path $executable -VerifyOnly
    if ($LASTEXITCODE -ne 0) { throw 'NMSA.exe signature verification failed.' }
}

$packageJson = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
$semanticVersion = [string]$packageJson.version
if ($semanticVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "Invalid NMSA version '$semanticVersion'."
}
$msixVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
$distributionRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$legalSourceDirectory = Join-Path $distributionRoot 'Legal'
$noticeManifestFilename = 'dependency-notices.json'
$noticeManifestPath = Join-Path $legalSourceDirectory $noticeManifestFilename
if (-not (Test-Path -LiteralPath $noticeManifestPath -PathType Leaf)) {
    throw "Dependency notice manifest is missing: $noticeManifestFilename"
}
$noticeManifest = [IO.File]::ReadAllText($noticeManifestPath) | ConvertFrom-Json
if ($noticeManifest.schemaVersion -ne 1 -or -not $noticeManifest.groups) {
    throw 'Dependency notice manifest must use schemaVersion 1 and define groups.'
}
$desktopLegalFilenames = [Collections.Generic.List[string]]::new()
$seenLegalFilenames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($noticeGroupName in @('common', 'desktopOnly')) {
    $noticeGroup = @($noticeManifest.groups.$noticeGroupName)
    if ($noticeGroup.Count -eq 0) {
        throw "Dependency notice manifest group is empty: $noticeGroupName"
    }
    foreach ($dependency in $noticeGroup) {
        if ([string]::IsNullOrWhiteSpace([string]$dependency.name) -or
            [string]::IsNullOrWhiteSpace([string]$dependency.version) -or
            [string]::IsNullOrWhiteSpace([string]$dependency.license)) {
            throw "Dependency notice manifest has incomplete package metadata in $noticeGroupName."
        }
        foreach ($noticeFile in @($dependency.files)) {
            $legalFilename = [string]$noticeFile.name
            $expectedHash = [string]$noticeFile.sha256
            if ([string]::IsNullOrWhiteSpace($legalFilename) -or
                $legalFilename -ne [IO.Path]::GetFileName($legalFilename) -or
                -not $legalFilename.EndsWith('.txt', [StringComparison]::Ordinal) -or
                $expectedHash -notmatch '^[a-f0-9]{64}$') {
                throw "Dependency notice manifest has an invalid file entry for $($dependency.name)."
            }
            if (-not $seenLegalFilenames.Add($legalFilename)) {
                throw "Dependency notice manifest repeats a legal filename: $legalFilename"
            }
            $legalSource = Join-Path $legalSourceDirectory $legalFilename
            if (-not (Test-Path -LiteralPath $legalSource -PathType Leaf)) {
                throw "Desktop legal notice is missing: $legalFilename"
            }
            $actualHash = (Get-FileHash -LiteralPath $legalSource -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $expectedHash) {
                throw "Dependency notice hash mismatch for $legalFilename. Expected $expectedHash; got $actualHash."
            }
            $desktopLegalFilenames.Add($legalFilename)
        }
    }
}

$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$makeAppx = Get-ChildItem -LiteralPath $sdkRoot -Filter 'makeappx.exe' -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Name -eq 'x64' } |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
if (-not $makeAppx) { throw 'MakeAppx.exe was not found. Install the Windows SDK packaging tools.' }

$stage = Join-Path $scriptRoot "..\desktop\.nmsa-msix-$([Guid]::NewGuid().ToString('N'))"
$stage = [IO.Path]::GetFullPath($stage)
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot '..\desktop'))
if (-not $stage.StartsWith($desktopRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to stage MSIX outside the desktop workspace.'
}

try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    # Copy every published file to its exact relative location before generating
    # the manifest, so the package boundary is explicit and verifiable.
    $publishRoot = $publish.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $publishPrefix = $publishRoot + [IO.Path]::DirectorySeparatorChar
    $publishedFiles = @(Get-ChildItem -LiteralPath $publishRoot -Recurse -File -Force)
    if ($publishedFiles.Count -eq 0) {
        throw "Desktop publish output is empty: $publishRoot"
    }
    foreach ($publishedFile in $publishedFiles) {
        if (-not $publishedFile.FullName.StartsWith($publishPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to stage file outside the desktop publish workspace: $($publishedFile.FullName)"
        }
        $relativePath = $publishedFile.FullName.Substring($publishPrefix.Length)
        $destination = Join-Path $stage $relativePath
        $destinationDirectory = Split-Path -Parent $destination
        [IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
        [IO.File]::Copy($publishedFile.FullName, $destination, $true)
    }

    $legalStage = Join-Path $stage 'Legal'
    [IO.Directory]::CreateDirectory($legalStage) | Out-Null
    [IO.File]::Copy((Join-Path $distributionRoot 'LICENSE'), (Join-Path $legalStage 'LICENSE'), $true)
    [IO.File]::Copy((Join-Path $distributionRoot 'THIRD_PARTY_NOTICES.md'), (Join-Path $legalStage 'THIRD_PARTY_NOTICES.md'), $true)
    [IO.File]::Copy($noticeManifestPath, (Join-Path $legalStage $noticeManifestFilename), $true)
    foreach ($legalFilename in $desktopLegalFilenames) {
        $legalSource = Join-Path $legalSourceDirectory $legalFilename
        if (-not (Test-Path -LiteralPath $legalSource -PathType Leaf)) {
            throw "Desktop legal notice is missing: $legalFilename"
        }
        [IO.File]::Copy($legalSource, (Join-Path $legalStage $legalFilename), $true)
    }

    $requiredStageFiles = @(
        'NMSA.exe',
        'Web\NMSA.html',
        'Web\nmsa.css',
        'Web\nmsa.js',
        'Legal\LICENSE',
        'Legal\THIRD_PARTY_NOTICES.md',
        "Legal\$noticeManifestFilename"
    ) + @($desktopLegalFilenames | ForEach-Object { "Legal\$_" })
    $stageReadyBy = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $missingStageFiles = @($requiredStageFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $stage $_) -PathType Leaf) })
        if ($missingStageFiles.Count -eq 0) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $stageReadyBy)
    if ($missingStageFiles.Count -gt 0) {
        $stagedFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($stage.Length).TrimStart([IO.Path]::DirectorySeparatorChar) })
        throw "MSIX staging is missing required app files: $($missingStageFiles -join ', '). Staged files: $($stagedFiles -join ', ')"
    }
    # -Include is unreliable with -LiteralPath in Windows PowerShell and can
    # remove every staged file. Filter the enumerated file objects explicitly.
    Get-ChildItem -LiteralPath $stage -Recurse -File -Force |
        Where-Object { $_.Extension -in @('.pdb', '.xml') } |
        Remove-Item -Force

    $assets = Join-Path $stage 'Assets'
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    Add-Type -AssemblyName System.Drawing
    foreach ($asset in @(
        [pscustomobject]@{ Name = 'Square44x44Logo.png'; Width = 44; Height = 44; Font = 11 },
        [pscustomobject]@{ Name = 'Square150x150Logo.png'; Width = 150; Height = 150; Font = 34 },
        [pscustomobject]@{ Name = 'Wide310x150Logo.png'; Width = 310; Height = 150; Font = 38 },
        [pscustomobject]@{ Name = 'StoreLogo.png'; Width = 50; Height = 50; Font = 12 }
    )) {
        $bitmap = New-Object System.Drawing.Bitmap $asset.Width, $asset.Height
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::FromArgb(7, 11, 18))
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $font = New-Object System.Drawing.Font 'Segoe UI', $asset.Font, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
                $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(100, 240, 223))
                try {
                    $format = New-Object System.Drawing.StringFormat
                    $format.Alignment = [System.Drawing.StringAlignment]::Center
                    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
                    $graphics.DrawString('NMSA', $font, $brush, [System.Drawing.RectangleF]::new(0, 0, $asset.Width, $asset.Height), $format)
                    $format.Dispose()
                }
                finally {
                    $font.Dispose()
                    $brush.Dispose()
                }
            }
            finally { $graphics.Dispose() }
            $bitmap.Save((Join-Path $assets $asset.Name), [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally { $bitmap.Dispose() }
    }

    $publisher = [Security.SecurityElement]::Escape($Publisher)
    $identity = [Security.SecurityElement]::Escape($(if ($StoreSubmission) { $IdentityName } else { 'NMSA.NoMansSkyAtlas' }))
    $publisherDisplay = [Security.SecurityElement]::Escape($(if ($StoreSubmission) { $PublisherDisplayName } else { $Publisher }))
    $manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="$identity" Publisher="$publisher" Version="$msixVersion" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>NMSA - No Man's Sky Atlas</DisplayName>
    <PublisherDisplayName>$publisherDisplay</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Applications>
    <Application Id="NMSA" Executable="NMSA.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="NMSA - No Man's Sky Atlas"
                          Description="Local-first No Man's Sky save completion, repair, backup, and recovery."
                          BackgroundColor="#070B12"
                          Square150x150Logo="Assets\Square150x150Logo.png"
                          Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
"@
    [IO.File]::WriteAllText(
        (Join-Path $stage 'AppxManifest.xml'),
        $manifest,
        (New-Object -TypeName Text.UTF8Encoding -ArgumentList $false))

    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    $packageName = if ($StoreSubmission) { "NMSA-v$semanticVersion-store-upload-unsigned.msix" } else { "NMSA-v$semanticVersion-win-x64.msix" }
    $output = [IO.Path]::GetFullPath((Join-Path $OutputDirectory $packageName))
    & $makeAppx.FullName pack /d $stage /p $output /o /h SHA256
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed (exit code $LASTEXITCODE)." }

    if ($StoreSubmission) {
        Write-Host "Wrote Store-submission package (upload only; Microsoft signs after certification): $output"
    }
    else {
        & (Join-Path $PSScriptRoot 'sign-windows.ps1') -Path $output -Provider $SigningProvider -CertificateThumbprint $CertificateThumbprint -ArtifactSigningDlibPath $ArtifactSigningDlibPath -ArtifactSigningMetadataPath $ArtifactSigningMetadataPath -TimestampUrl $TimestampUrl
        if ($LASTEXITCODE -ne 0) { throw 'MSIX signing failed.' }
        Write-Host "Wrote signed installer: $output"
    }
}
finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
