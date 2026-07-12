# Localde Çalıştırma Rehberi — Voice Live Avatar (Uçtan Uca, Tek RG)

Bu doküman, projeyi **sıfırdan** kurup **lokalde** çalıştırmak için gereken tüm adımları tek bir akışta içerir. Sonunda:

- Tek bir resource group içinde tüm Azure servisleri kurulmuş olur.
- Modeller (chat, embedding, realtime/Voice Live) deploy edilmiş olur.
- Anahtarsız (keyless / RBAC) çalışan bir **servis kullanıcısı** (service principal) oluşturulur ve tüm yetkiler atanır.
- Frontend, backend ve MCP server lokalde çalışır durumda olur.

> Bu senaryoda uygulamalar Azure'a deploy edilmez (Container Apps/ACR kurulmaz). Sadece managed servisler Azure'da, uygulamalar lokalde çalışır. Bu yüzden `azd up` / `azd provision` **kullanılmaz**.

---

## 0. Ön Koşullar

Aşağıdaki araçların kurulu olması gerekir:

| Araç | Kontrol komutu | Not |
|------|----------------|-----|
| Azure CLI | `az version` | 2.60+ önerilir |
| PowerShell 7+ | `pwsh --version` | Kurulum scriptleri için zorunlu |
| Node.js 20+ | `node --version` | Uygulamalar ve ingestion için |
| Git | `git --version` | Repoyu klonlamak için |

Ayrıca:

- Hedef Azure subscription üzerinde **Owner** veya **Contributor + User Access Administrator** rolüne sahip olmalısınız (RBAC atamaları ve service principal oluşturmak için gerekir).
- Azure AI Foundry / OpenAI modelleri için **kota** (quota) gereklidir. Kota yoksa deployment adımında hata alırsınız; bu durumda ilgili model için kota talebi açın.

---

## 1. Repoyu Hazırla

```pwsh
git clone <repo-url> voice-live-avatar
cd voice-live-avatar
```

Bağımlılıkları kur:

```pwsh
cd frontend;  npm install
cd ../backend; npm install
cd ../mcp-server; npm install
cd ../scripts/knowledge-ingestion; npm install
cd ../..
```

---

## 2. Azure Login ve Subscription Seçimi

```pwsh
az login
az account set --subscription "<subscription-id>"
az account show --query "{name:name, id:id, tenantId:tenantId}" -o json
```

---

## 3. Değişkenleri Tanımla

Aşağıdaki bloğu **tek seferde** çalıştır. İsimleri kendine göre değiştir. Storage/Search/Cognitive Services isimleri **global unique** olmalı ve **küçük harf + rakam** içermeli; çakışma olursa sonuna kısa bir suffix ekle.

```pwsh
$LOCATION   = "eastus2"
$RG         = "rg-voice-avatar-healthcare-test"

# Managed servisler (bu RG içinde)
$SPEECH     = "spavatarhealthcaretest"
$SEARCH     = "srchavatarhealthcaretest"
$DOCINT     = "docavatarhealthcaretest"
$STORAGE    = "stavatarhealthcaretest"
$CONTAINER  = "knowledge"

# Azure AI Foundry (OpenAI + Voice Live) — aynı RG içinde
$FOUNDRY    = "aifoundryavatarhealthcaretest"

# Model deployment adları (.env ile birebir aynı olmalı)
$CHAT_DEPLOYMENT      = "gpt-5.4"
$EMBEDDING_DEPLOYMENT = "text-embedding-3-small"
```

> **Not:** Bu rehber embedding modeli olarak `text-embedding-3-small` (1536 boyut) kullanır çünkü ingestion index'i varsayılan olarak 1536 boyutla oluşturur. Eğer `text-embedding-3-large` kullanacaksanız `.env` içinde `AZURE_SEARCH_EMBEDDING_DIMENSIONS=3072` ayarını da yapmalısınız.

---

## 4. Resource Provider Kayıtları

```pwsh
az provider register --namespace Microsoft.CognitiveServices
az provider register --namespace Microsoft.Search
az provider register --namespace Microsoft.Storage
```

---

## 5. Resource Group Oluştur

```pwsh
az group create --name $RG --location $LOCATION
```

---

## 6. Azure Speech Oluştur

