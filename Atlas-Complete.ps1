param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$script:Version = "3.0.6"
$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:HtmlPath = Join-Path $script:Root "NMSA.html"
$script:DataRoot = Join-Path $env:LOCALAPPDATA "Atlas Complete"
$script:BackupRoot = Join-Path $script:DataRoot "Backups"
$script:HistoryPath = Join-Path $script:DataRoot "native-history.jsonl"
$script:LogPath = Join-Path $script:DataRoot "atlas-desktop.log"
$script:FileTokens = @{}
$script:ApiVersion = 1
$script:FileTokenLifetime = [TimeSpan]::FromMinutes(30)
$script:DefaultJsonBodyLimit = 1MB
$script:InstallJsonBodyLimit = 450MB
$script:LastRequestUtc = [DateTime]::UtcNow

trap {
    $failure = "[$([DateTime]::UtcNow.ToString('o'))] $($_.Exception.ToString())"
    try { Add-Content -LiteralPath $script:LogPath -Value $failure -ErrorAction SilentlyContinue } catch { }
    if (-not $NoBrowser) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [void][Windows.Forms.MessageBox]::Show(
                "NMSA could not start.`r`n`r`n$($_.Exception.Message)`r`n`r`nDetails were saved to:`r`n$script:LogPath",
                "NMSA - No Man's Sky Atlas",
                [Windows.Forms.MessageBoxButtons]::OK,
                [Windows.Forms.MessageBoxIcon]::Error
            )
        }
        catch { }
    }
    break
}

New-Item -ItemType Directory -Path $script:DataRoot -Force | Out-Null
New-Item -ItemType Directory -Path $script:BackupRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath $script:HtmlPath -PathType Leaf)) {
    throw "NMSA.html is missing beside the portable launcher."
}

