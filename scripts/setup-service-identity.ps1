#requires -Version 7.0
<#
.SYNOPSIS
  Uygulamanin tum Azure servislerine key/anahtar yerine RBAC tabanli (keyless)
  bir "servis kullanicisi" ile baglanmasini saglar.

.DESCRIPTION
  Bu script iki tur servis kimligi olusturabilir ve her ikisine de ayni RBAC
  rollerini atar:

    1. User-Assigned Managed Identity (UAMI)  -> Azure icinde (Container Apps) calisan
       production kimligi. Hicbir secret icermez. Container App'lere baglanir.

    2. Service Principal (SP)                 -> Local gelistirme / CI / knowledge
       ingestion icin kullanilan "servis kullanicisi". Managed identity Azure disinda
       calismadigi icin local senaryolarda bu kimlik kullanilir.

  Ayrica istege bagli olarak Azure kaynaklarinda local (key) auth'u kapatir
  (-DisableLocalAuth) ve mevcut giris yapan kullaniciya da ayni rolleri verir
  (-AssignCurrentUser).

  Atanan roller (tek servis kullanicisi, superset):
    - Cognitive Services User            -> Speech, Document Intelligence
    - Cognitive Services OpenAI User     -> Foundry / Azure OpenAI (harici RG)
    - Cognitive Services User (Foundry)  -> Voice Live realtime (harici RG)
    - Search Index Data Contributor      -> Azure AI Search (veri: doküman okuma/yazma)
    - Search Service Contributor         -> Azure AI Search (yönetim: indeks oluşturma)
    - Storage Blob Data Contributor      -> Azure Storage
    - AcrPull                            -> Azure Container Registry

.EXAMPLE
  # .env dosyasindan degerleri okuyarak UAMI + SP olustur ve local auth'u kapat
  ./scripts/setup-service-identity.ps1 `
    -CreateManagedIdentity `
    -CreateServicePrincipal `
    -DisableLocalAuth

.EXAMPLE
  # Sadece local gelistirme icin service principal olustur
  ./scripts/setup-service-identity.ps1 -CreateServicePrincipal
#>
[CmdletBinding()]
param(
  [string]$SubscriptionId,
  [string]$ResourceGroup,
  [string]$Location = 'eastus2',
  [string]$BaseName = 'speechavatarassistantapp',
  [string]$EnvironmentName = 'dev',

  [string]$ManagedIdentityName,
  [string]$ServicePrincipalName,

  [string]$SpeechAccountName,
  [string]$SearchServiceName,
  [string]$StorageAccountName,
  [string]$DocIntAccountName,
  [string]$AcrName,

  [string]$FoundryResourceGroup,
  [string]$FoundryAccountName,

  [switch]$CreateManagedIdentity,
  [switch]$CreateServicePrincipal,
  [switch]$AssignCurrentUser,
  [switch]$DisableLocalAuth,
  [switch]$SkipRoleAssignments
)

$ErrorActionPreference = 'Stop'

# --- Built-in role definition IDs ---------------------------------------------
$Roles = @{
  CognitiveServicesUser        = 'a97b65f3-24c7-4388-baec-2e87135dc908'
  CognitiveServicesOpenAIUser  = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  SearchIndexDataContributor   = '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  SearchServiceContributor     = '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
  StorageBlobDataContributor   = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  AcrPull                      = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

function Write-Section($text) {
  Write-Host ''
  Write-Host "==== $text ====" -ForegroundColor Cyan
}

function Read-DotEnv {
  param([string]$Path)
  $result = @{}
  if (-not (Test-Path $Path)) { return $result }
  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -lt 1) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim()
    $result[$key] = $value
  }
  return $result
}

function Ensure-AzLogin {
  try {
    az account show --only-show-errors 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'not logged in' }
  } catch {
    Write-Host 'Azure CLI oturumu bulunamadi. "az login" calistiriliyor...' -ForegroundColor Yellow
    az login --only-show-errors 1>$null
  }
}

function Assign-Role {
  param(
    [Parameter(Mandatory)][string]$PrincipalId,
    [Parameter(Mandatory)][ValidateSet('ServicePrincipal', 'User')][string]$PrincipalType,
    [Parameter(Mandatory)][string]$RoleId,
    [string]$Scope = '',
    [Parameter(Mandatory)][string]$Description
  )

  if ([string]::IsNullOrWhiteSpace($Scope)) {
    Write-Host "  ! $Description atlaniyor (scope bos)." -ForegroundColor DarkYellow
    return
  }

  $existing = az role assignment list `
    --assignee $PrincipalId `
    --scope $Scope `
    --role $RoleId `
    --query "[0].id" -o tsv --only-show-errors 2>$null

  if ($existing) {
    Write-Host "  = $Description zaten atanmis." -ForegroundColor DarkGray
    return
  }

  az role assignment create `
    --assignee-object-id $PrincipalId `
    --assignee-principal-type $PrincipalType `
    --role $RoleId `
    --scope $Scope `
    --only-show-errors 1>$null

  if ($LASTEXITCODE -eq 0) {
    Write-Host "  + $Description atandi." -ForegroundColor Green
  } else {
    Write-Host "  ! $Description atanamadi. Manuel kontrol gerekebilir." -ForegroundColor Red
  }
}

