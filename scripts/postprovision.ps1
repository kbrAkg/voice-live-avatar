$ErrorActionPreference = 'Stop'

Write-Host "Post-provision phase started..."

if (-not $env:AZURE_ENV_NAME) {
  Write-Warning "AZURE_ENV_NAME is not set. Skipping post-provision tasks."
  exit 0
}

Write-Host "Executing knowledge ingestion setup for environment: $($env:AZURE_ENV_NAME)"

node ./scripts/knowledge-ingestion/index.js --create-index --process-documents

Write-Host "Post-provision phase completed."