function New-RandomHex {
    param([int]$ByteCount = 32)
    $bytes = New-Object byte[] $ByteCount
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

$script:Session = New-RandomHex 32

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256Bytes {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Get-GameRunning {
    return $null -ne (Get-Process -Name "NMS" -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Get-SteamRunning {
    return $null -ne (Get-Process -Name "steam" -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Get-Status {
    return [ordered]@{
        native = $true
        version = $script:Version
        apiVersion = $script:ApiVersion
        gameRunning = [bool](Get-GameRunning)
        steamRunning = [bool](Get-SteamRunning)
        capabilities = @(
            "auto-discovery", "direct-install", "transactional-backup",
            "post-write-verification", "rollback", "xbox-containers",
            "portable-console-folders", "pc-platform-settings"
        )
    }
}

function Send-ResponseBytes {
    param(
        [System.Net.HttpListenerContext]$Context,
        [byte[]]$Bytes,
        [string]$ContentType = "application/octet-stream",
        [int]$StatusCode = 200
    )
    $Context.Response.StatusCode = $StatusCode
    $Context.Response.ContentType = $ContentType
    $Context.Response.ContentLength64 = $Bytes.Length
    $Context.Response.Headers["Cache-Control"] = "no-store"
    $Context.Response.Headers["X-Content-Type-Options"] = "nosniff"
    $Context.Response.Headers["X-Frame-Options"] = "DENY"
    $Context.Response.Headers["Referrer-Policy"] = "no-referrer"
    $Context.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin"
    try { $Context.Response.OutputStream.Write($Bytes, 0, $Bytes.Length) }
    finally { $Context.Response.OutputStream.Close() }
}

function Send-Json {
    param(
        [System.Net.HttpListenerContext]$Context,
        $Value,
        [int]$StatusCode = 200
    )
    $json = ConvertTo-Json $Value -Depth 16 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    Send-ResponseBytes $Context $bytes "application/json; charset=utf-8" $StatusCode
}

function Send-ErrorResponse {
    param(
        [System.Net.HttpListenerContext]$Context,
        [string]$Message,
        [int]$StatusCode = 400
    )
    Send-Json $Context ([ordered]@{ error = $Message }) $StatusCode
}

function Read-JsonBody {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [long]$MaxBytes = $script:DefaultJsonBodyLimit
    )
    if ($MaxBytes -lt 1) { throw "Request body limit is invalid." }
    if ($Request.ContentLength64 -gt $MaxBytes) { throw "Request body exceeds the safety limit." }
    $memory = [IO.MemoryStream]::new()
    $buffer = New-Object byte[] 65536
    [long]$total = 0
    try {
        while (($read = $Request.InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $read
            if ($total -gt $MaxBytes) { throw "Request body exceeds the safety limit." }
            $memory.Write($buffer, 0, $read)
        }
        if ($total -eq 0) { return $null }
        $text = $Request.ContentEncoding.GetString($memory.GetBuffer(), 0, [int]$total)
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return ConvertFrom-Json $text
    }
    finally { $memory.Dispose() }
}

function Test-ApiSession {
    param([System.Net.HttpListenerRequest]$Request)
    $provided = $Request.Headers["X-Atlas-Session"]
    return -not [string]::IsNullOrEmpty($provided) -and $provided -ceq $script:Session
}

function Get-FileTokenTarget {
    param([string]$Token)
    if ([string]::IsNullOrWhiteSpace($Token) -or -not $script:FileTokens.ContainsKey($Token)) {
        throw "File token expired. Scan saves again."
    }
    $target = $script:FileTokens[$Token]
    if (([DateTime]::UtcNow - [DateTime]$target.IssuedUtc) -gt $script:FileTokenLifetime) {
        $script:FileTokens.Remove($Token)
        throw "File token expired. Scan saves again."
    }
    return $target
}

function Update-FileTokenSnapshotsForPaths {
    param([string[]]$Paths)
    $snapshots = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in @($Paths)) {
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        $fullPath = [IO.Path]::GetFullPath($path)
        if ($snapshots.ContainsKey($fullPath)) { continue }
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Save file no longer exists: $([IO.Path]::GetFileName($fullPath))"
        }
        $file = Get-Item -LiteralPath $fullPath
        $sourceLength = [long]$file.Length
        $sourceLastWriteUtcTicks = [long]$file.LastWriteTimeUtc.Ticks
        $sourceSha256 = Get-Sha256 $fullPath
        $file.Refresh()
        if ([long]$file.Length -ne $sourceLength -or
            [long]$file.LastWriteTimeUtc.Ticks -ne $sourceLastWriteUtcTicks) {
            throw "A save file changed while its token was being refreshed. Scan again."
        }
        $snapshots.Add($fullPath, [PSCustomObject]@{
            Length = $sourceLength
            LastWriteUtcTicks = $sourceLastWriteUtcTicks
            Sha256 = $sourceSha256
        })
    }

    foreach ($token in @($script:FileTokens.Keys)) {
        $target = $script:FileTokens[$token]
        $fullPath = [IO.Path]::GetFullPath([string]$target.Path)
        if (-not $snapshots.ContainsKey($fullPath)) { continue }
        $snapshot = $snapshots[$fullPath]
        $target.SourceLength = [long]$snapshot.Length
        $target.SourceLastWriteUtcTicks = [long]$snapshot.LastWriteUtcTicks
        $target.SourceSha256 = [string]$snapshot.Sha256
    }
}

function Get-SafeRelativePath {
    param([string]$Root, [string]$Path)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $pathFull = [IO.Path]::GetFullPath($Path)
    if ($pathFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        return $pathFull.Substring($rootFull.Length + 1)
    }
    return [IO.Path]::GetFileName($pathFull)
}

function New-ClientFileRecord {
    param(
        [string]$Path,
        [string]$RelativePath,
        [string]$Platform,
        [string]$Root,
        [string]$ExportName = "",
        [hashtable]$Extra = @{},
        [string]$Role = ""
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $token = [Guid]::NewGuid().ToString("N")
    $file = Get-Item -LiteralPath $Path
    $sourceLength = [long]$file.Length
    $sourceLastWriteUtcTicks = [long]$file.LastWriteTimeUtc.Ticks
    $sourceSha256 = Get-Sha256 $file.FullName
    $file.Refresh()
    if ([long]$file.Length -ne $sourceLength -or [long]$file.LastWriteTimeUtc.Ticks -ne $sourceLastWriteUtcTicks) {
        throw "A save file changed while it was being scanned. Scan again."
    }
    if ([string]::IsNullOrWhiteSpace($Role)) {
        $lowerName = $file.Name.ToLowerInvariant()
        if ($Platform -eq "playstation-extracted") {
            if ($lowerName -eq "savedata00.hg") { $Role = "account" }
            elseif ($lowerName -eq "manifest00.hg") { $Role = "accountMeta" }
            elseif ($lowerName -match '^savedata\d{2}\.hg$') { $Role = "save" }
            elseif ($lowerName -match '^manifest\d{2}\.hg$') { $Role = "saveMeta" }
        }
        elseif ($Platform -eq "switch-extracted") {
            if ($lowerName -eq "accountdata.hg") { $Role = "account" }
            elseif ($lowerName -match '^savedata\d{2}\.hg$') { $Role = "save" }
            elseif ($lowerName -match '^manifest\d{2}\.hg$') { $Role = "saveMeta" }
        }
        else {
            if ($lowerName -eq "gcusersettingsdata.mxml") { $Role = "platformSettings" }
            elseif ($lowerName -match '^mf_accountdata(?:\(\d+\))?\.hg$') { $Role = "accountMeta" }
            elseif ($lowerName -match '^accountdata(?:\(\d+\))?\.hg$') { $Role = "account" }
            elseif ($lowerName -match '^mf_save\d*(?:\(\d+\))?\.hg$') { $Role = "saveMeta" }
            elseif ($lowerName -match '^save\d*(?:\(\d+\))?\.hg$') { $Role = "save" }
        }
    }
    $record = [ordered]@{
        token = $token
        name = $file.Name
        originalName = $file.Name
        exportName = $(if ($ExportName) { $ExportName } else { $file.Name })
        relativePath = $RelativePath
        size = [long]$file.Length
        lastModified = [long]([DateTimeOffset]$file.LastWriteTimeUtc).ToUnixTimeMilliseconds()
        platform = $Platform
        adapter = $Platform
        role = $Role
        native = $true
    }
    $target = [ordered]@{
        Token = $token
        Path = [IO.Path]::GetFullPath($Path)
        Root = [IO.Path]::GetFullPath($Root)
        Platform = $Platform
        Role = $Role
        Writable = $true
        IssuedUtc = [DateTime]::UtcNow
        SourceLength = $sourceLength
        SourceLastWriteUtcTicks = $sourceLastWriteUtcTicks
        SourceSha256 = $sourceSha256
        Extra = $Extra
    }
    $script:FileTokens[$token] = [PSCustomObject]$target
    return [PSCustomObject]$record
}

function Get-PcProfileFiles {
    param(
        [string]$ProfilePath,
        [string]$LabelPrefix = "",
        [string]$PlatformSettingsPath = ""
    )
    $profile = Get-Item -LiteralPath $ProfilePath
    $platform = $(if ($profile.Name -ieq "DefaultUser") { "gog" } else { "steam" })
    $records = New-Object Collections.ArrayList
    $prefix = $(if ($LabelPrefix) { "$LabelPrefix/$($profile.Name)" } else { $profile.Name })
    $files = Get-ChildItem -LiteralPath $ProfilePath -File -Filter "*.hg" -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        $relative = "$prefix/$($file.Name)"
        $entry = New-ClientFileRecord $file.FullName $relative $platform $ProfilePath
        if ($null -ne $entry) { [void]$records.Add($entry) }
    }
    if (-not [string]::IsNullOrWhiteSpace($PlatformSettingsPath) -and
        (Test-Path -LiteralPath $PlatformSettingsPath -PathType Leaf)) {
        $extra = @{ ProfilePath = [IO.Path]::GetFullPath($ProfilePath) }
        $entry = New-ClientFileRecord $PlatformSettingsPath "$prefix/GCUSERSETTINGSDATA.MXML" $platform $ProfilePath "GCUSERSETTINGSDATA.MXML" $extra "platformSettings"
        if ($null -ne $entry) { [void]$records.Add($entry) }
    }
    return @($records)
}

function Get-PortableFolderFiles {
    param([string]$FolderPath, [string]$PlatformSettingsPath = "")
    $hasAccount = Test-Path -LiteralPath (Join-Path $FolderPath "accountdata.hg")
    $hasSavedata = $null -ne (Get-ChildItem -LiteralPath $FolderPath -File -Filter "savedata*.hg" -ErrorAction SilentlyContinue | Select-Object -First 1)
    $folderName = [IO.Path]::GetFileName($FolderPath)
    $platform = $(if ($hasSavedata -and -not $hasAccount) {
        "playstation-extracted"
    } elseif ($hasSavedata) {
        "switch-extracted"
    } elseif ($folderName -ieq "DefaultUser") {
        "gog"
    } else {
        "steam"
    })
    $records = New-Object Collections.ArrayList
    $files = Get-ChildItem -LiteralPath $FolderPath -File -Filter "*.hg" -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        $entry = New-ClientFileRecord $file.FullName "$folderName/$($file.Name)" $platform $FolderPath
        if ($null -ne $entry) { [void]$records.Add($entry) }
    }
    if (($platform -eq "steam" -or $platform -eq "gog")) {
        $settingsPath = $PlatformSettingsPath
        if ([string]::IsNullOrWhiteSpace($settingsPath)) {
            $settingsPath = Join-Path $FolderPath "GCUSERSETTINGSDATA.MXML"
        }
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
            $extra = @{ ProfilePath = [IO.Path]::GetFullPath($FolderPath) }
            $entry = New-ClientFileRecord $settingsPath "$folderName/GCUSERSETTINGSDATA.MXML" $platform $FolderPath "GCUSERSETTINGSDATA.MXML" $extra "platformSettings"
            if ($null -ne $entry) { [void]$records.Add($entry) }
        }
    }
    return @($records)
}

function Read-Int32LE {
    param([byte[]]$Bytes, [int]$Offset)
    return [BitConverter]::ToInt32($Bytes, $Offset)
}

function Read-Int64LE {
    param([byte[]]$Bytes, [int]$Offset)
    return [BitConverter]::ToInt64($Bytes, $Offset)
}

function Copy-NumberBytes {
    param([byte[]]$Target, [int]$Offset, [byte[]]$ValueBytes)
    [Array]::Copy($ValueBytes, 0, $Target, $Offset, $ValueBytes.Length)
}

function Read-DynamicUtf16String {
    param([byte[]]$Bytes, [int]$Offset)
    if ($Offset + 4 -gt $Bytes.Length) {
        return [PSCustomObject]@{ Value = ""; NextOffset = $Bytes.Length }
    }
    $length = Read-Int32LE $Bytes $Offset
    if ($length -le 0) {
        return [PSCustomObject]@{ Value = ""; NextOffset = ($Offset + 4) }
    }
    $byteLength = $length * 2
    if ($Offset + 4 + $byteLength -gt $Bytes.Length) {
        throw "Truncated UTF-16 string in containers.index."
    }
    $value = [Text.Encoding]::Unicode.GetString($Bytes, $Offset + 4, $byteLength)
    return [PSCustomObject]@{ Value = $value; NextOffset = ($Offset + 4 + $byteLength) }
}

function Convert-GuidBytes {
    param([byte[]]$Bytes, [int]$Offset)
    $guidBytes = New-Object byte[] 16
    [Array]::Copy($Bytes, $Offset, $guidBytes, 0, 16)
    return [Guid]::new($guidBytes)
}

function Resolve-XboxGuidPath {
    param([string]$Directory, [Guid]$Guid)
    $candidates = @(
        (Join-Path $Directory ($Guid.ToString("N").ToUpperInvariant())),
        (Join-Path $Directory ($Guid.ToString("N").ToLowerInvariant())),
        (Join-Path $Directory ($Guid.ToString("D")))
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $candidates[0]
}

function Read-XboxBlobContainer {
    param([string]$BlobDirectory)
    $result = [ordered]@{ DataPath = $null; MetaPath = $null }
    if (-not (Test-Path -LiteralPath $BlobDirectory -PathType Container)) { return [PSCustomObject]$result }
    $containers = Get-ChildItem -LiteralPath $BlobDirectory -File -Filter "container.*" -ErrorAction SilentlyContinue |
        Sort-Object { [int]($_.Extension.TrimStart('.')) } -Descending
    foreach ($container in $containers) {
        $bytes = [IO.File]::ReadAllBytes($container.FullName)
        if ($bytes.Length -ne 328 -or (Read-Int32LE $bytes 0) -ne 4) { continue }
        $count = Read-Int32LE $bytes 4
        $offset = 8
        for ($index = 0; $index -lt $count; $index++) {
            if ($offset + 160 -gt $bytes.Length) { break }
            $identifier = [Text.Encoding]::Unicode.GetString($bytes, $offset, 128).Trim([char]0)
            $offset += 128
            $offset += 16
            $localGuid = Convert-GuidBytes $bytes $offset
            $offset += 16
            $blobPath = Resolve-XboxGuidPath $BlobDirectory $localGuid
            if ($identifier.StartsWith("data", [StringComparison]::OrdinalIgnoreCase)) { $result.DataPath = $blobPath }
            elseif ($identifier.StartsWith("meta", [StringComparison]::OrdinalIgnoreCase)) { $result.MetaPath = $blobPath }
        }
        if ($result.DataPath -and (Test-Path -LiteralPath $result.DataPath)) { break }
    }
    return [PSCustomObject]$result
}

function Parse-XboxContainerIndex {
    param([string]$IndexPath)
    $bytes = [IO.File]::ReadAllBytes($IndexPath)
    if ($bytes.Length -lt 200 -or (Read-Int32LE $bytes 0) -ne 14) {
        throw "Invalid Xbox containers.index header."
    }
    $count = Read-Int64LE $bytes 4
    if ($count -lt 0 -or $count -gt 1000) { throw "Invalid Xbox container count." }
    $offset = 12
    $process = Read-DynamicUtf16String $bytes $offset
    $offset = $process.NextOffset
    $globalLastWriteOffset = $offset
    $globalSyncOffset = $offset + 8
    $offset += 12
    $account = Read-DynamicUtf16String $bytes $offset
    $offset = $account.NextOffset + 8
    $baseDirectory = Split-Path -Parent $IndexPath
    $slots = New-Object Collections.ArrayList

    for ($index = 0; $index -lt $count; $index++) {
        if ($offset -ge $bytes.Length) { break }
        $first = Read-DynamicUtf16String $bytes $offset
        $offset = $first.NextOffset
        $second = Read-DynamicUtf16String $bytes $offset
        $offset = $second.NextOffset
        $syncTime = Read-DynamicUtf16String $bytes $offset
        $offset = $syncTime.NextOffset
        if ($offset + 45 -gt $bytes.Length) { break }
        $fixedOffset = $offset
        $directoryGuid = Convert-GuidBytes $bytes ($offset + 5)
        $lastModifiedFileTime = Read-Int64LE $bytes ($offset + 21)
        $offset += 45
        $blobDirectory = Resolve-XboxGuidPath $baseDirectory $directoryGuid
        $blob = Read-XboxBlobContainer $blobDirectory
        $lastModified = [DateTime]::UtcNow
        try { $lastModified = [DateTime]::FromFileTimeUtc($lastModifiedFileTime) } catch { }
        $slot = [ordered]@{
            Identifier = $first.Value
            SecondIdentifier = $second.Value
            DirectoryGuid = $directoryGuid.ToString("N")
            BlobDirectory = $blobDirectory
            DataPath = $blob.DataPath
            MetaPath = $blob.MetaPath
            LastModified = $lastModified
            LastModifiedOffset = $fixedOffset + 21
            TotalSizeOffset = $fixedOffset + 37
            SyncStateOffset = $fixedOffset + 1
            GlobalLastWriteOffset = $globalLastWriteOffset
            GlobalSyncOffset = $globalSyncOffset
        }
        [void]$slots.Add([PSCustomObject]$slot)
    }
    return @($slots)
}

function New-XboxRecord {
    param(
        $Slot,
        [string]$Kind,
        [string]$Path,
        [string]$IndexPath,
        [string]$ExportName
    )
    $extra = @{
        IndexPath = [IO.Path]::GetFullPath($IndexPath)
        SlotIdentifier = $Slot.Identifier
        Kind = $Kind
        LastModifiedOffset = [int]$Slot.LastModifiedOffset
        TotalSizeOffset = [int]$Slot.TotalSizeOffset
        SyncStateOffset = [int]$Slot.SyncStateOffset
        GlobalLastWriteOffset = [int]$Slot.GlobalLastWriteOffset
        GlobalSyncOffset = [int]$Slot.GlobalSyncOffset
    }
    $relative = "Xbox/$($Slot.Identifier)/$([IO.Path]::GetFileName($Path))"
    return New-ClientFileRecord $Path $relative "xbox-game-pass" (Split-Path -Parent $IndexPath) $ExportName $extra $Kind
}

function Get-XboxSets {
    param([string]$IndexPath)
    $slots = Parse-XboxContainerIndex $IndexPath
    $accountSlot = $slots | Where-Object { $_.Identifier -ieq "AccountData" } | Select-Object -First 1
    if ($null -eq $accountSlot -or -not $accountSlot.DataPath) { return @() }
    $accountData = New-XboxRecord $accountSlot "account" $accountSlot.DataPath $IndexPath "AccountData-data.blob"
    $accountMeta = $(if ($accountSlot.MetaPath) { New-XboxRecord $accountSlot "accountMeta" $accountSlot.MetaPath $IndexPath "AccountData-meta.blob" } else { $null })
    $sets = New-Object Collections.ArrayList
    foreach ($slot in $slots) {
        if ($slot.Identifier -notmatch '^Slot(\d+)(Auto|Manual)') { continue }
        $slotNumber = [int]$Matches[1]
        $snapshot = $Matches[2]
        $missing = New-Object Collections.ArrayList
        if (-not $slot.DataPath) { [void]$missing.Add("data blob") }
        if (-not $slot.MetaPath) { [void]$missing.Add("meta blob") }
        if ($null -eq $accountData) { [void]$missing.Add("AccountData") }
        if ($null -eq $accountMeta) { [void]$missing.Add("AccountData metadata") }
        $saveData = $(if ($slot.DataPath) { New-XboxRecord $slot "save" $slot.DataPath $IndexPath "$($slot.Identifier)-data.blob" } else { $null })
        $saveMeta = $(if ($slot.MetaPath) { New-XboxRecord $slot "saveMeta" $slot.MetaPath $IndexPath "$($slot.Identifier)-meta.blob" } else { $null })
        $storageOrdinal = (($slotNumber - 1) * 2) + $(if ($snapshot -eq "Auto") { 1 } else { 2 })
        $set = [ordered]@{
            id = "xbox|$([IO.Path]::GetFileName((Split-Path -Parent $IndexPath)))|$($slot.Identifier)"
            adapter = "xbox-game-pass"
            platform = "xbox-game-pass"
            directory = "Xbox/$([IO.Path]::GetFileName((Split-Path -Parent $IndexPath)))"
            profileName = "Xbox Game Pass"
            logicalSlot = $slotNumber
            storageOrdinal = $storageOrdinal
            save = $saveData
            saveMeta = $saveMeta
            account = $accountData
            accountMeta = $accountMeta
            missing = @($missing)
            complete = ($missing.Count -eq 0)
        }
        [void]$sets.Add([PSCustomObject]$set)
    }
    return @($sets)
}

function Find-XboxIndexFiles {
    $results = New-Object Collections.ArrayList
    $packages = Join-Path $env:LOCALAPPDATA "Packages"
    if (-not (Test-Path -LiteralPath $packages -PathType Container)) { return @() }
    $nmsPackages = Get-ChildItem -LiteralPath $packages -Directory -Filter "HelloGames*" -ErrorAction SilentlyContinue
    foreach ($package in $nmsPackages) {
        $wgs = Join-Path $package.FullName "SystemAppData\wgs"
        if (-not (Test-Path -LiteralPath $wgs -PathType Container)) { continue }
        $indexes = Get-ChildItem -LiteralPath $wgs -File -Filter "containers.index" -Recurse -ErrorAction SilentlyContinue
        foreach ($index in $indexes) { [void]$results.Add($index.FullName) }
    }
    return @($results)
}

function Get-RegistryString {
    param([string[]]$Paths, [string[]]$Names)
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path -ErrorAction SilentlyContinue)) { continue }
        try {
            $item = Get-ItemProperty -LiteralPath $path -ErrorAction Stop
            foreach ($name in $Names) {
                $value = [string]$item.$name
                if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
            }
        }
        catch { }
    }
    return ""
}

