# Architecture

## Scope
- Single resource group strategy.
- Primary region: East US 2.
- Services: Azure Speech, Azure AI Search, Document Intelligence, Storage, and an existing Azure AI Foundry/Azure OpenAI resource for model access. ACR, Container Apps, Log Analytics, and App Insights are optional when running fully local.

## Application Components
- assistant-app: browser UI and mode switcher (voice-only, video avatar).
- orchestration-api: session/token endpoints, mode orchestration, fallback chat endpoint, and Voice Live WebSocket proxy.
- rag-service: answer_question tool and retrieval orchestration.
- knowledge-ingestion pipeline: Blob -> Document Intelligence -> chunk -> embedding -> Search index upsert.

## Voice API Paths
The UI exposes two `Voice API` options:
- **Standard**: browser-orchestrated pipeline. STT (Speech SDK) -> rag-service `answer_question` -> TTS (Speech SDK). One turn per mic press.
- **Realtime Voice Live**: continuous speech-to-speech via the Azure Voice Live API.
  - The browser opens a WebSocket to orchestration-api (`/api/voice-live/ws`) and streams PCM16 mic audio; it plays back the model's PCM16 audio.
  - orchestration-api authenticates with managed identity and relays the stream to `wss://<resource>/voice-live/realtime`, so credentials never reach the browser.
  - The backend injects the domain-adaptive `session.update` (instructions, Azure semantic VAD, voice) and exposes a `search_knowledge` function tool.
  - When the model calls `search_knowledge`, the backend invokes rag-service `answer_question` and returns the grounded answer + citations (VoiceRAG pattern), keeping retrieval grounding identical to the Standard path.
  - Configured via `AZURE_VOICE_LIVE_ENDPOINT` / `AZURE_VOICE_LIVE_MODEL` / `AZURE_VOICE_LIVE_API_VERSION`; falls back to the Standard path if unset.

## Identity and Access
- All Container Apps (frontend, backend, mcp-server) run with a single shared user-assigned managed identity.
- RBAC assignments are defined in [infra/main.bicep](../infra/main.bicep) and [infra/modules/rbac.bicep](../infra/modules/rbac.bicep).
- API key dependency is minimized by MI + RBAC.
- For local-only development, the signed-in Azure user can be granted RBAC directly on Speech, Search, Storage, Document Intelligence, and the existing Foundry/OpenAI resource.

## Extension Points
- Additional profiles can be added under [config/profiles](../config/profiles).
