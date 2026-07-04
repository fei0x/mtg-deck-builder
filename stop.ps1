# stop.ps1 - Stop the Commander Deck Builder server (frees port 5000).
$ErrorActionPreference = "SilentlyContinue"
$PortNumber = 5000

$owners = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

if (-not $owners) {
    Write-Host "No server is running on port $PortNumber." -ForegroundColor Yellow
    exit 0
}

foreach ($procId in $owners) {
    try {
        Stop-Process -Id $procId -Force
        Write-Host "Stopped server (PID $procId)." -ForegroundColor Green
    } catch {
        Write-Host "Could not stop PID $procId." -ForegroundColor Red
    }
}
