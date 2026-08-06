param([string]$NativeId = "app.mediatrace")

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "MediaTrace\NativeHost"
foreach ($RegistryPath in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NativeId",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NativeId"
)) {
  if (Test-Path $RegistryPath) { Remove-Item $RegistryPath -Recurse -Force }
}
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
Write-Host "MediaTrace Windows Native Host removed."