function Assign-AllRoles {
  param(
    [Parameter(Mandatory)][string]$PrincipalId,
    [Parameter(Mandatory)][ValidateSet('ServicePrincipal', 'User')][string]$PrincipalType,
    [Parameter(Mandatory)][string]$Label
  )

  Write-Section "RBAC rolleri atalaniyor: $Label"

  Assign-Role -PrincipalId $PrincipalId -PrincipalType $PrincipalType `
    -RoleId $Roles.CognitiveServicesUser -Scope $script:SpeechScope `
    -Description 'Cognitive Services User (Speech)'

  Assign-Role -PrincipalId $PrincipalId -PrincipalType $PrincipalType `
    -RoleId $Roles.CognitiveServicesUser -Scope $script:DocIntScope `
    -Description 'Cognitive Services User (Document Intelligence)'

  Assign-Role -PrincipalId $PrincipalId -PrincipalType $PrincipalType `
    -RoleId $Roles.SearchIndexDataContributor -Scope $script:SearchScope `
    -Description 'Search Index Data Contributor'

  Assign-Role -PrincipalId $PrincipalId -PrincipalType $PrincipalType `
    -RoleId $Roles.SearchServiceContributor -Scope $script:SearchScope `
    -Description 'Search Service Contributor'

  Assign-Role -PrincipalId $PrincipalId -PrincipalType $PrincipalType `
    -RoleId $Roles.StorageBlobDataContributor -Scope $script:StorageScope `
    -Description 'Storage Blob Data Contributor'

  Assign-Role -PrincipalId $PrincipalId -PrincipalType $PrincipalType `
    -RoleId $Roles.AcrPull -Scope $script:AcrScope `
    -Description 'AcrPull (Container Registry)'

  Assign-Role -PrincipalId $PrincipalId -PrincipalType $PrincipalType `
    -RoleId $Roles.CognitiveServicesOpenAIUser -Scope $script:FoundryScope `
    -Description 'Cognitive Services OpenAI User (Foundry)'

  # Voice Live realtime endpoint'i OpenAI veri duzlemi disindadir; cognitiveservices
  # data-plane token'i icin Foundry kaynaginda Cognitive Services User de gerekir.
  Assign-Role -PrincipalId $PrincipalId -PrincipalType $PrincipalType `
    -RoleId $Roles.CognitiveServicesUser -Scope $script:FoundryScope `
    -Description 'Cognitive Services User (Foundry / Voice Live)'
}

# --- .env varsayilanlari ------------------------------------------------------
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$dotEnvPath = Join-Path $repoRoot '.env'
$dotEnv = Read-DotEnv -Path $dotEnvPath

if (-not $SubscriptionId)     { $SubscriptionId     = $dotEnv['AZURE_SUBSCRIPTION_ID'] }
if (-not $ResourceGroup)      { $ResourceGroup      = $dotEnv['AZURE_RESOURCE_GROUP'] }
if (-not $Location -and $dotEnv['AZURE_LOCATION']) { $Location = $dotEnv['AZURE_LOCATION'] }
if (-not $SpeechAccountName)  { $SpeechAccountName  = $dotEnv['AZURE_SPEECH_ACCOUNT_NAME'] }
if (-not $SearchServiceName)  { $SearchServiceName  = $dotEnv['AZURE_SEARCH_SERVICE'] }
if (-not $StorageAccountName) { $StorageAccountName = $dotEnv['AZURE_STORAGE_ACCOUNT'] }
if (-not $FoundryResourceGroup) { $FoundryResourceGroup = $dotEnv['AZURE_OPENAI_RESOURCE_GROUP'] }
if (-not $FoundryAccountName)   { $FoundryAccountName   = $dotEnv['AZURE_OPENAI_ACCOUNT_NAME'] }

if (-not $ManagedIdentityName)   { $ManagedIdentityName   = "id-$BaseName-$EnvironmentName" }
if (-not $ServicePrincipalName)  { $ServicePrincipalName  = "sp-$BaseName-$EnvironmentName" }

