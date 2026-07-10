# Local .env Setup With Existing Foundry

Bu dokuman, localde calisan uygulamalari mevcut Azure AI Foundry / Azure OpenAI kaynagi ve Azure managed servisleri ile baglamak icin `.env` dosyasinda hangi alanlarin bulunmasi gerektigini anlatir.

Bu rehber, [docs/local-azure-service-setup-existing-foundry.md](c:/Users/kakgozluoglu/OneDrive%20-%20Microsoft/Desktop/Projects/azure-speech-avatar-poc/docs/local-azure-service-setup-existing-foundry.md) sonrasinda takip edilmelidir.

## Amac

- Frontend localde calisacak
- Backend localde calisacak
- MCP server localde calisacak
- Azure Speech, Search, Storage ve Document Intelligence dogrudan Azure'dan kullanilacak
- Model tarafinda mevcut Foundry/OpenAI kaynagi kullanilacak

## Mevcut `.env` Durumu

Su alanlar zaten var:

```env
AZURE_LOCATION=eastus2
AZURE_ENV_NAME=dev
AZURE_SUBSCRIPTION_ID=942b2575-7d08-4a36-bbe2-89dde4e4c6bd
AZURE_RESOURCE_GROUP=rg-speech-avatar-poc
VOICE_MODE_DEFAULT=voice-only
ENABLE_MODE_VOICE_ONLY=true
ENABLE_MODE_VIDEO_AVATAR=true
DEFAULT_LANGUAGE=tr-TR
BACKEND_BASE_URL=http://localhost:8081
MCP_BASE_URL=http://localhost:8082
```

## Eklenmesi Gereken Alanlar

Asagidaki alanlari `.env` dosyana eklemelisin.

```env
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_MANAGED_IDENTITY_CLIENT_ID=

AZURE_SPEECH_RESOURCE_ID=
AZURE_SPEECH_ACCOUNT_NAME=
AZURE_SPEECH_REGION=eastus2

AZURE_SEARCH_SERVICE=
AZURE_SEARCH_INDEX=knowledge-index

AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=knowledge

AZURE_DOCUMENT_INTELLIGENCE_ACCOUNT_NAME=
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=

AZURE_OPENAI_ACCOUNT_NAME=
AZURE_OPENAI_RESOURCE_GROUP=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_CHAT_DEPLOYMENT=
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=
AZURE_OPENAI_REALTIME_DEPLOYMENT=

AZURE_AUTH_MODE=service-principal
KNOWLEDGE_USE_AZURE_CLI_CREDENTIAL=false
```

## Alanlar Ne Ise Yarar?

### Genel Azure Bilgileri

```env
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_MANAGED_IDENTITY_CLIENT_ID=
```

- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`: Keyless calisma icin kullanilan **service principal** (servis kullanicisi) bilgileri. Bu degerleri `scripts/setup-service-identity.ps1 -CreateServicePrincipal` ciktisi verir. `DefaultAzureCredential` bu uc degeri gorunce `EnvironmentCredential` uzerinden servis kullanicisi olarak kimlik dogrular.
- `AZURE_MANAGED_IDENTITY_CLIENT_ID`: Sadece Azure Container Apps icinde calisirken kullanilir; localde bos birakilabilir.

### Speech

```env
AZURE_SPEECH_RESOURCE_ID=
AZURE_SPEECH_ACCOUNT_NAME=
AZURE_SPEECH_REGION=eastus2
```

- `AZURE_SPEECH_RESOURCE_ID`: RBAC tabanli cagrilarda kaynak baglami icin kullanisli.
- `AZURE_SPEECH_ACCOUNT_NAME`: SDK veya token endpoint olusturma akisinda faydali.
- `AZURE_SPEECH_REGION`: Speech token ve avatar akisinda kritik.

### Search

```env
AZURE_SEARCH_SERVICE=
AZURE_SEARCH_INDEX=knowledge-index
```

- `AZURE_SEARCH_SERVICE`: Search service adi.
- `AZURE_SEARCH_INDEX`: RAG sorgularinda kullanilacak index adi.
- Search data-plane islemleri artik **key ile degil**, servis kullanicisina atanan `Search Index Data Contributor` rolu ile RBAC uzerinden yapilir. `AZURE_SEARCH_API_KEY` alani KALDIRILDI.

### Storage

```env
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=knowledge
```

- Blob kaynak dokumanlari burada tutulur.
- Ingestion pipeline bu bilgileri kullanir.

### Document Intelligence

```env
AZURE_DOCUMENT_INTELLIGENCE_ACCOUNT_NAME=
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=
```

- Dokuman parse/extract akisi icin gerekir.
- Endpoint degeri dogrudan Azure resource uzerinden alinir.

### Foundry / OpenAI

```env
AZURE_OPENAI_ACCOUNT_NAME=
AZURE_OPENAI_RESOURCE_GROUP=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_CHAT_DEPLOYMENT=
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=
AZURE_OPENAI_REALTIME_DEPLOYMENT=
```

- Bu alanlar mevcut Foundry/OpenAI resource'unu kullanmak icin gerekir.
- `CHAT_DEPLOYMENT`: chat/fallback akisi icin.
- `EMBEDDING_DEPLOYMENT`: chunk embedding uretimi icin.
- `REALTIME_DEPLOYMENT`: Voice Live veya realtime senaryo icin, kullanacaksan.

### Kimlik Dogrulama Modu

```env
AZURE_AUTH_MODE=service-principal
KNOWLEDGE_USE_AZURE_CLI_CREDENTIAL=false
```

- Tum servisler keyless (RBAC) calisir.
- `service-principal`: `.env` icindeki `AZURE_CLIENT_ID/TENANT/SECRET` servis kullanicisi ile kimlik dogrulanir. Onerilen mod.
- `developer-login`: Kendi `az login` oturumun (AzureCliCredential) kullanilir. Bu modda `AZURE_CLIENT_SECRET`'e gerek yoktur; ancak kendi kullanicina da rol atanmis olmalidir (`setup-service-identity.ps1 -AssignCurrentUser`).

## Ornek Dolu `.env`

Asagidaki ornek, local test icin tipik bir `.env` gorunumudur:

```env
AZURE_LOCATION=eastus2
AZURE_ENV_NAME=dev
AZURE_SUBSCRIPTION_ID=942b2575-7d08-4a36-bbe2-89dde4e4c6bd
AZURE_RESOURCE_GROUP=rg-speech-avatar-poc
AZURE_TENANT_ID=<tenant-id>

