# Deploys "shiur" to Cloudflare from a Windows PC. Safe to run again later to update the site.
# Paste into PowerShell (no admin needed), or: powershell -ExecutionPolicy Bypass -File scripts\deploy-windows.ps1
$ErrorActionPreference = "Stop"

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

Write-Host "`n== 1/5 Checking Node.js and Git ==" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
node --version
git --version

Write-Host "`n== 2/5 Getting the code from GitHub ==" -ForegroundColor Cyan
Set-Location $HOME
if (Test-Path "$HOME\shiur\.git") {
  Set-Location "$HOME\shiur"
  git pull
} else {
  # A browser window may open to sign in to GitHub (the repo is private).
  git clone https://github.com/giladabelson/shiur
  Set-Location "$HOME\shiur"
}

Write-Host "`n== 3/5 Installing packages ==" -ForegroundColor Cyan
# npm.cmd / npx.cmd avoid PowerShell's "running scripts is disabled" error.
npm.cmd install

Write-Host "`n== 4/5 Signing in to Cloudflare (a browser opens: click Allow) ==" -ForegroundColor Cyan
npx.cmd wrangler whoami 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { npx.cmd wrangler login }

Write-Host "`n== 5/5 Building and deploying ==" -ForegroundColor Cyan
npm.cmd run deploy

Write-Host "`nDone. The site address is the https://...workers.dev line above." -ForegroundColor Green
Write-Host "Optional (needs the TURN key from Cloudflare Realtime):" -ForegroundColor Yellow
Write-Host "  cd `$HOME\shiur; npx.cmd wrangler secret put TURN_KEY_ID; npx.cmd wrangler secret put TURN_KEY_API_TOKEN"