if (-not $SubscriptionId)  { throw 'SubscriptionId bulunamadi. -SubscriptionId ver veya .env AZURE_SUBSCRIPTION_ID doldur.' }
if (-not $ResourceGroup)   { throw 'ResourceGroup bulunamadi. -ResourceGroup ver veya .env AZURE_RESOURCE_GROUP doldur.' }

Ensure-AzLogin
az account set --subscription $SubscriptionId --only-show-errors 1>$null

$rgScope = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup"

# --- Kaynak scope'larini cikar ------------------------------------------------
Write-Section 'Kaynaklar kesfediliyor'

if (-not $DocIntAccountName) {
  $DocIntAccountName = az cognitiveservices account list -g $ResourceGroup `
    --query "[?kind=='FormRecognizer'].name | [0]" -o tsv --only-show-errors 2>$null
}
if (-not $AcrName) {
  $AcrName = az acr list -g $ResourceGroup --query "[0].name" -o tsv --only-show-errors 2>$null
}

$script:SpeechScope  = if ($SpeechAccountName)  { "$rgScope/providers/Microsoft.CognitiveServices/accounts/$SpeechAccountName" } else { '' }
$script:DocIntScope  = if ($DocIntAccountName)  { "$rgScope/providers/Microsoft.CognitiveServices/accounts/$DocIntAccountName" } else { '' }
$script:SearchScope  = if ($SearchServiceName)  { "$rgScope/providers/Microsoft.Search/searchServices/$SearchServiceName" } else { '' }
$script:StorageScope = if ($StorageAccountName) { "$rgScope/providers/Microsoft.Storage/storageAccounts/$StorageAccountName" } else { '' }
$script:AcrScope     = if ($AcrName)            { "$rgScope/providers/Microsoft.ContainerRegistry/registries/$AcrName" } else { '' }
$script:FoundryScope = if ($FoundryResourceGroup -and $FoundryAccountName) {
  "/subscriptions/$SubscriptionId/resourceGroups/$FoundryResourceGroup/providers/Microsoft.CognitiveServices/accounts/$FoundryAccountName"
} else { '' }

Write-Host "  Speech       : $($SpeechAccountName ?? '(yok)')"
Write-Host "  DocInt       : $($DocIntAccountName ?? '(yok)')"
Write-Host "  Search       : $($SearchServiceName ?? '(yok)')"
Write-Host "  Storage      : $($StorageAccountName ?? '(yok)')"
Write-Host "  ACR          : $($AcrName ?? '(yok)')"
Write-Host "  Foundry      : $($FoundryAccountName ?? '(yok)') @ $($FoundryResourceGroup ?? '(yok)')"

$tenantId = az account show --query tenantId -o tsv --only-show-errors

# --- 1) User-Assigned Managed Identity ---------------------------------------
$uamiClientId = $null
if ($CreateManagedIdentity) {
  Write-Section "User-Assigned Managed Identity: $ManagedIdentityName"

  az identity create `
    --name $ManagedIdentityName `
    --resource-group $ResourceGroup `
    --location $Location `
    --only-show-errors 1>$null

  $uamiPrincipalId = az identity show --name $ManagedIdentityName --resource-group $ResourceGroup --query principalId -o tsv --only-show-errors
  $uamiClientId    = az identity show --name $ManagedIdentityName --resource-group $ResourceGroup --query clientId -o tsv --only-show-errors
  $uamiResourceId  = az identity show --name $ManagedIdentityName --resource-group $ResourceGroup --query id -o tsv --only-show-errors

  Write-Host "  principalId : $uamiPrincipalId"
  Write-Host "  clientId    : $uamiClientId"
  Write-Host "  resourceId  : $uamiResourceId"

  if (-not $SkipRoleAssignments) {
    # Managed identity dogrulanip RBAC atamasi yapilmadan once kisa propagasyon beklemesi
    Start-Sleep -Seconds 10
    Assign-AllRoles -PrincipalId $uamiPrincipalId -PrincipalType 'ServicePrincipal' -Label 'Managed Identity'
  }
}

# --- 2) Service Principal (local / CI servis kullanicisi) ---------------------
$spAppId = $null
$spSecret = $null
if ($CreateServicePrincipal) {
  Write-Section "Service Principal: $ServicePrincipalName"

  # Rol atamasini biz yapacagimiz icin --skip-assignment mantiginda olusturuyoruz.
  $spJson = az ad sp create-for-rbac `
    --name $ServicePrincipalName `
    --role "Reader" `
    --scopes $rgScope `
    --only-show-errors | ConvertFrom-Json

  $spAppId  = $spJson.appId
  $spSecret = $spJson.password
  $spObjectId = az ad sp show --id $spAppId --query id -o tsv --only-show-errors

  Write-Host "  appId    : $spAppId"
  Write-Host "  objectId : $spObjectId"
  Write-Host "  secret   : (asagidaki ozet bolumunde)" -ForegroundColor DarkGray

  if (-not $SkipRoleAssignments) {
    Start-Sleep -Seconds 10
    Assign-AllRoles -PrincipalId $spObjectId -PrincipalType 'ServicePrincipal' -Label 'Service Principal'
  }
}

# --- 3) Mevcut kullaniciya rol ver (local az login senaryosu) ----------------
if ($AssignCurrentUser -and -not $SkipRoleAssignments) {
  $currentUserId = az ad signed-in-user show --query id -o tsv --only-show-errors
  if ($currentUserId) {
    Assign-AllRoles -PrincipalId $currentUserId -PrincipalType 'User' -Label 'Mevcut kullanici'
  }
}

# --- 3.5) Azure AI Search icin AAD (RBAC) veri duzlemi erisimini ac -----------
# Azure AI Search varsayilan olarak yalnizca API key ile veri duzlemi erisimine
# izin verir. RBAC ile calisabilmesi icin authOptions.aadOrApiKey acilmalidir,
# aksi halde rol atanmis olsa bile data-plane cagrilari 403 doner.
if ($SearchServiceName -and -not $SkipRoleAssignments) {
  Write-Section 'Search: AAD (RBAC) veri duzlemi erisimi aciliyor'
  az search service update `
    --name $SearchServiceName `
    --resource-group $ResourceGroup `
    --auth-options aadOrApiKey `
    --aad-auth-failure-mode http403 `
    --only-show-errors 1>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host '  + Search: authOptions=aadOrApiKey (RBAC data-plane aktif)' -ForegroundColor Green
  } else {
    Write-Host '  ! Search authOptions guncellenemedi. Manuel kontrol gerekebilir.' -ForegroundColor Red
  }
}