VOICE_MODE_DEFAULT=voice-only
ENABLE_MODE_VOICE_ONLY=true
ENABLE_MODE_VIDEO_AVATAR=true
DEFAULT_LANGUAGE=tr-TR

BACKEND_BASE_URL=http://localhost:8081
MCP_BASE_URL=http://localhost:8082

AZURE_SPEECH_RESOURCE_ID=/subscriptions/<sub-id>/resourceGroups/rg-speech-avatar-poc/providers/Microsoft.CognitiveServices/accounts/spavatarpoc001
AZURE_SPEECH_ACCOUNT_NAME=spavatarpoc001
AZURE_SPEECH_REGION=eastus2

AZURE_SEARCH_SERVICE=srchavatarpoc001
AZURE_SEARCH_INDEX=knowledge-index

AZURE_STORAGE_ACCOUNT=stavatarpoc001
AZURE_STORAGE_CONTAINER=knowledge

AZURE_DOCUMENT_INTELLIGENCE_ACCOUNT_NAME=docavatarpoc001
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://docavatarpoc001.cognitiveservices.azure.com/

AZURE_OPENAI_ACCOUNT_NAME=<existing-foundry-or-openai-name>
AZURE_OPENAI_RESOURCE_GROUP=<foundry-resource-group>
AZURE_OPENAI_ENDPOINT=https://<existing-foundry-or-openai-name>.openai.azure.com/
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-4o
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large
AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-realtime

AZURE_AUTH_MODE=service-principal
KNOWLEDGE_USE_AZURE_CLI_CREDENTIAL=false
```

## Bu Degerleri Nereden Bulacaksin?

### Speech resource id

```pwsh
az cognitiveservices account show `
  --name <speech-name> `
  --resource-group <resource-group> `
  --query id -o tsv
```

### Document Intelligence endpoint

```pwsh
az cognitiveservices account show `
  --name <docint-name> `
  --resource-group <resource-group> `
  --query properties.endpoint -o tsv
```

### Foundry/OpenAI endpoint

```pwsh
az cognitiveservices account show `
  --name <foundry-or-openai-account-name> `
  --resource-group <foundry-resource-group> `
  --query properties.endpoint -o tsv
```

### Foundry/OpenAI deployment listesi

```pwsh
az cognitiveservices account deployment list `
  --name <foundry-or-openai-account-name> `
  --resource-group <foundry-resource-group> `
  -o table
```

## Bu `.env` Ile Ne Beklemelisin?

Bu `.env` dosyasi hazir oldugunda:

- local servislerin hangi Azure kaynaklariyla konusacagi netlesir
- Search, Storage, Speech, Document Intelligence ve Foundry baglantisi icin sabitler toplanir
- backend ve mcp-server bu degerlerle dogrudan calisir

Mevcut kod bu servisleri RBAC uzerinden gercek olarak cagirir:

- backend `/api/speech/token` uzerinden gercek Speech STS token uretir
- mcp-server `answer_question` cagrisinda Foundry chat + Search vektor arama ile grounded cevap doner
- Voice Live realtime akisi backend WebSocket proxy uzerinden calisir

## Sonraki Adim

Bu rehber tamamlandiktan sonra `.env` dosyasini bu formatta doldur, frontend/backend/mcp-server'i localde calistir ve [validation.md](c:/Users/kakgozluoglu/OneDrive%20-%20Microsoft/Desktop/Projects/azure-speech-avatar-poc/docs/validation.md) ile islevsel dogrulama yap.