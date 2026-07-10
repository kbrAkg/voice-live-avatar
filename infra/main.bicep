targetScope = 'resourceGroup'

@description('Environment name for naming and tags.')
param environmentName string = 'dev'

@description('Azure region. Default: eastus2 for Speech Avatar + Voice Live compatibility.')
param location string = 'eastus2'

@description('Domain-agnostic base name used in all resource names.')
param baseName string = 'assistantapp'

@description('Container image tags. Leave empty so first provision uses a placeholder image; azd deploy pushes and swaps the real image.')
param frontendImage string = ''
param backendImage string = ''
param mcpImage string = ''

@description('Search SKU for cost/performance tuning. Start with S1 equivalent: standard.')
param searchSkuName string = 'standard'

@description('Endpoint of an existing Azure AI Foundry / Azure OpenAI resource used for model access.')
param foundryEndpoint string = ''

@description('Chat/completions deployment name on the existing Foundry resource.')
param foundryChatDeployment string = ''

@description('Embedding deployment name on the existing Foundry resource.')
param foundryEmbeddingDeployment string = ''

module conventions './modules/resource-group-conventions.bicep' = {
  name: 'resourceNaming'
  params: {
    environmentName: environmentName
    location: location
    baseName: baseName
  }
}

var naming = conventions.outputs.naming
var tags = conventions.outputs.tags

// Tek paylasilan servis kimligi (service user). Tum container app'ler bunu kullanir
// ve tum RBAC atamalari bu kimlige yapilir. Hicbir yerde key/anahtar kullanilmaz.
module managedIdentity './modules/managed-identity.bicep' = {
  name: 'serviceIdentity'
  params: {
    location: location
    managedIdentityName: naming.identity
    tags: tags
  }
}

module speech './modules/speech.bicep' = {
  name: 'speech'
  params: {
    location: location
    speechName: naming.speech
    tags: tags
  }
}

module search './modules/search.bicep' = {
  name: 'search'
  params: {
    location: location
    searchName: naming.search
    skuName: searchSkuName
    tags: tags
  }
}

module documentIntelligence './modules/document-intelligence.bicep' = {
  name: 'documentIntelligence'
  params: {
    location: location
    documentIntelligenceName: naming.docint
    tags: tags
  }
}

module storage './modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    storageName: naming.storage
    tags: tags
  }
}

module acr './modules/container-registry.bicep' = {
  name: 'containerRegistry'
  params: {
    location: location
    acrName: naming.acr
    tags: tags
  }
}

module logging './modules/logging.bicep' = {
  name: 'logging'
  params: {
    location: location
    logAnalyticsName: naming.logAnalytics
    appInsightsName: naming.appInsights
    tags: tags
  }
}

module containerAppEnvironment './modules/container-app-env.bicep' = {
  name: 'containerAppEnvironment'
  params: {
    location: location
    containerAppEnvironmentName: naming.cae
    logAnalyticsWorkspaceResourceId: logging.outputs.logAnalyticsResourceId
    tags: tags
  }
}

// Container Apps FQDN = <appName>.<defaultDomain>. Build service-to-service URLs
// from the environment default domain so they resolve correctly in Azure.
var caeDefaultDomain = containerAppEnvironment.outputs.defaultDomain
var backendUrlValue = 'https://${naming.backendApp}.${caeDefaultDomain}'
var mcpUrlValue = 'https://${naming.mcpApp}.${caeDefaultDomain}'

var backendEnvVars = [
  {
    name: 'AZURE_MANAGED_IDENTITY_CLIENT_ID'
    value: managedIdentity.outputs.managedIdentityClientId
  }
  {
    name: 'AZURE_SPEECH_RESOURCE_ID'
    value: speech.outputs.speechResourceId
  }
  {
    name: 'AZURE_SPEECH_ACCOUNT_NAME'
    value: speech.outputs.speechAccountName
  }
  {
    name: 'AZURE_SPEECH_REGION'
    value: location
  }
  {
    name: 'AZURE_OPENAI_ENDPOINT'
    value: foundryEndpoint
  }
  {
    name: 'AZURE_OPENAI_CHAT_DEPLOYMENT'
    value: foundryChatDeployment
  }
  {
    name: 'AZURE_SEARCH_SERVICE'
    value: search.outputs.searchNameOut
  }
  {
    name: 'MCP_BASE_URL'
    value: mcpUrlValue
  }
  {
    name: 'AZURE_APPINSIGHTS_CONNECTION_STRING'
    value: logging.outputs.appInsightsConnectionString
  }
]