function Get-SteamLibraryRoots {
    $roots = New-Object Collections.ArrayList
    $candidates = New-Object Collections.ArrayList
    $registryPath = Get-RegistryString @(
        "HKCU:\Software\Valve\Steam",
        "HKLM:\Software\Valve\Steam",
        "HKLM:\Software\WOW6432Node\Valve\Steam"
    ) @("SteamPath", "InstallPath")
    if ($registryPath) { [void]$candidates.Add($registryPath) }
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} "Steam"))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        [void]$candidates.Add((Join-Path $env:ProgramFiles "Steam"))
    }

    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
        [void]$roots.Add([IO.Path]::GetFullPath($candidate))
        $librariesPath = Join-Path $candidate "steamapps\libraryfolders.vdf"
        if (-not (Test-Path -LiteralPath $librariesPath -PathType Leaf)) { continue }
        try {
            $text = Get-Content -LiteralPath $librariesPath -Raw
            $matches = @([regex]::Matches($text, '"path"\s+"([^"]+)"')) +
                @([regex]::Matches($text, '"\d+"\s+"([A-Za-z]:\\[^"]+)"'))
            foreach ($match in $matches) {
                $library = $match.Groups[1].Value.Replace("\\", "\")
                if (Test-Path -LiteralPath $library -PathType Container) {
                    [void]$roots.Add([IO.Path]::GetFullPath($library))
                }
            }
        }
        catch { }
    }
    return @($roots | Select-Object -Unique)
}