Avatar ve konuşma (STT/TTS) token'ları için.

> **Önemli:** Bu proje anahtarsız (Entra ID / RBAC) çalışır. Entra ID ile Speech kimlik doğrulaması **custom subdomain zorunlu kılar**. Bu yüzden `--custom-domain $SPEECH` **mutlaka** verilmelidir; aksi halde backend token değişimi `Speech token request failed with 500: fetch failed` hatası verir. Custom subdomain sonradan eklenemez; unutursan kaynağı silip yeniden oluşturman gerekir.

```pwsh
az cognitiveservices account create `
  --name $SPEECH `
  --resource-group $RG `
  --location $LOCATION `
  --kind SpeechServices `
  --sku S0 `
  --custom-domain $SPEECH `
  --yes
```

---

## 7. Azure AI Search Oluştur

RAG için vektör arama index'i.

```pwsh
az search service create `
  --name $SEARCH `
  --resource-group $RG `
  --location $LOCATION `
  --sku standard
```

### Kapasite hatası alırsanız

`eastus2` bazen yeni Search kapasitesi vermeyebilir:

```text
(InsufficientResourcesAvailable) The region 'eastus2' is currently out of the resources required to provision new services.
```

Bu durumda **sadece Search** servisini yakın bir bölgede oluşturun (diğer servisleri `$LOCATION` içinde bırakın):

```pwsh
$SEARCH_LOCATION = "eastus"
az search service create `
  --name $SEARCH `
  --resource-group $RG `
  --location $SEARCH_LOCATION `
  --sku standard
```

Kod Search için sadece servis adını kullanır; region bilgisi ayrıca istenmez.

---

## 8. Azure Document Intelligence Oluştur

Metin dışı dokümanların (PDF, görüntü vb.) parse edilmesi için.

```pwsh
az cognitiveservices account create `
  --name $DOCINT `
  --resource-group $RG `
  --location $LOCATION `
  --kind FormRecognizer `
  --sku S0 `
  --yes
```

---

## 9. Storage Account + Blob Container Oluştur

Kaynak dokümanların tutulduğu yer.

```pwsh
az storage account create `
  --name $STORAGE `
  --resource-group $RG `
  --location $LOCATION `
  --sku Standard_LRS `
  --kind StorageV2 `
  --min-tls-version TLS1_2 `
  --allow-blob-public-access false `
  --public-network-access Enabled `
  --default-action Allow

az storage container create `
  --account-name $STORAGE `
  --name $CONTAINER `
  --auth-mode login
```

> **Not:** `--public-network-access Enabled` ve `--default-action Allow` storage'a **ağ üzerinden** (senin makinenden ve uygulamalardan) erişimi açık tutar. Test için gereklidir, production'da önerilmez.


## 10. Azure AI Foundry (OpenAI + Voice Live) Oluştur

Voice Live ve realtime akışı **custom subdomain** gerektirdiği için `AIServices` türünde ve `--custom-domain` ile oluşturuyoruz.

```pwsh
az cognitiveservices account create `
  --name $FOUNDRY `
  --resource-group $RG `
  --location $LOCATION `
  --kind AIServices `
  --sku S0 `
  --custom-domain $FOUNDRY `
  --yes
```

---

## 11. Modelleri Deploy Et

> Model sürümleri zamanla değişir. Bölgende **sadece bu rehberde kullanılan** modellerin sürümlerini görmek için (uzun listeyi filtreler):
> ```pwsh
> az cognitiveservices account list-models --name $FOUNDRY --resource-group $RG `
   --query "[?name=='gpt-5.4' || name=='text-embedding-3-small'].{name:name, version:version, format:format}" `
   -o table
> ```
> Tüm modelleri görmek istersen `--query` satırını kaldırıp sadece `-o table` bırak.
> Aşağıdaki `--model-version` değerlerini bu çıktıya göre güncelle.

### 11.1 Chat modeli (gpt-5.4)

```pwsh
az cognitiveservices account deployment create `
  --name $FOUNDRY `
  --resource-group $RG `
  --deployment-name $CHAT_DEPLOYMENT `
  --model-name gpt-5.4 `
  --model-version "2026-03-05" `
  --model-format OpenAI `
  --sku-name GlobalStandard `
  --sku-capacity 50
```