var mcpEnvVars = [
  {
    name: 'AZURE_MANAGED_IDENTITY_CLIENT_ID'
    value: managedIdentity.outputs.managedIdentityClientId
  }
  {
    name: 'AZURE_OPENAI_ENDPOINT'
    value: foundryEndpoint
  }
  {
    name: 'AZURE_OPENAI_CHAT_DEPLOYMENT'
    value: foundryChatDeployment
  }
  {
    name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT'
    value: foundryEmbeddingDeployment
  }
  {
    name: 'AZURE_SEARCH_SERVICE'
    value: search.outputs.searchNameOut
  }
  {
    name: 'AZURE_STORAGE_ACCOUNT'
    value: storage.outputs.storageAccountName
  }
  {
    name: 'AZURE_STORAGE_CONTAINER'
    value: storage.outputs.blobContainerNameOut
  }
]

module frontendApp './modules/container-app.bicep' = {
  name: 'frontendApp'
  params: {
    location: location
    appName: naming.frontendApp
    serviceName: 'frontend'
    containerAppEnvironmentResourceId: containerAppEnvironment.outputs.containerAppEnvironmentResourceId
    userAssignedIdentityResourceId: managedIdentity.outputs.managedIdentityResourceId
    acrLoginServer: acr.outputs.acrLoginServer
    imageName: frontendImage
    targetPort: 8080
    envVars: [
      {
        name: 'BACKEND_BASE_URL'
        value: backendUrlValue
      }
    ]
    tags: tags
  }
}

module backendApp './modules/container-app.bicep' = {
  name: 'backendApp'
  params: {
    location: location
    appName: naming.backendApp
    serviceName: 'backend'
    containerAppEnvironmentResourceId: containerAppEnvironment.outputs.containerAppEnvironmentResourceId
    userAssignedIdentityResourceId: managedIdentity.outputs.managedIdentityResourceId
    acrLoginServer: acr.outputs.acrLoginServer
    imageName: backendImage
    targetPort: 8080
    envVars: backendEnvVars
    tags: tags
  }
}

module mcpApp './modules/container-app.bicep' = {
  name: 'mcpApp'
  params: {
    location: location
    appName: naming.mcpApp
    serviceName: 'mcp-server'
    containerAppEnvironmentResourceId: containerAppEnvironment.outputs.containerAppEnvironmentResourceId
    userAssignedIdentityResourceId: managedIdentity.outputs.managedIdentityResourceId
    acrLoginServer: acr.outputs.acrLoginServer
    imageName: mcpImage
    targetPort: 8080
    envVars: mcpEnvVars
    tags: tags
  }
}

// Built-in role definition IDs
var cognitiveServicesUserRole = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var searchIndexDataContributorRole = '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
var storageBlobDataContributorRole = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var acrPullRole = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

// Tum atamalar tek servis kimligine (UAMI) ve resource group scope'una yapilir.
// Hedef servislerin tamami ayni resource group'ta oldugu icin RG-scope atama
// erisim icin yeterlidir. Foundry/OpenAI kaynagi harici resource group'ta oldugu
// icin o rol atamasi scripts/setup-service-identity.ps1 tarafindan yapilir.
var roleMatrix = [
  {
    principalId: managedIdentity.outputs.managedIdentityPrincipalId
    roleDefinitionId: cognitiveServicesUserRole
  }
  {
    principalId: managedIdentity.outputs.managedIdentityPrincipalId
    roleDefinitionId: searchIndexDataContributorRole
  }
  {
    principalId: managedIdentity.outputs.managedIdentityPrincipalId
    roleDefinitionId: storageBlobDataContributorRole
  }
  {
    principalId: managedIdentity.outputs.managedIdentityPrincipalId
    roleDefinitionId: acrPullRole
  }
]

module rbac './modules/rbac.bicep' = {
  name: 'rbacAssignments'
  params: {
    assignments: roleMatrix
  }
}

output frontendUrl string = 'https://${frontendApp.outputs.fqdn}'
output backendUrl string = 'https://${backendApp.outputs.fqdn}'
output mcpUrl string = 'https://${mcpApp.outputs.fqdn}'
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = acr.outputs.acrLoginServer
output roleAssignmentCount int = rbac.outputs.roleAssignmentCount
output serviceIdentityClientId string = managedIdentity.outputs.managedIdentityClientId
output serviceIdentityPrincipalId string = managedIdentity.outputs.managedIdentityPrincipalId
output serviceIdentityName string = managedIdentity.outputs.managedIdentityName
