# Local Azure Service Setup With Existing Foundry

Bu dokuman, uygulamalari localde calistirirken Azure tarafinda sadece gerekli managed servisleri kurmak icin hazirlandi.

Bu akista yeni bir Azure OpenAI kaynagi olusturulmaz. Mevcut Azure AI Foundry / Azure OpenAI kaynagi yeniden kullanilir.

## Hedef

- Frontend, backend ve mcp-server localde calisacak.
- Azure tarafinda sadece gerekli servisler kurulacak.
- Model erisimi mevcut Foundry/OpenAI kaynagindan alinacak.
- `azd up` ve `azd provision` kullanilmayacak.

## Gerekli Azure Servisleri

- Azure Speech
- Azure AI Search
- Azure Document Intelligence
- Azure Storage Account + Blob Container
- Mevcut Azure AI Foundry / Azure OpenAI kaynagi

## Neden `azd` Kullanilmiyor?

Bu repository icindeki `azd` akisi sadece managed servisleri degil, ayni zamanda ACR ve Container Apps gibi app hosting kaynaklarini da olusturmaya calisir.

Bu senaryoda uygulamalar Azure'a deploy edilmeyecegi icin `azd` gereksiz ve yanlis kapsamda kalir.

## 1. Azure Login ve Subscription Secimi

```pwsh
az login
az account set --subscription "942b2575-7d08-4a36-bbe2-89dde4e4c6bd"
```

## 2. Degiskenleri Hazirla

Degerleri ihtiyacina gore guncelleyebilirsin.

```pwsh
$LOCATION="eastus2"
$RG="rg-speech-avatar-poc"

$SPEECH="spavatarpoc001"
$SEARCH="srchavatarpoc001"
$DOCINT="docavatarpoc001"
$STORAGE="stavatarpoc001"
$CONTAINER="knowledge"

$FOUNDRY_RG="rg-ka-demo"
$FOUNDRY_ACCOUNT="mf-ka-demo-eus2"
```

Notlar:

- Storage account adi global unique olmali ve sadece kucuk harf/rakam icermeli.
- Search ve Cognitive Services isimleri de global unique olmali.
- Cakisma olursa isim sonuna tarih veya kisa suffix ekle.

## 3. Resource Provider Kayitlari

```pwsh
az provider register --namespace Microsoft.CognitiveServices
az provider register --namespace Microsoft.Search
az provider register --namespace Microsoft.Storage
```

## 4. Resource Group Olustur

```pwsh
az group create --name $RG --location $LOCATION
```

## 5. Azure Speech Olustur

```pwsh
az cognitiveservices account create `
  --name $SPEECH `
  --resource-group $RG `
  --location $LOCATION `
  --kind SpeechServices `
  --sku S0 `
  --yes
```

## 6. Azure AI Search Olustur

```pwsh
az search service create `
  --name $SEARCH `
  --resource-group $RG `
  --location $LOCATION `
  --sku standard
```

### East US 2 kapasite hatasi alirsan

Azure AI Search bazen belirli bir region'da yeni capacity veremeyebilir. Asagidaki hata bunun tipik ornegidir:

```text
(InsufficientResourcesAvailable) The region 'eastus2' is currently out of the resources required to provision new services.
```

Bu durumda local test senaryosu icin en dogru hareket, sadece Search servisini yakin ve desteklenen baska bir region'da olusturmaktir.

Onerilen sira:

1. Once `eastus`, sonra `centralus` veya `westus2` dene.
2. Speech ve mevcut Foundry/OpenAI kaynagini mevcut region'larinda birak.
3. Local test icin tek region zorunlulugunu gecici olarak gevset.

Ornek:

```pwsh
$SEARCH_LOCATION="eastus"

az search service create `
  --name $SEARCH `
  --resource-group $RG `
  --location $SEARCH_LOCATION `
  --sku standard
```

Kurulumdan sonra `.env` icinde Search icin servis adini kullanmaya devam edersin; mevcut kod Search region bilgisini ayrica istemiyor.

## 7. Azure Document Intelligence Olustur

```pwsh
az cognitiveservices account create `
  --name $DOCINT `
  --resource-group $RG `
  --location $LOCATION `
  --kind FormRecognizer `
  --sku S0 `
  --yes
```

## 8. Storage Account ve Blob Container Olustur

```pwsh
az storage account create `
  --name $STORAGE `
  --resource-group $RG `
  --location $LOCATION `
  --sku Standard_LRS `
  --kind StorageV2 `
  --min-tls-version TLS1_2 `
  --allow-blob-public-access false

az storage container create `
  --account-name $STORAGE `
  --name $CONTAINER `
  --auth-mode login
```

## 9. Mevcut Foundry/OpenAI Kaynagini Dogrula

Bu komutlar mevcut resource'un endpoint ve deployment bilgilerini gormek icin kullanilir.

