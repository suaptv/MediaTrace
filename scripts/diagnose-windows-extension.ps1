param([string]$ProjectDir = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = "Stop"
$ProjectDir = [IO.Path]::GetFullPath($ProjectDir)
$ManifestPath = Join-Path $ProjectDir "manifest.json"
Write-Host "MediaTrace Windows extension diagnostics"
Write-Host "Project: $ProjectDir"
if (-not (Test-Path $ManifestPath)) { throw "manifest.json not found: $ManifestPath" }
$ManifestText = Get-Content $ManifestPath -Raw
$ManifestVersionMatch = [regex]::Match($ManifestText, '"manifest_version"\s*:\s*(\d+)')
$VersionMatch = [regex]::Match($ManifestText, '"version"\s*:\s*"([^"]+)"')
$WorkerMatch = [regex]::Match($ManifestText, '"service_worker"\s*:\s*"([^"]+)"')
if (-not $ManifestVersionMatch.Success -or -not $VersionMatch.Success -or -not $WorkerMatch.Success) {
  throw "manifest.json is incomplete or invalid: $ManifestPath"
}
$WorkerRelative = $WorkerMatch.Groups[1].Value
$WorkerPath = Join-Path $ProjectDir ($WorkerRelative -replace '/', '\')
Write-Host "Manifest version: $($ManifestVersionMatch.Groups[1].Value)"
Write-Host "Extension version: $($VersionMatch.Groups[1].Value)"
Write-Host "Service Worker: $WorkerRelative"
Write-Host "Service Worker exists: $(Test-Path $WorkerPath)"
if (-not (Test-Path $WorkerPath)) { throw "Service Worker file is missing: $WorkerPath" }
Write-Host "Service Worker bytes: $((Get-Item $WorkerPath).Length)"
$ModuleSyntax = Select-String -Path $WorkerPath -Pattern '^\s*(import|export)\s' -Quiet
Write-Host "Unexpected module syntax: $ModuleSyntax"
if ($ModuleSyntax) { throw "The bundled Service Worker still contains import/export statements." }
$WorkerText = Get-Content $WorkerPath -Raw
$IntegrityOk = $WorkerText -match 'if \(!response\.ok\) throw new Error\('
Write-Host "Service Worker integrity: $IntegrityOk"
if (-not $IntegrityOk) { throw "The Service Worker was corrupted while being copied or generated." }

$Browsers = @(
  @{ Name = "Chrome"; Paths = @((Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"), (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")) },
  @{ Name = "Edge"; Paths = @((Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"), (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")) }
)
if (${env:ProgramFiles(x86)}) {
  $Browsers[0].Paths += Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"
  $Browsers[1].Paths += Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"
}
foreach ($Browser in $Browsers) {
  $Executable = $Browser.Paths | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($Executable) { Write-Host "$($Browser.Name): $Executable ($((Get-Item $Executable).VersionInfo.ProductVersion))" }
  else { Write-Host "$($Browser.Name): not found" }
}

$NativeManifest = Join-Path $env:LOCALAPPDATA "MediaTrace\NativeHost\app.mediatrace.json"
Write-Host "Native Host manifest exists: $(Test-Path $NativeManifest)"
if (Test-Path $NativeManifest) { Write-Host (Get-Content $NativeManifest -Raw) }
Write-Host "Diagnostics completed."
