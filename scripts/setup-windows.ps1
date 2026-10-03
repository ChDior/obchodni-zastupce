# BELETA AI SALES - instalace a spuštění na Windows (jednorázově nastaví vše potřebné a spustí aplikaci)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)   # kořen projektu

function Write-Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function New-RandomText($len) {
  $chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $bytes = New-Object byte[] $len
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}
function Set-EnvValue([string[]]$lines, [string]$key, [string]$value) {
  $found = $false
  $out = foreach ($l in $lines) { if ($l -match "^$key=") { $found = $true; "$key=$value" } else { $l } }
  if (-not $found) { $out = @($out) + "$key=$value" }
  return ,@($out)
}

Write-Step '1/4 Kontrola Node.js (potřebná verze 22 nebo vyšší)'
$nodeOk = $false
try { $v = (node -v) -replace 'v',''; if ([int]($v.Split('.')[0]) -ge 22) { $nodeOk = $true; Write-Host "Node.js $v - v pořádku" } } catch { }
if (-not $nodeOk) {
  Write-Host 'Node.js 22+ nenalezen.' -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Instaluji Node.js LTS přes winget...'
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Write-Host ''
    Write-Host 'Node.js je nainstalován. ZAVŘETE toto okno a spusťte start-windows.cmd znovu.' -ForegroundColor Green
  } else {
    Write-Host 'Stáhněte a nainstalujte Node.js LTS z https://nodejs.org, pak spusťte start-windows.cmd znovu.' -ForegroundColor Red
  }
  Read-Host 'Stiskněte Enter pro ukončení'; exit 1
}

Write-Step '2/4 Nastavení (.env)'
$envPath = Join-Path (Get-Location) '.env'
$adminPassword = $null
if (Test-Path $envPath) {
  Write-Host 'Soubor .env už existuje - nechávám ho beze změny.'
} else {
  $lines = [System.IO.File]::ReadAllLines((Join-Path (Get-Location) '.env.example'))
  $email = Read-Host 'Váš e-mail pro přihlášení do administrace'
  if ([string]::IsNullOrWhiteSpace($email)) { $email = 'admin@beleta.local' }
  $adminPassword = New-RandomText 16
  $lines = Set-EnvValue $lines 'ADMIN_EMAIL' $email
  $lines = Set-EnvValue $lines 'ADMIN_PASSWORD' $adminPassword
  $lines = Set-EnvValue $lines 'INTERNAL_TOKEN' (New-RandomText 32)
  $lines = Set-EnvValue $lines 'ANTHROPIC_MODEL' 'claude-haiku-4-5'
  Write-Host ''
  Write-Host 'Klíč Anthropic (začíná sk-ant-). Pokud ho ještě nemáte, jen stiskněte Enter - aplikace poběží bez AI chatu.'
  $secure = Read-Host 'ANTHROPIC_API_KEY' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if (-not [string]::IsNullOrWhiteSpace($key)) { $lines = Set-EnvValue $lines 'ANTHROPIC_API_KEY' $key.Trim() }
  # UTF-8 BEZ BOM (BOM by rozbil první řádek souboru)
  [System.IO.File]::WriteAllLines($envPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Soubor .env vytvořen: $envPath"
  if ([string]::IsNullOrWhiteSpace($key)) {
    Write-Host 'Klíč můžete kdykoli doplnit: otevře se Poznámkový blok, řádek ANTHROPIC_API_KEY= doplňte, uložte a aplikaci spusťte znovu.'
    $openNotepad = Read-Host 'Otevřít .env v Poznámkovém bloku teď? (a/n)'
    if ($openNotepad -eq 'a') { Start-Process notepad.exe $envPath }
  }
}

Write-Step '3/4 Instalace závislostí (první spuštění trvá chvíli)'
npm install --legacy-peer-deps
if ($LASTEXITCODE -ne 0) { Write-Host 'Instalace selhala.' -ForegroundColor Red; Read-Host 'Enter'; exit 1 }

Write-Step '4/4 Spouštím aplikaci'
Write-Host ''
Write-Host 'Administrace:  http://localhost:3000/ai-sales' -ForegroundColor Green
Write-Host 'Zákaznický chat: http://localhost:3000/widget' -ForegroundColor Green
if ($adminPassword) {
  Write-Host ''
  Write-Host "Přihlášení do administrace - heslo: $adminPassword   (uloženo v souboru .env)" -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Okno nechte otevřené - běží v něm aplikace. Ukončíte ji klávesami Ctrl+C.'
Start-Job -ScriptBlock { Start-Sleep -Seconds 10; Start-Process 'http://localhost:3000/ai-sales' } | Out-Null
npm start
Read-Host 'Aplikace skončila. Stiskněte Enter'