```pwsh
az cognitiveservices account show `
  --name $FOUNDRY_ACCOUNT `
  --resource-group $FOUNDRY_RG `
  --query "{name:name,location:location,endpoint:properties.endpoint}" `
  -o json

az cognitiveservices account deployment list `
  --name $FOUNDRY_ACCOUNT `
  --resource-group $FOUNDRY_RG `
  -o table
```

Not etmen gereken bilgiler:

- Foundry/OpenAI endpoint
- Chat deployment name
- Embedding deployment name
- Realtime deployment name, kullanacaksan

Search, Speech, Storage ve Document Intelligence data-plane islemleri artik **key ile degil**, servis kullanicisina (service principal veya managed identity) atanan RBAC rolleri ile calisir. Bu nedenle `az search admin-key show` adimina gerek yoktur ve `AZURE_SEARCH_API_KEY` / `AZURE_SPEECH_KEY` alanlari kaldirilmistir.

## 10. Local Kullaniciya RBAC Ver

> Onerilen yol: Asagidaki manuel `az role assignment` komutlari yerine tek komutla
> servis kullanicisi olusturup tum rolleri atayan scripti kullan:
>
> ```pwsh
> ./scripts/setup-service-identity.ps1 -CreateServicePrincipal -AssignCurrentUser -DisableLocalAuth
> ```
>
> Bu script hem bir **service principal** (servis kullanicisi) olusturur, hem mevcut
> kullanicina rol verir, hem de kaynaklarda key auth'u kapatir. Ciktisindaki
> `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` degerlerini `.env` icine yaz.

Manuel yapmak istersen (referans amacli), signed-in user'a gerekli roller su sekilde verilir:

```pwsh
$USER_OBJECT_ID = az ad signed-in-user show --query id -o tsv
$SUB_ID = az account show --query id -o tsv
```

### Speech icin

```pwsh
az role assignment create `
  --assignee-object-id $USER_OBJECT_ID `
  --assignee-principal-type User `
  --role "Cognitive Services User" `
  --scope "/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.CognitiveServices/accounts/$SPEECH"
```

### Document Intelligence icin

```pwsh
az role assignment create `
  --assignee-object-id $USER_OBJECT_ID `
  --assignee-principal-type User `
  --role "Cognitive Services User" `
  --scope "/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.CognitiveServices/accounts/$DOCINT"
```

### Search icin

```pwsh
az role assignment create `
  --assignee-object-id $USER_OBJECT_ID `
  --assignee-principal-type User `
  --role "Search Index Data Contributor" `
  --scope "/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.Search/searchServices/$SEARCH"
```

### Storage icin

```pwsh
az role assignment create `
  --assignee-object-id $USER_OBJECT_ID `
  --assignee-principal-type User `
  --role "Storage Blob Data Contributor" `
  --scope "/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$STORAGE"
```

### Foundry/OpenAI icin

```pwsh
az role assignment create `
  --assignee-object-id $USER_OBJECT_ID `
  --assignee-principal-type User `
  --role "Cognitive Services OpenAI User" `
  --scope "/subscriptions/$SUB_ID/resourceGroups/$FOUNDRY_RG/providers/Microsoft.CognitiveServices/accounts/$FOUNDRY_ACCOUNT"
```

## 11. Kurulumu Dogrula

```pwsh
az cognitiveservices account show --name $SPEECH --resource-group $RG --query "{name:name,kind:kind,location:location}"
az search service show --name $SEARCH --resource-group $RG --query "{name:name,sku:sku.name,status:status}"
az cognitiveservices account show --name $DOCINT --resource-group $RG --query "{name:name,kind:kind,location:location}"
az storage account show --name $STORAGE --resource-group $RG --query "{name:name,location:primaryLocation}"
az cognitiveservices account deployment list --name $FOUNDRY_ACCOUNT --resource-group $FOUNDRY_RG -o table
```

## 12. Bu Asamada Neleri Olusturma

Bu local test senaryosunda sunlari olusturma:

- Azure OpenAI yeni resource
- Azure Container Registry
- Container Apps Environment
- Container Apps
- `azd up`
- `azd provision`

## 13. Bu Rehber Ile Ne Elde Edersin

Bu rehber ile:

- Azure servislerini hazir edersin
- Erişim ve RBAC tarafini tamamlarsin
- Local test ortamini hazir hale getirirsin

Backend ve mcp-server kodu bu servisleri (Speech token exchange, Foundry chat/embedding, Search vektor arama) RBAC uzerinden dogrudan cagirir; ayrica bir entegrasyon adimi gerekmez.

## 14. Sonraki Adim

Bu kurulum tamamlandiktan sonra `.env` dosyasina Foundry/Speech/Search/Storage bilgilerini ekle ve frontend, backend ile mcp-server'i localde calistir. Islevsel dogrulama icin [validation.md](c:/Users/kakgozluoglu/OneDrive%20-%20Microsoft/Desktop/Projects/azure-speech-avatar-poc/docs/validation.md) adimlarini takip et.