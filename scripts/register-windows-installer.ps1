param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$NativeId = "app.mediatrace",
  [switch]$Uninstall,
  [switch]$RemoveIdentity,
  [switch]$OpenExtensions
)

$ErrorActionPreference = "Stop"
$RegistrationDir = Join-Path $env:LOCALAPPDATA "MediaTrace\NativeHost"
$NativeManifestPath = Join-Path $RegistrationDir "$NativeId.json"
$IdentityKey = Join-Path $env:LOCALAPPDATA "MediaTrace\mediatrace.pem"
$RegistryPaths = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NativeId",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NativeId"
)

if ($Uninstall) {
  Get-Process -Name "mediatrace-native-host" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($RegistryPath in $RegistryPaths) {
    if (Test-Path $RegistryPath) { Remove-Item $RegistryPath -Recurse -Force }
  }
  foreach ($BrowserRoot in @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
  )) {
    if (-not (Test-Path $BrowserRoot)) { continue }
    foreach ($Registration in Get-ChildItem $BrowserRoot -ErrorAction SilentlyContinue) {
      $RegisteredManifest = [string](Get-Item $Registration.PSPath).GetValue("")
      if ($RegisteredManifest -and $RegisteredManifest.StartsWith($RegistrationDir, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item $Registration.PSPath -Recurse -Force
      }
    }
  }
  if (Test-Path $RegistrationDir) { Remove-Item $RegistrationDir -Recurse -Force }
  if ($RemoveIdentity -and (Test-Path $IdentityKey)) { Remove-Item $IdentityKey -Force }
  $MediaTraceDataDir = Split-Path -Parent $RegistrationDir
  if (Test-Path $MediaTraceDataDir) {
    $RemainingDataFiles = @(Get-ChildItem $MediaTraceDataDir -Force -ErrorAction SilentlyContinue)
    if (-not $RemainingDataFiles.Count) { Remove-Item $MediaTraceDataDir -Force }
  }
  exit 0
}

$HostExecutable = Join-Path $InstallRoot "NativeHost\mediatrace-native-host.exe"
$ExtensionDir = Join-Path $InstallRoot "Extension"
$ExtensionManifest = Join-Path $ExtensionDir "manifest.json"
if (-not (Test-Path $HostExecutable)) { throw "Native Host executable is missing: $HostExecutable" }
if (-not (Test-Path $ExtensionManifest)) { throw "Extension manifest is missing: $ExtensionManifest" }

New-Item -ItemType Directory -Force $RegistrationDir | Out-Null
$ExtensionId = (& $HostExecutable --sync-extension-id $ExtensionManifest $IdentityKey | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $ExtensionId -notmatch '^[a-p]{32}$') {
  throw "Failed to generate the stable Chrome/Edge extension ID."
}

$NativeManifest = [ordered]@{
  name = $NativeId
  description = "MediaTrace DLNA discovery and casting host"
  path = $HostExecutable
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$NativeManifestJson = $NativeManifest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($NativeManifestPath, $NativeManifestJson, [Text.UTF8Encoding]::new($false))

$BrowserCandidates = @(
  [pscustomobject]@{ Name = "Google Chrome"; RegistryPath = $RegistryPaths[0]; Executables = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe" }),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  ) },
  [pscustomobject]@{ Name = "Microsoft Edge"; RegistryPath = $RegistryPaths[1]; Executables = @(
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe" }),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
  ) }
)

$InstalledBrowsers = @()
foreach ($Browser in $BrowserCandidates) {
  $Executable = $Browser.Executables | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $Executable) { continue }
  New-Item -Path $Browser.RegistryPath -Force | Out-Null
  Set-Item -Path $Browser.RegistryPath -Value $NativeManifestPath
  $InstalledBrowsers += [pscustomobject]@{ Name = $Browser.Name; Executable = $Executable }
}

if (-not $InstalledBrowsers.Count) {
  throw "Google Chrome or Microsoft Edge was not found. Install a supported browser and run MediaTrace Setup again."
}

$InstallInfo = @(
  "MediaTrace installation completed.",
  "Extension ID: $ExtensionId",
  "Extension folder: $ExtensionDir",
  "Native Host: $HostExecutable",
  "Registered browsers: $($InstalledBrowsers.Name -join ', ')"
) -join [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $InstallRoot "INSTALLATION.txt"), $InstallInfo, [Text.UTF8Encoding]::new($false))

if ($OpenExtensions) {
  foreach ($Browser in $InstalledBrowsers) {
    Start-Process -FilePath $Browser.Executable -ArgumentList "chrome://extensions/"
  }
  Start-Process -FilePath "explorer.exe" -ArgumentList "`"$ExtensionDir`""
}
