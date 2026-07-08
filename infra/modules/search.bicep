param location string = resourceGroup().location
param searchName string
param tags object = {}
param skuName string = 'standard'

resource search 'Microsoft.Search/searchServices@2025-02-01-preview' = {
  name: searchName
  location: location
  sku: {
    name: skuName
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hostingMode: 'default'
    partitionCount: 1
    replicaCount: 1
    publicNetworkAccess: 'enabled'
    disableLocalAuth: true
  }
  tags: tags
}

output searchResourceId string = search.id
output searchNameOut string = search.name
