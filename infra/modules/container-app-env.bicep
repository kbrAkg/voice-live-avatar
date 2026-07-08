param location string = resourceGroup().location
param containerAppEnvironmentName string
param logAnalyticsWorkspaceResourceId string
param tags object = {}

resource containerAppEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: reference(logAnalyticsWorkspaceResourceId, '2023-09-01').customerId
        sharedKey: listKeys(logAnalyticsWorkspaceResourceId, '2023-09-01').primarySharedKey
      }
    }
    zoneRedundant: false
  }
  tags: tags
}

output containerAppEnvironmentResourceId string = containerAppEnvironment.id
output defaultDomain string = containerAppEnvironment.properties.defaultDomain