### 11.2 Embedding modeli (text-embedding-3-small)

```pwsh
az cognitiveservices account deployment create `
  --name $FOUNDRY `
  --resource-group $RG `
  --deployment-name $EMBEDDING_DEPLOYMENT `
  --model-name text-embedding-3-small `
  --model-version "1" `
  --model-format OpenAI `
  --sku-name Standard `
  --sku-capacity 50
```

> **Not (Voice Live):** Voice Live realtime hattı için ayrı bir Azure OpenAI deployment'ı **oluşturmanıza gerek yoktur**. Voice Live, deployment yerine Microsoft'un yönettiği hosted katalog modelini (`AZURE_VOICE_LIVE_MODEL=gpt-realtime`) doğrudan kullanır. Bu nedenle bu rehberde ayrı bir realtime model deployment adımı yoktur.

Deployment'ları doğrula:

```pwsh
az cognitiveservices account deployment list `
  --name $FOUNDRY `
  --resource-group $RG `
  -o table
```

---

## 12. Endpoint Bilgilerini Topla

`.env` için gereken endpoint değerlerini çek:

```pwsh
$SPEECH_ID       = az cognitiveservices account show --name $SPEECH  --resource-group $RG --query id -o tsv
$DOCINT_ENDPOINT = az cognitiveservices account show --name $DOCINT  --resource-group $RG --query properties.endpoint -o tsv
$FOUNDRY_CS_EP   = az cognitiveservices account show --name $FOUNDRY --resource-group $RG --query properties.endpoint -o tsv
$FOUNDRY_OAI_EP  = "https://$FOUNDRY.openai.azure.com/"
$TENANT_ID       = az account show --query tenantId -o tsv
$SUB_ID          = az account show --query id -o tsv

Write-Host "AZURE_SPEECH_RESOURCE_ID            = $SPEECH_ID"
Write-Host "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT= $DOCINT_ENDPOINT"
Write-Host "AZURE_OPENAI_ENDPOINT               = $FOUNDRY_OAI_EP"
Write-Host "AZURE_VOICE_LIVE_ENDPOINT           = $FOUNDRY_CS_EP"
Write-Host "AZURE_TENANT_ID                     = $TENANT_ID"
Write-Host "AZURE_SUBSCRIPTION_ID               = $SUB_ID"
```

---

## 13. `.env` Dosyasını Oluştur

> **Önerilen:** Bu adımı elle doldurmak yerine, dokümanın sonundaki [**18. `.env` Dosyasını Otomatik Oluştur**](#18-env-dosyasını-otomatik-oluştur) adımındaki scripti kullanabilirsin. O script tüm endpoint ve isim değerlerini Azure'dan toplayıp dosyayı doğru şekilde doldurur.Eğer 18 ile devam edeceksen önce 14'ü de tamamla. Elle doldurmak istersen aşağıdaki şablonu kullan.

Repo kökünde `.env` oluştur:

```pwsh
Copy-Item .env.example .env
```

`.env` içeriğini aşağıdaki gibi doldur (değişkenlerden gelen değerleri yaz). **Servis kullanıcısı (SP) alanlarını 14. adımda dolduracaksın**, şimdilik boş bırak.

```env
AZURE_LOCATION=eastus2
AZURE_ENV_NAME=dev
AZURE_SUBSCRIPTION_ID=<sub-id>
AZURE_RESOURCE_GROUP=rg-voice-avatar-test

# Servis kullanıcısı (14. adımda doldurulacak)
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_MANAGED_IDENTITY_CLIENT_ID=

DEFAULT_LANGUAGE=tr-TR

VOICE_MODE_DEFAULT=voice-only
ENABLE_MODE_VOICE_ONLY=true
ENABLE_MODE_VIDEO_AVATAR=true

BACKEND_BASE_URL=http://localhost:8081
MCP_BASE_URL=http://localhost:8082

# Speech
AZURE_SPEECH_RESOURCE_ID=<speech-resource-id>
AZURE_SPEECH_ACCOUNT_NAME=spavatarhealthcaretest
AZURE_SPEECH_REGION=eastus2

