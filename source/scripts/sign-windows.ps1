[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]] $Path,

    [ValidateSet('CertificateStore', 'ArtifactSigning')]
    [string] $Provider = $(if ($env:NMSA_SIGNING_PROVIDER) { $env:NMSA_SIGNING_PROVIDER } else { 'CertificateStore' }),

    [string] $CertificateThumbprint = $env:NMSA_SIGNING_CERT_THUMBPRINT,

    [string] $ArtifactSigningDlibPath = $env:NMSA_ARTIFACT_SIGNING_DLIB,

    [string] $ArtifactSigningMetadataPath = $env:NMSA_ARTIFACT_SIGNING_METADATA,

    [string] $TimestampUrl = $env:NMSA_TIMESTAMP_URL,

    [switch] $VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-WindowsSdkTool {
    param([Parameter(Mandatory = $true)][string] $Name)

    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $tool = Get-ChildItem -LiteralPath $sdkRoot -Filter $Name -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq 'x64' } |
        Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
        Select-Object -First 1
    if (-not $tool) {
        throw "$Name was not found. Install the Windows SDK signing tools."
    }
    return $tool.FullName
}

function Resolve-SigningCertificate {
    param([Parameter(Mandatory = $true)][string] $Thumbprint)

    $normalized = $Thumbprint.Replace(' ', '').ToUpperInvariant()
    if ($normalized -notmatch '^[0-9A-F]{40}$') {
        throw 'NMSA_SIGNING_CERT_THUMBPRINT must be a 40-character SHA-1 certificate thumbprint.'
    }

    foreach ($candidate in @(
        [pscustomobject]@{ Path = "Cert:\CurrentUser\My\$normalized"; Machine = $false },
        [pscustomobject]@{ Path = "Cert:\LocalMachine\My\$normalized"; Machine = $true }
    )) {
        if (-not (Test-Path -LiteralPath $candidate.Path)) { continue }
        $certificate = Get-Item -LiteralPath $candidate.Path
        if (-not $certificate.HasPrivateKey) {
            throw "The signing certificate '$normalized' does not expose a private key."
        }
        $now = Get-Date
        if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
            throw "The signing certificate '$normalized' is not currently valid."
        }

        $eku = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | Select-Object -First 1
        if ($eku -and -not ($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })) {
            throw "The signing certificate '$normalized' is not valid for code signing."
        }
        $keyUsage = $certificate.Extensions |
            Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension] } |
            Select-Object -First 1
        if ($keyUsage -and -not ($keyUsage.KeyUsages -band [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature)) {
            throw "The signing certificate '$normalized' does not permit digital signatures."
        }

        return [pscustomobject]@{
            Certificate = $certificate
            Machine = $candidate.Machine
        }
    }

    throw "No signing certificate with thumbprint '$normalized' exists in CurrentUser\My or LocalMachine\My."
}

$signTool = Find-WindowsSdkTool -Name 'signtool.exe'
$resolvedPaths = @($Path | ForEach-Object {
    $resolved = (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path
    if ([IO.Path]::GetExtension($resolved).ToLowerInvariant() -notin @('.exe', '.dll', '.msi', '.msix')) {
        throw "Unsupported signing target: $resolved"
    }
    $resolved
})

if (-not $VerifyOnly) {
    if ([string]::IsNullOrWhiteSpace($TimestampUrl)) {
        $TimestampUrl = if ($Provider -eq 'ArtifactSigning') {
            'http://timestamp.acs.microsoft.com/'
        }
        else {
            'http://timestamp.digicert.com'
        }
    }
    $timestamp = $null
    if ((-not [Uri]::TryCreate($TimestampUrl, [UriKind]::Absolute, [ref]$timestamp)) -or ($timestamp.Scheme -notin @('http', 'https'))) {
        throw 'The timestamp URL must be an absolute HTTP or HTTPS URL.'
    }

    if ($Provider -eq 'CertificateStore') {
        if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
            throw 'CertificateStore signing requires NMSA_SIGNING_CERT_THUMBPRINT or -CertificateThumbprint. Self-signed development certificates are intentionally rejected.'
        }

        $selected = Resolve-SigningCertificate -Thumbprint $CertificateThumbprint
        foreach ($target in $resolvedPaths) {
            $arguments = @(
                'sign', '/v', '/fd', 'SHA256', '/td', 'SHA256', '/tr', $TimestampUrl,
                '/s', 'My', '/sha1', $selected.Certificate.Thumbprint,
                '/d', "NMSA - No Man's Sky Atlas"
            )
            if ($selected.Machine) { $arguments += '/sm' }
            $arguments += $target
            & $signTool @arguments
            if ($LASTEXITCODE -ne 0) {
                throw "SignTool failed to sign '$target' (exit code $LASTEXITCODE)."
            }
        }
    }
    else {
        if ([string]::IsNullOrWhiteSpace($ArtifactSigningDlibPath) -or [string]::IsNullOrWhiteSpace($ArtifactSigningMetadataPath)) {
            throw 'ArtifactSigning requires NMSA_ARTIFACT_SIGNING_DLIB and NMSA_ARTIFACT_SIGNING_METADATA.'
        }
        $dlib = (Resolve-Path -LiteralPath $ArtifactSigningDlibPath -ErrorAction Stop).Path
        $metadataPath = (Resolve-Path -LiteralPath $ArtifactSigningMetadataPath -ErrorAction Stop).Path
        if ([IO.Path]::GetFileName($dlib) -ne 'Azure.CodeSigning.Dlib.dll') {
            throw 'NMSA_ARTIFACT_SIGNING_DLIB must point to Azure.CodeSigning.Dlib.dll.'
        }
        $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string]$metadata.Endpoint) -or [string]::IsNullOrWhiteSpace([string]$metadata.CodeSigningAccountName) -or [string]::IsNullOrWhiteSpace([string]$metadata.CertificateProfileName)) {
            throw 'Artifact Signing metadata must contain Endpoint, CodeSigningAccountName, and CertificateProfileName.'
        }
        $endpoint = $null
        if ((-not [Uri]::TryCreate([string]$metadata.Endpoint, [UriKind]::Absolute, [ref]$endpoint)) -or $endpoint.Scheme -ne 'https' -or (-not $endpoint.Host.EndsWith('.codesigning.azure.net', [StringComparison]::OrdinalIgnoreCase))) {
            throw 'Artifact Signing metadata Endpoint must be an HTTPS *.codesigning.azure.net endpoint.'
        }

        foreach ($target in $resolvedPaths) {
            & $signTool sign /v /debug /fd SHA256 /td SHA256 /tr $TimestampUrl /dlib $dlib /dmdf $metadataPath $target
            if ($LASTEXITCODE -ne 0) {
                throw "Artifact Signing failed for '$target' (exit code $LASTEXITCODE)."
            }
        }
    }
}

foreach ($target in $resolvedPaths) {
    & $signTool verify /pa /all /tw /v $target
    if ($LASTEXITCODE -ne 0) {
        throw "Signature verification failed for '$target' (exit code $LASTEXITCODE)."
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $target
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Windows reports '$target' as $($signature.Status), not Valid."
    }
    Write-Host "Verified Authenticode signature: $target"
    Write-Host "Signer: $($signature.SignerCertificate.Subject)"
}