function Find-SteamPlatformSettings {
    $installLocation = Get-RegistryString @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 275850",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 275850",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 275850"
    ) @("InstallLocation")
    if ($installLocation) {
        $direct = Join-Path $installLocation "Binaries\SETTINGS\GCUSERSETTINGSDATA.MXML"
        if (Test-Path -LiteralPath $direct -PathType Leaf) { return [IO.Path]::GetFullPath($direct) }
    }

    foreach ($library in @(Get-SteamLibraryRoots)) {
        $steamApps = Join-Path $library "steamapps"
        $installDirectory = "No Man's Sky"
        $manifest = Join-Path $steamApps "appmanifest_275850.acf"
        if (Test-Path -LiteralPath $manifest -PathType Leaf) {
            try {
                $text = Get-Content -LiteralPath $manifest -Raw
                $match = [regex]::Match($text, '"installdir"\s+"([^"]+)"')
                if ($match.Success) { $installDirectory = $match.Groups[1].Value }
            }
            catch { }
        }
        $candidate = Join-Path $steamApps "common\$installDirectory\Binaries\SETTINGS\GCUSERSETTINGSDATA.MXML"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }
    return ""
}

function Find-GogPlatformSettings {
    $gameRoots = @(
        "HKLM:\Software\GOG.com\Games",
        "HKLM:\Software\WOW6432Node\GOG.com\Games",
        "HKCU:\Software\GOG.com\Games"
    )
    foreach ($root in $gameRoots) {
        if (-not (Test-Path -LiteralPath $root -ErrorAction SilentlyContinue)) { continue }
        foreach ($game in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            try {
                $item = Get-ItemProperty -LiteralPath $game.PSPath -ErrorAction Stop
                $name = [string]$item.gameName
                if ([string]::IsNullOrWhiteSpace($name)) { $name = [string]$item.name }
                if ($name -notlike "*No Man's Sky*") { continue }
                $location = [string]$item.path
                if ([string]::IsNullOrWhiteSpace($location)) { $location = [string]$item.installLocation }
                if ([string]::IsNullOrWhiteSpace($location)) { continue }
                $candidate = Join-Path $location "Binaries\SETTINGS\GCUSERSETTINGSDATA.MXML"
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
            }
            catch { }
        }
    }
    return ""
}

