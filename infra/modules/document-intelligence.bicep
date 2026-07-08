param location string = resourceGroup().location
param documentIntelligenceName string
param tags object = {}

resource docInt 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: documentIntelligenceName
  location: location
  kind: 'FormRecognizer'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: documentIntelligenceName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
  tags: tags
}

output documentIntelligenceResourceId string = docInt.id
output documentIntelligenceEndpoint string = docInt.properties.endpoint
