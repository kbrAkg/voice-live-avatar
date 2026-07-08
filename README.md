# Domain-Adaptive Voice Live Avatar PoC

This repository contains a domain-agnostic PoC for multilingual (TR + EN) live avatar assistant scenarios.

## What is Included
- Voice Live + Azure Speech Avatar integration
- RAG pipeline (Blob -> Document Intelligence -> Azure AI Search)
- Keyless (RBAC-only) security model: a shared service user (user-assigned managed identity + service principal); no resource keys are used anywhere
- Modular Bicep infrastructure for single resource group deployment
- azd deployment flow with post-provision ingestion hook

## Project Layout
- `frontend/` assistant-app UI
- `backend/` orchestration-api
- `mcp-server/` rag-service and answer_question tool
- `infra/` Bicep main + modules
- `scripts/` deployment hooks and ingestion scripts
- `docs/` architecture, deployment, validation
- `config/profiles/` domain behavior configuration

## Quick Start
1. Install dependencies:
   ```pwsh
   cd frontend; npm install
   cd ../backend; npm install
   cd ../mcp-server; npm install
   cd ..
   ```
2. For local-only testing, provision only the required Azure managed services:
   ```pwsh
   az login
   az account set --subscription "<subscription-id>"
   az group create --name <resource-group> --location eastus2
   az cognitiveservices account create --name <speech-name> --resource-group <resource-group> --location eastus2 --kind SpeechServices --sku S0 --yes
   az search service create --name <search-name> --resource-group <resource-group> --location eastus2 --sku standard
   az cognitiveservices account create --name <docint-name> --resource-group <resource-group> --location eastus2 --kind FormRecognizer --sku S0 --yes
   az storage account create --name <storage-name> --resource-group <resource-group> --location eastus2 --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false
   ```
3. Reuse an existing Azure AI Foundry / Azure OpenAI resource for model deployments instead of provisioning a new OpenAI account in this repo.
4. Create the keyless service user and assign all RBAC roles (this step removes key usage entirely):
   ```pwsh
   Copy-Item .env.example .env   # if missing; then fill in .env
   ./scripts/setup-service-identity.ps1 -CreateServicePrincipal -AssignCurrentUser -DisableLocalAuth
   ```
   Copy the resulting `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` values into `.env`.
5. Validate using [docs/validation.md](docs/validation.md).

## Domain-Agnostic Naming Rule
No file/folder/module name includes a vertical-specific label. Domain behavior is selected by configuration:
- `ASSISTANT_DOMAIN`
- `ASSISTANT_PROFILE`
- files under `config/profiles/`
