# Deployment Flow

## Prerequisites
- Azure CLI
- Docker Desktop
- Node.js 20+

## Local-Only Setup With Existing Foundry Resource
1. Login:
   ```pwsh
   az login
   az account set --subscription "<subscription-id>"
   ```
2. Create or reuse a single resource group:
   ```pwsh
   az group create --name <resource-group> --location eastus2
   ```
3. Provision only the managed services that local apps need:
   ```pwsh
   az cognitiveservices account create --name <speech-name> --resource-group <resource-group> --location eastus2 --kind SpeechServices --sku S0 --yes
   az search service create --name <search-name> --resource-group <resource-group> --location eastus2 --sku standard
   az cognitiveservices account create --name <docint-name> --resource-group <resource-group> --location eastus2 --kind FormRecognizer --sku S0 --yes
   az storage account create --name <storage-name> --resource-group <resource-group> --location eastus2 --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false
   az storage container create --account-name <storage-name> --name knowledge --auth-mode login
   ```
4. Reuse your existing Azure AI Foundry / Azure OpenAI resource and note these values:
   - endpoint
   - chat deployment name
   - embedding deployment name
   - realtime deployment name, if used
5. Create the keyless service user and assign all RBAC roles (resource key usage is removed entirely):
   ```pwsh
   ./scripts/setup-service-identity.ps1 -CreateServicePrincipal -AssignCurrentUser -DisableLocalAuth
   ```
   Copy the resulting `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_CLIENT_SECRET` values into `.env`.
6. Run frontend, backend, and mcp-server locally.

## When To Use azd
- Use `azd provision` or `azd up` only if you want this repository to also provision app hosting resources such as ACR and Container Apps.
- Do not use `azd up` for local-only testing.

## Keyless Identity Model (Production)
- `infra/main.bicep` creates a single **user-assigned managed identity** (the shared service user) and binds it to the three container apps (frontend, backend, mcp-server).
- All application resource roles (Speech/Document Intelligence = Cognitive Services User, Search = Search Index Data Contributor, Storage = Storage Blob Data Contributor, ACR = AcrPull) are assigned automatically to this identity.
- Local (key) auth is disabled on Speech, Search, Document Intelligence, and Storage (`disableLocalAuth` / `allowSharedKeyAccess=false`).
- Because the external Foundry / Azure OpenAI resource lives in a different resource group, the `Cognitive Services OpenAI User` role cannot be assigned by Bicep. To assign this role to the service identity after `azd provision`:
  ```pwsh
  $principalId = azd env get-value serviceIdentityPrincipalId
  ./scripts/setup-service-identity.ps1 -SkipRoleAssignments:$false -CreateServicePrincipal:$false
  # or directly:
  az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal `
    --role "Cognitive Services OpenAI User" `
    --scope "/subscriptions/<sub-id>/resourceGroups/<foundry-rg>/providers/Microsoft.CognitiveServices/accounts/<foundry-account>"
  ```

## Single Resource Group Guardrail
- All resources are created by `infra/main.bicep` at resource-group scope.
- Do not split services into multiple resource groups for this PoC.

## Existing Foundry Resource Notes
- This repo does not need to create a new Azure OpenAI resource if you already have a compatible Foundry/OpenAI resource.
- Keep the Foundry/OpenAI resource in a region that supports the deployments you need.
- Prefer RBAC with your signed-in user for local testing.

## Troubleshooting
- Check existing Foundry/OpenAI endpoint access:
  ```pwsh
  az cognitiveservices account show --name <foundry-or-openai-resource-name> --resource-group <resource-group> --query properties.endpoint
  ```
- Check Search service status:
  ```pwsh
  az search service show --name <search-name> --resource-group <resource-group> --query provisioningState
  ```
