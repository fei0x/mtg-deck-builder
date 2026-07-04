# start.ps1 - Launch the Commander Deck Builder local web app.
# Ensures Python + a venv + dependencies, starts the server, waits for the
# port to come up, then opens the app in the default browser.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$PortNumber = 5000
$Url = "http://localhost:$PortNumber"

function Test-Port([int]$p) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect("127.0.0.1", $p)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Open-Browser([string]$u) {
    # Robust default-browser launch (Start-Process on a bare URL is flaky on
    # some setups; fall back to the shell 'start' verb).
    try { Start-Process $u; return } catch { }
    try { Start-Process "cmd.exe" -ArgumentList "/c", "start", "", $u; return } catch { }
    try { [System.Diagnostics.Process]::Start($u) | Out-Null } catch { }
}

# 1. Find a suitable Python (3.9+).
$python = $null
foreach ($cmd in @("python", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python (\d+)\.(\d+)") {
            $maj = [int]$Matches[1]
            $min = [int]$Matches[2]
            if ($maj -gt 3 -or ($maj -eq 3 -and $min -ge 9)) {
                $python = $cmd
                break
            }
        }
    } catch {
        # try next candidate
    }
}
if (-not $python) {
    Write-Host ""
    Write-Host "==================================================================" -ForegroundColor Yellow
    Write-Host " Python 3.9+ is required but wasn't found." -ForegroundColor Yellow
    Write-Host "==================================================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host " Easiest way (Windows 10/11) - run this in PowerShell:" -ForegroundColor Cyan
    Write-Host "     winget install Python.Python.3.12" -ForegroundColor White
    Write-Host ""
    Write-Host " Or download the installer from:" -ForegroundColor Cyan
    Write-Host "     https://www.python.org/downloads/" -ForegroundColor White
    Write-Host "     IMPORTANT: on the first installer screen, tick" -ForegroundColor White
    Write-Host "     'Add python.exe to PATH' before clicking Install." -ForegroundColor White
    Write-Host ""
    Write-Host " After installing, CLOSE this window, open a new PowerShell," -ForegroundColor Cyan
    Write-Host " and run  ./start.ps1  again." -ForegroundColor Cyan
    Write-Host ""
    exit 1
}

# 2. Create the virtual environment if missing.
$venv = Join-Path $root "venv"
$venvPython = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    & $python -m venv $venv
}

# 3. Install / verify dependencies.
Write-Host "Checking dependencies..." -ForegroundColor Cyan
& $venvPython -m pip install --quiet --upgrade pip
& $venvPython -m pip install --quiet -r (Join-Path $root "requirements.txt")

# 4. If a server is already on the port, stop it so this run is a clean restart
#    (repeated start.ps1 runs act like a refresh).
if (Test-Port $PortNumber) {
    Write-Host "A server is already running on port $PortNumber - restarting it..." -ForegroundColor Yellow
    $existing = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $existing) { try { Stop-Process -Id $procId -Force } catch { } }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-Port $PortNumber)) { break }
        Start-Sleep -Milliseconds 250
    }
}

# 5. Start the server as a background process.
Write-Host "Starting server..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $venvPython -ArgumentList "-m", "app" `
    -WorkingDirectory $root -PassThru

# 6. Wait for the port to accept connections, then open the browser.
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    if (Test-Port $PortNumber) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
}

if ($ready) {
    Open-Browser $Url
    Write-Host ""
    Write-Host "Commander Deck Builder is running at $Url" -ForegroundColor Green
    Write-Host "Server process PID: $($proc.Id). Stop it to quit the app." -ForegroundColor Green
} else {
    Write-Host "ERROR: The server did not become ready in time." -ForegroundColor Red
    Write-Host "Try running '$venvPython -m app' directly to see the error." -ForegroundColor Red
    exit 1
}
