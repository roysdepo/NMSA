[CmdletBinding()]
param(
    [string] $IdentityName = $env:NMSA_STORE_IDENTITY_NAME,
    [string] $Publisher = $env:NMSA_STORE_PUBLISHER,
    [string] $PublisherDisplayName = $env:NMSA_STORE_PUBLISHER_DISPLAY_NAME
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($IdentityName) -or [string]::IsNullOrWhiteSpace($Publisher) -or [string]::IsNullOrWhiteSpace($PublisherDisplayName)) {
    throw 'Store release requires NMSA_STORE_IDENTITY_NAME, NMSA_STORE_PUBLISHER, and NMSA_STORE_PUBLISHER_DISPLAY_NAME copied from Partner Center.'
}

$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = [IO.Path]::GetFullPath((Join-Path $project 'release\store-upload'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $project 'release'))
if (-not $outputDirectory.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to write a Store package outside the release workspace.'
}

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

    & (Join-Path $PSScriptRoot 'package-msix.ps1') `
        -StoreSubmission `
        -OutputDirectory $outputDirectory `
        -IdentityName $IdentityName `
        -StorePublisher $Publisher `
        -PublisherDisplayName $PublisherDisplayName
    if ($LASTEXITCODE -ne 0) { throw 'Store MSIX packaging failed.' }

    [IO.File]::WriteAllText(
        (Join-Path $outputDirectory 'README-STORE-UPLOAD-ONLY.txt'),
        "Upload this MSIX to Microsoft Partner Center. It is intentionally unsigned and must not be distributed directly; Microsoft signs it after certification.$([Environment]::NewLine)",
        [Text.UTF8Encoding]::new($false))
    Write-Host "Store upload artifacts are ready in $outputDirectory"
}
finally {
    Pop-Location
}