function Find-PcPlatformSettings {
    return [PSCustomObject][ordered]@{
        Steam = Find-SteamPlatformSettings
        Gog = Find-GogPlatformSettings
    }
}

function Get-InstalledDiscovery {
    $script:FileTokens = @{}
    $files = New-Object Collections.ArrayList
    $xboxSets = New-Object Collections.ArrayList
    $warnings = New-Object Collections.ArrayList
    $pcSettings = Find-PcPlatformSettings
    $pcRoot = Join-Path $env:APPDATA "HelloGames\NMS"
    if (Test-Path -LiteralPath $pcRoot -PathType Container) {
        $profiles = Get-ChildItem -LiteralPath $pcRoot -Directory -ErrorAction SilentlyContinue
        foreach ($profile in $profiles) {
            $settingsPath = $(if ($profile.Name -ieq "DefaultUser") { $pcSettings.Gog } else { $pcSettings.Steam })
            foreach ($record in @(Get-PcProfileFiles $profile.FullName "" $settingsPath)) { [void]$files.Add($record) }
        }
    }
    foreach ($indexPath in @(Find-XboxIndexFiles)) {
        try {
            foreach ($set in @(Get-XboxSets $indexPath)) { [void]$xboxSets.Add($set) }
        }
        catch { [void]$warnings.Add("Xbox profile could not be indexed: $($_.Exception.Message)") }
    }
    if (Get-SteamRunning) {
        [void]$warnings.Add("Steam is running. Atlas will still refuse installation while No Man's Sky is open; Steam Cloud may ask which copy to keep after an edit.")
    }
    $hasSteamProfile = $null -ne ($files | Where-Object { $_.platform -eq "steam" } | Select-Object -First 1)
    $hasGogProfile = $null -ne ($files | Where-Object { $_.platform -eq "gog" } | Select-Object -First 1)
    if ($hasSteamProfile -and [string]::IsNullOrWhiteSpace($pcSettings.Steam)) {
        [void]$warnings.Add("Steam GCUSERSETTINGSDATA.MXML was not found. Boltcaster SM, Photonix Core, and X.O. Helmet account entitlements require this file; reward writes will be blocked until it is detected.")
    }
    if ($hasGogProfile -and [string]::IsNullOrWhiteSpace($pcSettings.Gog)) {
        [void]$warnings.Add("GOG GCUSERSETTINGSDATA.MXML was not found. Boltcaster SM, Photonix Core, and X.O. Helmet account entitlements require this file; reward writes will be blocked until it is detected.")
    }
    if ($files.Count -eq 0 -and $xboxSets.Count -eq 0) {
        [void]$warnings.Add("No installed Steam, GOG or Xbox save profile was found in the standard Windows locations.")
    }
    return [ordered]@{
        files = @($files)
        xboxSets = @($xboxSets)
        warnings = @($warnings)
        status = Get-Status
    }
}

function Get-FolderDiscovery {
    param([string]$FolderPath)
    $script:FileTokens = @{}
    $indexPath = Join-Path $FolderPath "containers.index"
    if (Test-Path -LiteralPath $indexPath -PathType Leaf) {
        return [ordered]@{
            files = @()
            xboxSets = @(Get-XboxSets $indexPath)
            warnings = @("This Xbox container was loaded manually. Automatic writes remain transactional and local.")
            status = Get-Status
            label = [IO.Path]::GetFileName($FolderPath)
            cancelled = $false
        }
    }
    $pcSettings = Find-PcPlatformSettings
    $hasNestedProfiles = $null -ne (Get-ChildItem -LiteralPath $FolderPath -Directory -ErrorAction SilentlyContinue | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.FullName "accountdata.hg")
    } | Select-Object -First 1)
    $records = New-Object Collections.ArrayList
    if ($hasNestedProfiles) {
        $profiles = Get-ChildItem -LiteralPath $FolderPath -Directory -ErrorAction SilentlyContinue
        foreach ($profile in $profiles) {
            if (Test-Path -LiteralPath (Join-Path $profile.FullName "accountdata.hg")) {
                $settingsPath = $(if ($profile.Name -ieq "DefaultUser") { $pcSettings.Gog } else { $pcSettings.Steam })
                foreach ($record in @(Get-PcProfileFiles $profile.FullName ([IO.Path]::GetFileName($FolderPath)) $settingsPath)) { [void]$records.Add($record) }
            }
        }
    }
    else {
        $profileName = [IO.Path]::GetFileName($FolderPath)
        $platformSettingsPath = ""
        $pcSaveRoot = [IO.Path]::GetFullPath((Join-Path $env:APPDATA "HelloGames\NMS"))
        $selectedFullPath = [IO.Path]::GetFullPath($FolderPath)
        if ($selectedFullPath.StartsWith($pcSaveRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            $platformSettingsPath = $(if ($profileName -ieq "DefaultUser") { $pcSettings.Gog } else { $pcSettings.Steam })
        }
        foreach ($record in @(Get-PortableFolderFiles $FolderPath $platformSettingsPath)) { [void]$records.Add($record) }
    }
    return [ordered]@{
        files = @($records)
        xboxSets = @()
        warnings = @()
        status = Get-Status
        label = [IO.Path]::GetFileName($FolderPath)
        cancelled = $false
    }
}

function New-BackupForPaths {
    param([string[]]$Paths, [string]$Platform, [string]$Reason = "install")
    $uniquePaths = @($Paths | ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique)
    $id = "atlas-" + [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmssfff") + "-" + ([Guid]::NewGuid().ToString("N").Substring(0, 8))
    $directory = Join-Path $script:BackupRoot $id
    $filesDirectory = Join-Path $directory "files"
    New-Item -ItemType Directory -Path $filesDirectory -Force | Out-Null
    $entries = New-Object Collections.ArrayList
    $index = 0
    foreach ($path in $uniquePaths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Backup target is missing: $path" }
        $backupName = $index.ToString("D3") + ".bin"
        $backupPath = Join-Path $filesDirectory $backupName
        Copy-Item -LiteralPath $path -Destination $backupPath -Force
        $entry = [ordered]@{
            targetPath = $path
            backupFile = "files/$backupName"
            originalSha256 = Get-Sha256 $path
            size = [long](Get-Item -LiteralPath $path).Length
        }
        [void]$entries.Add([PSCustomObject]$entry)
        $index++
    }
    $manifest = [ordered]@{
        backupId = $id
        createdAt = [DateTime]::UtcNow.ToString("o")
        platform = $Platform
        platformLabel = $(switch ($Platform) {
            "steam" { "Steam" }
            "gog" { "GOG" }
            "xbox-game-pass" { "Xbox Game Pass" }
            "playstation-extracted" { "Extracted PlayStation" }
            "switch-extracted" { "Extracted Nintendo Switch" }
            default { "No Man's Sky" }
        })
        reason = $Reason
        fileCount = $entries.Count
        files = @($entries)
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory "backup.json") -Encoding UTF8
    return [PSCustomObject]$manifest
}

function Move-FileIntoPlace {
    param([string]$TemporaryPath, [string]$TargetPath)
    if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
        [IO.File]::Move($TemporaryPath, $TargetPath)
        return
    }
    try {
        [IO.File]::Replace($TemporaryPath, $TargetPath, $null, $true)
        return
    }
    catch {
        # File.Replace is unavailable on some removable/extracted-save volumes.
        # Keep the previous file beside the target until the new file is in place.
        $previous = $TargetPath + ".atlas-previous-" + [Guid]::NewGuid().ToString("N") + ".tmp"
        [IO.File]::Move($TargetPath, $previous)
        try {
            [IO.File]::Move($TemporaryPath, $TargetPath)
            Remove-Item -LiteralPath $previous -Force
        }
        catch {
            if (Test-Path -LiteralPath $TargetPath) { Remove-Item -LiteralPath $TargetPath -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $previous) { [IO.File]::Move($previous, $TargetPath) }
            throw
        }
    }
}