# --- 4) Local (key) auth kapat -----------------------------------------------
if ($DisableLocalAuth) {
  Write-Section 'Kaynaklarda local (key) auth kapatiliyor'

  if ($SpeechAccountName) {
    az resource update --ids $script:SpeechScope --set properties.disableLocalAuth=true --only-show-errors 1>$null
    Write-Host '  + Speech: disableLocalAuth=true' -ForegroundColor Green
  }
  if ($DocIntAccountName) {
    az resource update --ids $script:DocIntScope --set properties.disableLocalAuth=true --only-show-errors 1>$null
    Write-Host '  + Document Intelligence: disableLocalAuth=true' -ForegroundColor Green
  }
  if ($SearchServiceName) {
    # Search icin disableLocalAuth=true => yalnizca AAD (key auth tamamen kapali)
    az search service update --name $SearchServiceName --resource-group $ResourceGroup --disable-local-auth true --only-show-errors 1>$null
    Write-Host '  + Search: disableLocalAuth=true (yalnizca AAD)' -ForegroundColor Green
  }
  if ($StorageAccountName) {
    az storage account update --name $StorageAccountName --resource-group $ResourceGroup --allow-shared-key-access false --only-show-errors 1>$null
    Write-Host '  + Storage: allowSharedKeyAccess=false' -ForegroundColor Green
  }
}

# --- Ozet ---------------------------------------------------------------------
Write-Section 'OZET / .env icin degerler'

Write-Host "AZURE_TENANT_ID=$tenantId"
if ($uamiClientId) {
  Write-Host ''
  Write-Host '# Container Apps (production) icin managed identity clientId:' -ForegroundColor DarkGray
  Write-Host "AZURE_MANAGED_IDENTITY_CLIENT_ID=$uamiClientId"
}
if ($spAppId) {
  Write-Host ''
  Write-Host '# Local gelistirme / CI icin service principal (bu degerleri .env icine yaz):' -ForegroundColor DarkGray
  Write-Host "AZURE_CLIENT_ID=$spAppId"
  Write-Host "AZURE_TENANT_ID=$tenantId"
  Write-Host "AZURE_CLIENT_SECRET=$spSecret"
  Write-Host ''
  Write-Host '! AZURE_CLIENT_SECRET yalnizca bir kez gosterilir; guvenli sekilde sakla.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Bitti. Notlar:' -ForegroundColor Cyan
Write-Host '  - RBAC atamalarinin yayilmasi birkac dakika surebilir.'
Write-Host '  - Container App deploy sonrasi UAMI infra tarafindan otomatik baglanir (infra/main.bicep).'
Write-Host '  - Local calistirirken .env icindeki eski KEY alanlarini SIL ve yeni kimlik alanlarini kullan.'
