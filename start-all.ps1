$ErrorActionPreference = 'Stop'

$root = if ($PSScriptRoot) {
  $PSScriptRoot
} else {
  Split-Path -Parent $MyInvocation.MyCommand.Path
}

function Start-ServiceWindow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$WorkingDir,

    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  if (-not (Test-Path $WorkingDir)) {
    throw "Directory not found: $WorkingDir"
  }

  $startupCommand = @(
    "Set-Location -Path '$WorkingDir'",
    "`$env:PORT=$Port",
    "Write-Host '[$Name] starting on port $Port...' -ForegroundColor Cyan",
    "npm start"
  ) -join '; '

  Start-Process -FilePath 'pwsh' -ArgumentList '-NoExit', '-Command', $startupCommand | Out-Null
}

Write-Host 'Starting all services in separate terminals...' -ForegroundColor Green

Start-ServiceWindow -Name 'mcp-server' -WorkingDir (Join-Path $root 'mcp-server') -Port 8082
Start-ServiceWindow -Name 'backend' -WorkingDir (Join-Path $root 'backend') -Port 8081
Start-ServiceWindow -Name 'frontend' -WorkingDir (Join-Path $root 'frontend') -Port 8080

Write-Host 'Done. 3 terminals launched:' -ForegroundColor Green
Write-Host '  - frontend: http://localhost:8080' -ForegroundColor Yellow
Write-Host '  - backend:  http://localhost:8081' -ForegroundColor Yellow
Write-Host '  - mcp:      http://localhost:8082' -ForegroundColor Yellow
