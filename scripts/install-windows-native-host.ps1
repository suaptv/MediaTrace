param(
  [string]$NativeId = "app.mediatrace",
  [string[]]$ExtensionId = @(),
  [switch]$FrameworkDependent
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
$InstallDir = Join-Path $env:LOCALAPPDATA "MediaTrace\NativeHost"
$IdentityKey = Join-Path $env:LOCALAPPDATA "MediaTrace\mediatrace.pem"
$ManifestPath = Join-Path $InstallDir "$NativeId.json"
$ExtensionManifest = Join-Path $ProjectDir "manifest.json"
$ProjectFile = Join-Path $ProjectDir "native-host-windows\MediaTrace.NativeHost.csproj"
$BackgroundFile = Join-Path $ProjectDir "src\background.js"

function Test-BrowserInstalled([string[]]$ExecutablePaths, [string[]]$AppPathKeys) {
  foreach ($Path in $ExecutablePaths) { if ($Path -and (Test-Path $Path)) { return $true } }
  foreach ($Key in $AppPathKeys) { if (Test-Path $Key) { return $true } }
  return $false
}

$ChromeInstalled = Test-BrowserInstalled @(
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe" }),
  (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
) @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
)
$EdgeInstalled = Test-BrowserInstalled @(
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
  $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe" }),
  (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
) @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"
)
$Browsers = @()
if ($ChromeInstalled) {
  $Browsers += [pscustomobject]@{ Name = "Google Chrome"; DataRoot = (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"); RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NativeId" }
}
if ($EdgeInstalled) {
  $Browsers += [pscustomobject]@{ Name = "Microsoft Edge"; DataRoot = (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data"); RegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NativeId" }
}
if ($Browsers.Count -eq 0) { throw "Google Chrome or Microsoft Edge was not found on this Windows system." }

if ($NativeId -notmatch '^[a-z0-9_]+(?:\.[a-z0-9_]+)+$' -or $NativeId.EndsWith('.extension')) {
  throw "Invalid Native Host Identifier: $NativeId"
}
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "The .NET 8 SDK 8.0.100 or later is required (the Runtime alone is not enough). Install it from https://dotnet.microsoft.com/download/dotnet/8.0, reopen PowerShell, and retry. Visual Studio is not required."
}
$DotnetVersionText = (& dotnet --version | Select-Object -Last 1).Trim()
$DotnetVersion = $null
if (-not [Version]::TryParse(($DotnetVersionText -replace '-.*$', ''), [ref]$DotnetVersion) -or $DotnetVersion.Major -lt 8) {
  throw "Unsupported .NET SDK version: $DotnetVersionText. Install .NET 8 SDK 8.0.100 or later and retry."
}

$Source = Get-Content $BackgroundFile -Raw
$Source = [regex]::Replace($Source, 'const NATIVE_APP_ID = "[^"]+";', "const NATIVE_APP_ID = `"$NativeId`";")
[IO.File]::WriteAllText($BackgroundFile, $Source, [Text.UTF8Encoding]::new($false))
$BundlePath = Join-Path $ProjectDir "src\background.bundle.js"
if (-not (Test-Path $BundlePath)) {
  throw "Prebuilt Chromium background is missing: $BundlePath. Copy the complete latest project and retry."
}
$Bundle = Get-Content $BundlePath -Raw
$Bundle = [regex]::Replace($Bundle, 'const NATIVE_APP_ID = "[^"]+";', "const NATIVE_APP_ID = `"$NativeId`";")
[IO.File]::WriteAllText($BundlePath, $Bundle, [Text.UTF8Encoding]::new($false))
$ExtensionManifestText = Get-Content $ExtensionManifest -Raw
if ($ExtensionManifestText -notmatch '"service_worker"\s*:\s*"src/background\.bundle\.js"') {
  throw "manifest.json does not point to src/background.bundle.js. Update the project files and retry."
}
if (-not (Test-Path $BundlePath) -or (Get-Item $BundlePath).Length -lt 1024) {
  throw "Chromium background bundle was not generated correctly: $BundlePath"
}
if (Select-String -Path $BundlePath -Pattern '^\s*(import|export)\s' -Quiet) {
  throw "Chromium background bundle still contains ES module syntax: $BundlePath"
}
if ($Bundle -notmatch 'if \(!response\.ok\) throw new Error\(') {
  throw "Chromium background bundle failed its JavaScript integrity check: $BundlePath"
}

New-Item -ItemType Directory -Force $InstallDir | Out-Null
$Architecture = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'win-arm64' } else { 'win-x64' }
$PublishArgs = @('publish', $ProjectFile, '-c', 'Release', '-r', $Architecture, '-o', $InstallDir, '/p:PublishSingleFile=true')
if ($FrameworkDependent) { $PublishArgs += '--self-contained'; $PublishArgs += 'false' }
else { $PublishArgs += '--self-contained'; $PublishArgs += 'true' }
& dotnet @PublishArgs
if ($LASTEXITCODE -ne 0) { throw "Windows Native Host build failed." }

$Executable = Join-Path $InstallDir "mediatrace-native-host.exe"
if (-not (Test-Path $Executable)) { throw "Native Host executable was not generated: $Executable" }
$StableExtensionId = (& $Executable --sync-extension-id $ExtensionManifest $IdentityKey | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $StableExtensionId -notmatch '^[a-p]{32}$') {
  throw "Failed to generate the stable Chrome/Edge extension ID."
}
$ExtensionId += $StableExtensionId
$ExtensionId = @($ExtensionId | Where-Object { $_ -match '^[a-p]{32}$' } | Select-Object -Unique)
$Manifest = [ordered]@{
  name = $NativeId
  description = "MediaTrace DLNA discovery and casting host"
  path = $Executable
  type = "stdio"
  allowed_origins = @($ExtensionId | ForEach-Object { "chrome-extension://$_/" })
}
$ManifestJson = $Manifest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($ManifestPath, $ManifestJson, [Text.UTF8Encoding]::new($false))

foreach ($RegistryPath in @($Browsers | ForEach-Object { $_.RegistryPath })) {
  New-Item -Path $RegistryPath -Force | Out-Null
  Set-Item -Path $RegistryPath -Value $ManifestPath
}

Write-Host "MediaTrace Windows Native Host installed."
Write-Host "Native Host Identifier: $NativeId"
Write-Host "Detected browsers: $((@($Browsers | ForEach-Object { $_.Name })) -join ', ')"
Write-Host "Allowed extension IDs: $($ExtensionId -join ', ')"
Write-Host "Executable: $Executable"
Write-Host "Manifest: $ManifestPath"
Write-Host "Extension background: $BundlePath"
Write-Host "Restart Chrome and Edge before using DLNA discovery. Allow network access if Windows Firewall prompts."