# Search
AZURE_SEARCH_SERVICE=srchavatarhealthcaretest
AZURE_SEARCH_INDEX=knowledge-index

# Storage
AZURE_STORAGE_ACCOUNT=stavatarhealthcaretest
AZURE_STORAGE_CONTAINER=knowledge

# Document Intelligence
AZURE_DOCUMENT_INTELLIGENCE_ACCOUNT_NAME=docavatarhealthcaretest
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=<docint-endpoint>

# Azure AI Foundry (OpenAI) — bu RG içinde
AZURE_OPENAI_ACCOUNT_NAME=aifoundryavatarhealthcaretest
AZURE_OPENAI_RESOURCE_GROUP=rg-voice-avatar-test
AZURE_OPENAI_ENDPOINT=https://aifoundryavatarhealthcaretest.openai.azure.com/
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5.4
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small

AZURE_VOICE_LIVE_ENDPOINT=<foundry-cognitiveservices-endpoint>
AZURE_VOICE_LIVE_MODEL=gpt-realtime
AZURE_VOICE_LIVE_API_VERSION=2025-05-01-preview
AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL=azure-speech
AZURE_VOICE_LIVE_VAD=azure_semantic_vad_multilingual
AZURE_AUTH_MODE=service-principal
KNOWLEDGE_USE_AZURE_CLI_CREDENTIAL=false
```

> `AZURE_OPENAI_RESOURCE_GROUP`, Foundry'yi aynı RG içinde oluşturduğumuz için `$RG` ile aynıdır. Bu, 14. adımdaki scriptin Foundry rollerini doğru scope'a atamasını sağlar.

---

## 14. Servis Kullanıcısı (SP) Oluştur ve Tüm Yetkileri Ata

Bu tek komut şunları yapar:

- Bir **service principal** (servis kullanıcısı) oluşturur.
- Speech, Document Intelligence, Search, Storage ve Foundry üzerinde gereken tüm **RBAC rollerini** atar.
- Mevcut kullanıcına da aynı rolleri verir (`-AssignCurrentUser`).
- Search için AAD (RBAC) veri düzlemi erişimini açar ve tüm kaynaklarda anahtar (key) erişimini kapatır (`-DisableLocalAuth`).

```pwsh
$SUB_ID = az account show --query id -o tsv

# Oluşturulacak servis kullanıcısının (service principal) adı
$SP_NAME = "sp-voice-avatar-healthcare-test"

./scripts/setup-service-identity.ps1 `
  -SubscriptionId $SUB_ID `
  -ResourceGroup $RG `
  -Location $LOCATION `
  -ServicePrincipalName $SP_NAME `
  -SpeechAccountName $SPEECH `
  -SearchServiceName $SEARCH `
  -StorageAccountName $STORAGE `
  -FoundryResourceGroup $RG `
  -FoundryAccountName $FOUNDRY `
  -CreateServicePrincipal `
  -AssignCurrentUser `
  -DisableLocalAuth
