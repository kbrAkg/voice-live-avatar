param environmentName string
param location string = 'eastus2'
param baseName string = 'assistantapp'

var normalizedBaseName = toLower(replace(baseName, '-', ''))
var suffix = toLower(replace(environmentName, '-', ''))

output naming object = {
  speech: '${normalizedBaseName}${suffix}sp'
  search: '${normalizedBaseName}${suffix}srch'
  docint: '${normalizedBaseName}${suffix}doc'
  storage: take('${normalizedBaseName}${suffix}st', 24)
  acr: '${normalizedBaseName}${suffix}acr'
  identity: '${normalizedBaseName}-${environmentName}-id'
  cae: '${normalizedBaseName}-${environmentName}-cae'
  frontendApp: '${normalizedBaseName}-${environmentName}-frontend'
  backendApp: '${normalizedBaseName}-${environmentName}-backend'
  mcpApp: '${normalizedBaseName}-${environmentName}-mcp'
  logAnalytics: '${normalizedBaseName}-${environmentName}-log'
  appInsights: '${normalizedBaseName}-${environmentName}-appi'
}

output tags object = {
  environment: environmentName
  region: location
  architecture: 'voice-live-avatar-rag'
  managedBy: 'azd-bicep'
  domainProfile: 'configurable'
}
