[CmdletBinding()]
param(
    [ValidateSet('CertificateStore', 'ArtifactSigning')]
    [string] $SigningProvider = $(if ($env:NMSA_SIGNING_PROVIDER) { $env:NMSA_SIGNING_PROVIDER } else { 'CertificateStore' }),
    [string] $CertificateThumbprint = $env:NMSA_SIGNING_CERT_THUMBPRINT,
    [string] $ArtifactSigningDlibPath = $env:NMSA_ARTIFACT_SIGNING_DLIB,
    [string] $ArtifactSigningMetadataPath = $env:NMSA_ARTIFACT_SIGNING_METADATA,
    [string] $MsixPublisher = $env:NMSA_MSIX_PUBLISHER,
    [string] $TimestampUrl = $env:NMSA_TIMESTAMP_URL
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($SigningProvider -eq 'CertificateStore' -and [string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
    throw 'Production release is fail-closed: configure NMSA_SIGNING_CERT_THUMBPRINT with an organization-validated code-signing certificate.'
}
if ($SigningProvider -eq 'ArtifactSigning' -and ([string]::IsNullOrWhiteSpace($ArtifactSigningDlibPath) -or [string]::IsNullOrWhiteSpace($ArtifactSigningMetadataPath) -or [string]::IsNullOrWhiteSpace($MsixPublisher))) {
    throw 'Artifact Signing release requires the dlib path, metadata path, and exact NMSA_MSIX_PUBLISHER profile subject.'
}

$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $project
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Test suite failed.' }
    npm run desktop:restore
    if ($LASTEXITCODE -ne 0) { throw 'Locked desktop dependency restore failed.' }
    npm run desktop:build
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
    npm run desktop:verify
    if ($LASTEXITCODE -ne 0) { throw 'Desktop verification failed.' }

    $publishDirectory = [IO.Path]::GetFullPath((Join-Path $project 'desktop\publish\win-x64'))
    $desktopRoot = [IO.Path]::GetFullPath((Join-Path $project 'desktop'))
    if (-not $publishDirectory.StartsWith($desktopRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clean a publish path outside the desktop workspace.'
    }
    if (Test-Path -LiteralPath $publishDirectory) {
        Remove-Item -LiteralPath $publishDirectory -Recurse -Force
    }
    npm run desktop:publish
    if ($LASTEXITCODE -ne 0) { throw 'Desktop publish failed.' }

    $executable = Join-Path $project 'desktop\publish\win-x64\NMSA.exe'
    & (Join-Path $PSScriptRoot 'sign-windows.ps1') -Path $executable -Provider $SigningProvider -CertificateThumbprint $CertificateThumbprint -ArtifactSigningDlibPath $ArtifactSigningDlibPath -ArtifactSigningMetadataPath $ArtifactSigningMetadataPath -TimestampUrl $TimestampUrl
    node scripts/package-desktop.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Signed ZIP packaging failed.' }
    & (Join-Path $PSScriptRoot 'package-msix.ps1') -SigningProvider $SigningProvider -CertificateThumbprint $CertificateThumbprint -ArtifactSigningDlibPath $ArtifactSigningDlibPath -ArtifactSigningMetadataPath $ArtifactSigningMetadataPath -Publisher $MsixPublisher -TimestampUrl $TimestampUrl
}
finally {
    Pop-Location
}