```

> Document Intelligence kaynağını script `$RG` içinden otomatik keşfeder (`kind=FormRecognizer`), bu yüzden ayrıca vermene gerek yok. `-ServicePrincipalName` verilmezse script varsayılan olarak `sp-speechavatarassistantapp-dev` adını kullanır.
>
> **Alternatif:** `.env` dosyasını 13. adımda elle **kaynak isimleriyle** doldurduysan, parametreleri geçmeden kısa formu da kullanabilirsin:
> ```pwsh
> ./scripts/setup-service-identity.ps1 -CreateServicePrincipal -AssignCurrentUser -DisableLocalAuth
> ```

Script çıktısının sonunda görünen değerleri `.env` içine yaz:

```env
AZURE_CLIENT_ID=<script çıktısındaki appId>
AZURE_TENANT_ID=<script çıktısındaki tenantId>
AZURE_CLIENT_SECRET=<script çıktısındaki secret>
```

> **Önemli:** `AZURE_CLIENT_SECRET` sadece bir kez gösterilir; güvenli sakla. RBAC atamalarının yayılması birkaç dakika sürebilir.

Atanan roller (özet):

| Kaynak | Rol |
|--------|-----|
| Speech | Cognitive Services User |
| Document Intelligence | Cognitive Services User |
| Search | Search Index Data Contributor |
| Storage | Storage Blob Data Contributor |
| Foundry (OpenAI) | Cognitive Services OpenAI User |
| Foundry (Voice Live) | Cognitive Services User |

---

## 15. Bilgi Tabanını Yükle (Knowledge Ingestion)

> **Ön koşul:** Bu adım repo kökündeki `.env` dosyasını okur. Devam etmeden önce `.env` **dolu** olmalı
>
> `Missing required environment variables: AZURE_SEARCH_SERVICE, AZURE_STORAGE_ACCOUNT, AZURE_OPENAI_ENDPOINT` hatası tam olarak `.env`'in eksik/boş olduğunu gösterir.
>
> Hızlı kontrol (repo kökünde):
> ```pwsh
Test-Path .env
Select-String -Path .env -Pattern 'AZURE_SEARCH_SERVICE|AZURE_STORAGE_ACCOUNT|AZURE_OPENAI_ENDPOINT'
> ```

Search index'ini oluştur, örnek dokümanları Blob'a yükle ve index'e işle:

```pwsh
cd scripts/knowledge-ingestion
npm run create-index
npm run upload-samples
npm run sync
cd ../..
```

Beklenen sonuç: `knowledge-index` içinde chunk bazlı kayıtlar oluşur; MCP servisi `answer_question` çağrılarında bu içeriği kullanır.

> Kendi dokümanlarınla çalışmak istersen `scripts/knowledge-ingestion/sample-docs/` altına dosya ekleyip tekrar `npm run sync` çalıştır. Otomatik izleme için `npm run watch` kullan (varsayılan 60 sn aralık).

---

## 16. Uygulamaları Lokalde Çalıştır

Repo kökünden tüm servisleri ayrı terminallerde başlat:

```pwsh
./start-all.cmd
```

Bu üç servisi ayağa kaldırır:

| Servis | Adres |
|--------|-------|
| frontend | http://localhost:8080 |
| backend | http://localhost:8081 |
| mcp-server | http://localhost:8082 |

Manuel başlatmak istersen (üç ayrı terminalde):

```pwsh
cd mcp-server; $env:PORT=8082; npm start
cd backend;    $env:PORT=8081; npm start
cd frontend;   $env:PORT=8080; npm start
```

ya da üç servisi de tek seferde başlatmak için:

```pwsh
.\start-all.cmd  
```
---

## 17. Doğrulama

1. Tarayıcıda `http://localhost:8080` adresini aç.
2. Konuşma/avatar modunu başlat; mikrofon izni ver.
3. Bir soru sor — cevap, RAG (Search) üzerinden grounded gelmelidir.
4. Sorun olursa backend ve mcp-server terminallerindeki logları incele.

Hızlı bağlantı testleri:

```pwsh
# Backend Speech token üretebiliyor mu?
curl http://localhost:8081/api/speech/token

# Deployment'lar yerinde mi?
az cognitiveservices account deployment list --name $FOUNDRY --resource-group $RG -o table
```

---

## 18. `.env` Dosyasını Otomatik Oluştur

Aşağıdaki script, Azure'da oluşturduğun kaynaklardan tüm endpoint ve isim değerlerini toplayarak repo kökünde **`.env`** adında hazır bir dosya üretir.

