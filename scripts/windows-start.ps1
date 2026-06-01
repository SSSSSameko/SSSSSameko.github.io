$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

if (-not $env:PORT) {
  $env:PORT = "4173"
}

Write-Host "Starting Sameko Weibo Lottery on port $env:PORT"
Write-Host "CORS_ORIGINS = $env:CORS_ORIGINS"
node server.mjs