function Restore-BackupManifest {
    param($Manifest, [string]$Directory)
    $prepared = New-Object Collections.ArrayList
    try {
        foreach ($entry in @($Manifest.files)) {
            $source = Join-Path $Directory ($entry.backupFile -replace '/', [IO.Path]::DirectorySeparatorChar)
            $target = [IO.Path]::GetFullPath([string]$entry.targetPath)
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Backup file is missing: $source" }
            if ((Get-Sha256 $source) -ne [string]$entry.originalSha256) { throw "Backup hash failed for $source" }
            $temp = $target + ".atlas-restore-" + [Guid]::NewGuid().ToString("N") + ".tmp"
            Copy-Item -LiteralPath $source -Destination $temp -Force
            [void]$prepared.Add([PSCustomObject]@{ Temp = $temp; Target = $target; Hash = [string]$entry.originalSha256 })
        }
        foreach ($item in $prepared) {
            Move-FileIntoPlace $item.Temp $item.Target
        }
        foreach ($item in $prepared) {
            if ((Get-Sha256 $item.Target) -ne $item.Hash) { throw "Restored file failed verification: $($item.Target)" }
        }
    }
    finally {
        foreach ($item in $prepared) {
            if (Test-Path -LiteralPath $item.Temp) { Remove-Item -LiteralPath $item.Temp -Force -ErrorAction SilentlyContinue }
        }
    }
    return $prepared.Count
}

function Update-XboxIndexes {
    param($TargetRecords)
    $indexGroups = @($TargetRecords | Where-Object { $_.Extra.IndexPath } | Group-Object { $_.Extra.IndexPath })
    foreach ($indexGroup in $indexGroups) {
        $indexPath = [string]$indexGroup.Name
        $bytes = [IO.File]::ReadAllBytes($indexPath)
        $nowFileTime = [DateTime]::UtcNow.ToFileTimeUtc()
        $first = $indexGroup.Group | Select-Object -First 1
        Copy-NumberBytes $bytes ([int]$first.Extra.GlobalLastWriteOffset) ([BitConverter]::GetBytes([long]$nowFileTime))
        Copy-NumberBytes $bytes ([int]$first.Extra.GlobalSyncOffset) ([BitConverter]::GetBytes([int]2))
        $slotGroups = @($indexGroup.Group | Group-Object { $_.Extra.SlotIdentifier })
        foreach ($slotGroup in $slotGroups) {
            $slotFirst = $slotGroup.Group | Select-Object -First 1
            $totalSize = [long]0
            foreach ($record in $slotGroup.Group) {
                if (Test-Path -LiteralPath $record.Path) { $totalSize += [long](Get-Item -LiteralPath $record.Path).Length }
            }
            Copy-NumberBytes $bytes ([int]$slotFirst.Extra.LastModifiedOffset) ([BitConverter]::GetBytes([long]$nowFileTime))
            Copy-NumberBytes $bytes ([int]$slotFirst.Extra.SyncStateOffset) ([BitConverter]::GetBytes([int]2))
            Copy-NumberBytes $bytes ([int]$slotFirst.Extra.TotalSizeOffset) ([BitConverter]::GetBytes([long]$totalSize))
        }
        $temp = $indexPath + ".atlas-index-" + [Guid]::NewGuid().ToString("N") + ".tmp"
        [IO.File]::WriteAllBytes($temp, $bytes)
        Move-FileIntoPlace $temp $indexPath
    }
}

function Test-PlatformSettingsBytes {
    param([byte[]]$Bytes, [string[]]$ExpectedRewards)
    if ($Bytes.Length -gt 10MB -or $ExpectedRewards.Count -eq 0) { return $false }
    $stream = [IO.MemoryStream]::new($Bytes, $false)
    try {
        $document = [System.Xml.XmlDocument]::new()
        $document.PreserveWhitespace = $true
        $document.XmlResolver = $null
        $document.Load($stream)
        $actual = @{}
        foreach ($node in @($document.SelectNodes("//Property[@name='UnlockedPlatformRewards' and @value]"))) {
            $value = [string]$node.GetAttribute("value")
            if (-not $value.StartsWith("^")) { $value = "^" + $value }
            $actual[$value.ToUpperInvariant()] = $true
        }
        foreach ($reward in $ExpectedRewards) {
            if (-not $actual.ContainsKey(([string]$reward).ToUpperInvariant())) { return $false }
        }
        return $true
    }
    catch { return $false }
    finally { $stream.Dispose() }
}

function Test-MatchingSaveMetadataTarget {
    param($SaveTarget, $MetadataTarget, [string]$Platform)
    if ($Platform -in @("steam", "gog")) {
        $expected = "mf_$([IO.Path]::GetFileName([string]$SaveTarget.Path))"
        return [string]::Equals(
            [IO.Path]::GetFileName([string]$MetadataTarget.Path),
            $expected,
            [StringComparison]::OrdinalIgnoreCase
        )
    }
    if ($Platform -in @("playstation-extracted", "switch-extracted")) {
        $saveMatch = [regex]::Match([IO.Path]::GetFileName([string]$SaveTarget.Path), '^savedata(\d{2})\.hg$', 'IgnoreCase')
        $metadataMatch = [regex]::Match([IO.Path]::GetFileName([string]$MetadataTarget.Path), '^manifest(\d{2})\.hg$', 'IgnoreCase')
        return $saveMatch.Success -and $metadataMatch.Success -and $saveMatch.Groups[1].Value -ceq $metadataMatch.Groups[1].Value
    }
    return [string]$SaveTarget.Extra.SlotIdentifier -ceq [string]$MetadataTarget.Extra.SlotIdentifier
}

function Assert-MatchedSavePointTargets {
    param($Targets, [string]$Platform)
    $saves = @($Targets | Where-Object { $_.Role -eq "save" })
    $metadata = @($Targets | Where-Object { $_.Role -eq "saveMeta" })
    if ($saves.Count -ne 1 -or $metadata.Count -ne 1) {
        throw "Installation requires exactly one save data file and its matching metadata file."
    }
    foreach ($save in $saves) {
        $matches = @($metadata | Where-Object { Test-MatchingSaveMetadataTarget $save $_ $Platform })
        if ($matches.Count -ne 1) {
            throw "Installation save metadata does not match its verified snapshot."
        }
    }
}