> **Sıra:** Bu scripti **14. adımdan sonra** (servis kullanıcısı oluştuktan sonra) ve **15. adımdan önce** (knowledge ingestion'dan önce) çalıştır. Aynı PowerShell oturumunda çalışıyorsan 3. adımda tanımladığın değişkenler zaten hazırdır; farklı bir oturumda çalıştırıyorsan aşağıdaki değişken bloğunu kendi değerlerinle güncelle.

```pwsh
# --- 3. adımdaki değerlerle aynı olmalı (aynı oturumdaysan atlayabilirsin) ---

$LOCATION   = "eastus2"
$RG         = "rg-voice-avatar-healthcare-test"
$SPEECH     = "spavatarhealthcaretest"
$SEARCH     = "srchavatarhealthcaretest"
$DOCINT     = "docavatarhealthcaretest"
$STORAGE    = "stavatarhealthcaretest"
$CONTAINER  = "knowledge"
$FOUNDRY    = "aifoundryavatarhealthcaretest"
$CHAT_DEPLOYMENT      = "gpt-5.4"
$EMBEDDING_DEPLOYMENT = "text-embedding-3-small"

# --- 14. adımın (setup-service-identity.ps1) çıktısından gelen servis kullanıcısı değerleri ---
$AZURE_CLIENT_ID=""
$AZURE_CLIENT_SECRET=""

# --- Azure'dan endpoint / id değerlerini topla ---
$SUB_ID          = az account show --query id -o tsv
$TENANT_ID       = az account show --query tenantId -o tsv
$SPEECH_ID       = az cognitiveservices account show --name $SPEECH  --resource-group $RG --query id -o tsv
$DOCINT_ENDPOINT = az cognitiveservices account show --name $DOCINT  --resource-group $RG --query properties.endpoint -o tsv
$FOUNDRY_CS_EP   = az cognitiveservices account show --name $FOUNDRY --resource-group $RG --query properties.endpoint -o tsv
$FOUNDRY_OAI_EP  = "https://$FOUNDRY.openai.azure.com/"

# --- .env.development içeriğini oluştur ---
$envContent = @"
AZURE_LOCATION=$LOCATION
AZURE_ENV_NAME=dev
AZURE_SUBSCRIPTION_ID=$SUB_ID
AZURE_RESOURCE_GROUP=$RG

AZURE_TENANT_ID=$TENANT_ID
AZURE_CLIENT_ID=$AZURE_CLIENT_ID
AZURE_CLIENT_SECRET=$AZURE_CLIENT_SECRET
AZURE_MANAGED_IDENTITY_CLIENT_ID=

DEFAULT_LANGUAGE=tr-TR

VOICE_MODE_DEFAULT=voice-only
ENABLE_MODE_VOICE_ONLY=true
ENABLE_MODE_VIDEO_AVATAR=true

BACKEND_BASE_URL=http://localhost:8081
MCP_BASE_URL=http://localhost:8082

AZURE_SPEECH_RESOURCE_ID=$SPEECH_ID
AZURE_SPEECH_ACCOUNT_NAME=$SPEECH
AZURE_SPEECH_REGION=$LOCATION

AZURE_SEARCH_SERVICE=$SEARCH
AZURE_SEARCH_INDEX=knowledge-index

AZURE_STORAGE_ACCOUNT=$STORAGE
AZURE_STORAGE_CONTAINER=$CONTAINER

AZURE_DOCUMENT_INTELLIGENCE_ACCOUNT_NAME=$DOCINT
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=$DOCINT_ENDPOINT

AZURE_OPENAI_ACCOUNT_NAME=$FOUNDRY
AZURE_OPENAI_RESOURCE_GROUP=$RG
AZURE_OPENAI_ENDPOINT=$FOUNDRY_OAI_EP
AZURE_OPENAI_CHAT_DEPLOYMENT=$CHAT_DEPLOYMENT
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=$EMBEDDING_DEPLOYMENT

AZURE_VOICE_LIVE_ENDPOINT=$FOUNDRY_CS_EP
AZURE_VOICE_LIVE_MODEL=gpt-realtime
AZURE_VOICE_LIVE_API_VERSION=2025-05-01-preview
AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL=azure-speech
AZURE_VOICE_LIVE_VAD=azure_semantic_vad_multilingual

AZURE_AUTH_MODE=service-principal
KNOWLEDGE_USE_AZURE_CLI_CREDENTIAL=false
"@

# --- Repo kökünü bul (azure.yaml'a göre yukarı doğru ara) ve .env olarak yaz ---
$repoRoot = (Get-Location).Path
while ($repoRoot -and -not (Test-Path (Join-Path $repoRoot 'azure.yaml'))) {
  $parent = Split-Path $repoRoot -Parent
  if (-not $parent -or $parent -eq $repoRoot) { $repoRoot = $null; break }
  $repoRoot = $parent
}
if (-not $repoRoot) {
  throw "Repo kökü bulunamadı (azure.yaml yok). Repo kök dizininde çalıştır: cd C:\Projects\voice-live-avatar"
}
$envPath = Join-Path $repoRoot ".env"
Set-Content -Path $envPath -Value $envContent -Encoding utf8 -NoNewline
Write-Host ".env oluşturuldu: $envPath" -ForegroundColor Green
```

> **Not:** Script, bulunduğun dizinden yukarı doğru `azure.yaml` arayarak repo kökünü bulur ve `.env`'i **her zaman repo köküne** yazar; alt klasörden (ör. `scripts/knowledge-ingestion`) çalıştırsan bile doğru yere yazılır. Boş gelen bir alan görürsen ilgili `az ... show` komutunun çıktısını ve kaynak isimlerini kontrol et.

Artık repo kökündeki `.env` doğru değerlerle dolu; 15. adım (knowledge ingestion) ve 16. adım (uygulamaları çalıştırma) ile devam edebilirsin.

> Var olan bir `.env` üzerine yazılır. Önce yedek almak istersen: `Copy-Item .env .env.bak -Force`.

---

## Sık Karşılaşılan Sorunlar

| Belirti | Olası neden | Çözüm |
|---------|-------------|-------|
| Search çağrılarında `403` | RBAC henüz yayılmadı veya AAD veri düzlemi kapalı | Birkaç dk bekle; `setup-service-identity.ps1` tekrar çalıştır |
| İndeks oluşturmada `403` (`create-index`) | SP/kullanıcıda yalnızca `Search Index Data Contributor` var, `Search Service Contributor` yok | `setup-service-identity.ps1` tekrar çalıştır (artık `Search Service Contributor` de atar) |
| `Speech token request failed with 500: fetch failed` | Speech kaynağı `--custom-domain` olmadan oluşturulmuş; Entra ID token değişimi için custom subdomain hostname'i yok | Speech kaynağını `--custom-domain $SPEECH` ile **yeniden oluştur** (6. adım), sonra RBAC'ı tekrar ata |
| `Missing required environment variables` | `.env` eksik | 13. adımdaki tüm alanları doldur |
| Model deployment hatası (quota) | Bölgede kota yok | İlgili model için kota talebi aç veya bölge değiştir |
| Voice Live bağlanamıyor | Foundry custom domain / endpoint yanlış | `AZURE_VOICE_LIVE_ENDPOINT` cognitiveservices endpoint olmalı |
| Voice Live bağlanıp hemen/~5 sn sonra kapanıyor (`ECONNRESET` / code 1006) | `AZURE_VOICE_LIVE_MODEL`'e deployment adı (`gpt-realtime-2.1`) verilmiş **veya** desteklenmeyen transkripsiyon modeli | `AZURE_VOICE_LIVE_MODEL=gpt-realtime` (temel model adı) ve `AZURE_VOICE_LIVE_TRANSCRIPTION_MODEL=azure-speech` kullan; backend logunda `[VoiceLive] Upstream ...` satırlarına bak |
| Search kapasite hatası | Bölge kapasitesi dolu | Search'ü farklı bölgede oluştur (7. adım) |
| Türkçe için "Unsupported locales: tr" | Voice Live `turn_detection.languages` alanına `tr` gönderilmiş | Türkçe için bu alanı boş bırak |

---

## Özet Sıra (Checklist)

1. Repoyu klonla + `npm install` (frontend, backend, mcp-server, knowledge-ingestion)
2. `az login` + subscription seç
3. Değişkenleri tanımla
4. Provider'ları kaydet
5. Resource group oluştur
6. Speech oluştur
7. Search oluştur
8. Document Intelligence oluştur
9. Storage + container oluştur
10. Azure AI Foundry (AIServices) oluştur
11. Modelleri deploy et (chat, embedding, realtime)
12. Endpoint bilgilerini topla
13. `.env` doldur (elle) **veya** 18. adımdaki scriptle otomatik üret
14. `setup-service-identity.ps1` ile SP + RBAC + keyless
15. Knowledge ingestion (create-index → upload-samples → sync)
16. `./start-all.cmd`
17. Doğrula
18. (Önerilen) `.env` üret ve `Copy-Item .env .env -Force` ile `.env` ile değiştir — **14. adımdan sonra / 15. adımdan önce** çalıştır

> **İpucu:** 13. adımı elle yapmak yerine 18. adımdaki scripti kullanman önerilir; tüm endpoint ve değerleri Azure'dan toplayıp `.env`'i doğru şekilde doldurur.