function Assert-SourcesUnchanged {
    param($Targets)
    foreach ($target in $Targets) {
        if (-not (Test-Path -LiteralPath $target.Path -PathType Leaf)) {
            throw "$([IO.Path]::GetFileName([string]$target.Path)) no longer exists. Scan your saves again."
        }
        $file = Get-Item -LiteralPath $target.Path
        if ([long]$file.Length -ne [long]$target.SourceLength -or
            [long]$file.LastWriteTimeUtc.Ticks -ne [long]$target.SourceLastWriteUtcTicks -or
            (Get-Sha256 $target.Path) -cne [string]$target.SourceSha256) {
            throw "$($file.Name) changed after it was scanned. No files were replaced; scan your saves again."
        }
    }
}

function Install-Transaction {
    param($Payload)
    if (Get-GameRunning) { throw "No Man's Sky is running. Fully close it before installation." }
    $requested = @($Payload.files)
    if ($requested.Count -lt 2 -or $requested.Count -gt 4) {
        throw "Installation requires one save data file, its matching metadata, and only required account companions."
    }
    if ($null -eq $Payload.report) { throw "Installation is missing its verified completion report." }
    $seen = @{}
    $targets = New-Object Collections.ArrayList
    foreach ($file in $requested) {
        $token = [string]$file.token
        if ([string]::IsNullOrWhiteSpace($token) -or $seen.ContainsKey($token)) { throw "Installation contains a missing or duplicate target token." }
        $seen[$token] = $true
        $target = Get-FileTokenTarget $token
        if (-not $target.Writable) { throw "A selected target is read-only." }
        if ([string]$file.role -cne [string]$target.Role) { throw "An installation file does not match its verified target role." }
        [void]$targets.Add($target)
    }
    $roots = @($targets | ForEach-Object { $_.Root } | Select-Object -Unique)
    if ($roots.Count -ne 1) { throw "Save and account files are not from the same verified profile." }
    $platforms = @($targets | ForEach-Object { $_.Platform } | Select-Object -Unique)
    if ($platforms.Count -ne 1) { throw "Installation mixes platform adapters." }
    if (-not (@("steam", "gog") -contains $platforms[0])) {
        throw "Writing this platform format is disabled until its native container can be preserved exactly. Analysis remains available."
    }
    if ([string]$Payload.report.platform -cne [string]$platforms[0]) { throw "Installation report does not match the target platform." }
    $platformSettingsRequired = [bool]$Payload.report.platformSettingsRequired
    $accountChanged = [bool]$Payload.report.verification.accountChanged
    $platformSettingsChanged = [bool]$Payload.report.verification.platformSettingsChanged
    $templateOperation = [string]$Payload.report.operation -ceq "save-template"
    if ($platformSettingsRequired -and -not (@("steam", "gog") -contains $platforms[0])) {
        throw "Platform settings were requested for a platform that does not use them."
    }
    if (-not [bool]$Payload.report.verification.semantic -or
        -not [bool]$Payload.report.verification.metadata -or
        -not [bool]$Payload.report.verification.protectedMetadataFieldsPreserved -or
        -not [bool]$Payload.report.verification.inactiveContextPreserved -or
        ($platformSettingsRequired -and -not [bool]$Payload.report.verification.platformSettings) -or
        ($templateOperation -and -not [bool]$Payload.report.verification.templateState)) {
        throw "The browser did not provide a complete verified output report."
    }
    Assert-MatchedSavePointTargets $targets $platforms[0]
    $actualRoles = @($targets | ForEach-Object { [string]$_.Role } | Sort-Object)
    $expectedRoles = @("save", "saveMeta")
    if ($accountChanged) {
        $expectedRoles += "account"
        if (@("playstation-extracted", "xbox-game-pass") -contains $platforms[0]) {
            $expectedRoles += "accountMeta"
        }
    }
    if ($platformSettingsChanged) { $expectedRoles += "platformSettings" }
    if (($actualRoles -join "|") -cne (($expectedRoles | Sort-Object) -join "|")) {
        throw "Installation targets are not one complete save/account companion set."
    }
    $additionalPaths = @($targets | Where-Object { $_.Extra.IndexPath } | ForEach-Object { $_.Extra.IndexPath } | Select-Object -Unique)
    $backupPaths = @($targets | ForEach-Object { $_.Path }) + $additionalPaths
    Assert-SourcesUnchanged $targets
    $backup = New-BackupForPaths $backupPaths $platforms[0] "install"
    $backupDirectory = Join-Path $script:BackupRoot $backup.backupId
    $prepared = New-Object Collections.ArrayList
    $commitStarted = $false
    try {
        for ($index = 0; $index -lt $requested.Count; $index++) {
            $requestFile = $requested[$index]
            $target = $targets[$index]
            $bytes = [Convert]::FromBase64String([string]$requestFile.bytesBase64)
            if ($bytes.Length -gt 100MB) { throw "One output file exceeds the safety limit." }
            if ($target.Role -eq "platformSettings" -and
                -not (Test-PlatformSettingsBytes $bytes @($Payload.report.platformRewards))) {
                throw "PC platform settings failed XML or reward verification."
            }
            $hash = Get-Sha256Bytes $bytes
            if ($hash -ne ([string]$requestFile.sha256).ToLowerInvariant()) { throw "Output hash does not match the verified browser result." }
            $temp = $target.Path + ".atlas-write-" + [Guid]::NewGuid().ToString("N") + ".tmp"
            [IO.File]::WriteAllBytes($temp, $bytes)
            if ((Get-Sha256 $temp) -ne $hash) { throw "Temporary output failed verification." }
            [void]$prepared.Add([PSCustomObject]@{ Temp = $temp; Target = $target; Hash = $hash })
        }
        Assert-SourcesUnchanged $targets
        $commitStarted = $true
        foreach ($item in $prepared) {
            Move-FileIntoPlace $item.Temp $item.Target.Path
        }
        if ($platforms[0] -eq "xbox-game-pass") { Update-XboxIndexes @($targets) }
        foreach ($item in $prepared) {
            if ((Get-Sha256 $item.Target.Path) -ne $item.Hash) { throw "Installed file failed post-write verification: $($item.Target.Path)" }
        }
        Update-FileTokenSnapshotsForPaths @($prepared | ForEach-Object { [string]$_.Target.Path })
    }
    catch {
        if ($commitStarted) {
            $manifest = Get-Content -LiteralPath (Join-Path $backupDirectory "backup.json") -Raw | ConvertFrom-Json
            [void](Restore-BackupManifest $manifest $backupDirectory)
            Update-FileTokenSnapshotsForPaths @($manifest.files | ForEach-Object { [string]$_.targetPath })
            throw "Installation failed and the original files were restored: $($_.Exception.Message)"
        }
        throw "Installation stopped before any save file was replaced: $($_.Exception.Message)"
    }
    finally {
        foreach ($item in $prepared) {
            if (Test-Path -LiteralPath $item.Temp) { Remove-Item -LiteralPath $item.Temp -Force -ErrorAction SilentlyContinue }
        }
    }
    $history = [ordered]@{
        generatedAt = [DateTime]::UtcNow.ToString("o")
        backupId = $backup.backupId
        platform = $platforms[0]
        logicalSlot = $Payload.report.logicalSlot
        context = $Payload.report.context
        additions = $Payload.report.additions
        healthBefore = $Payload.report.healthBefore
        healthAfter = $Payload.report.healthAfter
        operation = $Payload.report.operation
        template = $Payload.report.template
        verified = $true
    }
    Add-Content -LiteralPath $script:HistoryPath -Value (ConvertTo-Json $history -Compress)
    return [ordered]@{ status = "installed"; backupId = $backup.backupId; verifiedFiles = $prepared.Count }
}

function Get-BackupList {
    $results = New-Object Collections.ArrayList
    $directories = Get-ChildItem -LiteralPath $script:BackupRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending
    foreach ($directory in $directories) {
        $manifestPath = Join-Path $directory.FullName "backup.json"
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            [void]$results.Add([PSCustomObject]@{
                backupId = [string]$manifest.backupId
                createdAt = [string]$manifest.createdAt
                platform = [string]$manifest.platform
                platformLabel = [string]$manifest.platformLabel
                reason = [string]$manifest.reason
                fileCount = [int]$manifest.fileCount
            })
        }
        catch { }
    }
    return @($results)
}

function Rollback-Backup {
    param([string]$BackupId)
    if (Get-GameRunning) { throw "No Man's Sky is running. Fully close it before rollback." }
    if ($BackupId -notmatch '^atlas-[A-Za-z0-9-]+$') { throw "Invalid backup identifier." }
    $directory = [IO.Path]::GetFullPath((Join-Path $script:BackupRoot $BackupId))
    $root = [IO.Path]::GetFullPath($script:BackupRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $directory.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Backup path is outside the Atlas backup root." }
    $manifestPath = Join-Path $directory "backup.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Backup was not found." }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $currentPaths = @($manifest.files | ForEach-Object { [string]$_.targetPath } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    $safety = New-BackupForPaths $currentPaths ([string]$manifest.platform) "pre-rollback"
    try {
        $count = Restore-BackupManifest $manifest $directory
        Update-FileTokenSnapshotsForPaths @($manifest.files | ForEach-Object { [string]$_.targetPath })
    }
    catch {
        $safetyDirectory = Join-Path $script:BackupRoot $safety.backupId
        $safetyManifest = Get-Content -LiteralPath (Join-Path $safetyDirectory "backup.json") -Raw | ConvertFrom-Json
        [void](Restore-BackupManifest $safetyManifest $safetyDirectory)
        Update-FileTokenSnapshotsForPaths @($safetyManifest.files | ForEach-Object { [string]$_.targetPath })
        throw "Rollback failed; the pre-rollback state was restored: $($_.Exception.Message)"
    }
    return [ordered]@{ status = "restored"; restoredCount = $count; backupId = $BackupId; safetyBackupId = $safety.backupId }
}

function Select-SaveFolder {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = [Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = "Choose a No Man's Sky profile, NMS root, Xbox container, or extracted console save folder"
    $dialog.ShowNewFolderButton = $false
    try {
        if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) {
            return [ordered]@{ cancelled = $true; files = @(); xboxSets = @(); warnings = @(); status = Get-Status }
        }
        return Get-FolderDiscovery $dialog.SelectedPath
    }
    finally { $dialog.Dispose() }
}

$tcp = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$tcp.Start()
$port = ([Net.IPEndPoint]$tcp.LocalEndpoint).Port
$tcp.Stop()

$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()
$url = "http://127.0.0.1:$port/?session=$script:Session"

if ($NoBrowser) {
    [Console]::Out.WriteLine($url)
    [Console]::Out.Flush()
}
else {
    Start-Process $url | Out-Null
}

try {
    while ($listener.IsListening) {
        $expired = $false
        $pendingContext = $listener.BeginGetContext($null, $null)
        try {
            while (-not $pendingContext.AsyncWaitHandle.WaitOne(100)) {
                if (([DateTime]::UtcNow - $script:LastRequestUtc).TotalHours -gt 2) {
                    $expired = $true
                    break
                }
            }
            if ($expired) { break }
            $context = $listener.EndGetContext($pendingContext)
        }
        finally {
            $pendingContext.AsyncWaitHandle.Close()
        }
        $script:LastRequestUtc = [DateTime]::UtcNow
        $path = $context.Request.Url.AbsolutePath
        try {
            if ($path -eq "/" -or $path -eq "/index.html") {
                if ($context.Request.HttpMethod -cne "GET") { Send-ErrorResponse $context "Method not allowed." 405; continue }
                Send-ResponseBytes $context ([IO.File]::ReadAllBytes($script:HtmlPath)) "text/html; charset=utf-8"
                continue
            }
            if (-not $path.StartsWith("/api/")) { Send-ErrorResponse $context "Not found." 404; continue }
            if (-not (Test-ApiSession $context.Request)) { Send-ErrorResponse $context "Invalid Atlas desktop session." 403; continue }

            switch ($path) {
                "/api/status" {
                    if ($context.Request.HttpMethod -cne "GET") { Send-ErrorResponse $context "Method not allowed." 405; continue }
                    Send-Json $context (Get-Status)
                }
                "/api/discover" {
                    if ($context.Request.HttpMethod -cne "GET") { Send-ErrorResponse $context "Method not allowed." 405; continue }
                    Send-Json $context (Get-InstalledDiscovery)
                }
                "/api/select-folder" {
                    if ($context.Request.HttpMethod -cne "POST") { Send-ErrorResponse $context "Method not allowed." 405; continue }
                    Send-Json $context (Select-SaveFolder)
                }
                "/api/file" {
                    if ($context.Request.HttpMethod -cne "GET") { Send-ErrorResponse $context "Method not allowed." 405; continue }
                    Add-Type -AssemblyName System.Web
                    $query = [System.Web.HttpUtility]::ParseQueryString($context.Request.Url.Query)
                    $token = $query["token"]
                    $target = Get-FileTokenTarget $token
                    if (-not (Test-Path -LiteralPath $target.Path -PathType Leaf)) { throw "Save file no longer exists." }
                    Assert-SourcesUnchanged @($target)
                    Send-ResponseBytes $context ([IO.File]::ReadAllBytes($target.Path))
                }
                "/api/install" {
                    if ($context.Request.HttpMethod -cne "POST") { Send-ErrorResponse $context "Method not allowed." 405; continue }
                    Send-Json $context (Install-Transaction (Read-JsonBody $context.Request $script:InstallJsonBodyLimit))
                }
                "/api/backups" {
                    if ($context.Request.HttpMethod -cne "GET") { Send-ErrorResponse $context "Method not allowed." 405; continue }
                    Send-Json $context ([ordered]@{ backups = @(Get-BackupList) })
                }
                "/api/rollback" {
                    if ($context.Request.HttpMethod -cne "POST") { Send-ErrorResponse $context "Method not allowed." 405; continue }
                    $body = Read-JsonBody $context.Request
                    Send-Json $context (Rollback-Backup ([string]$body.backupId))
                }
                default { Send-ErrorResponse $context "Not found." 404 }
            }
        }
        catch {
            try { Send-ErrorResponse $context $_.Exception.Message 400 } catch { }
        }
    }
}
finally {
    if ($listener.IsListening) { $listener.Stop() }
    $listener.Close()
}
