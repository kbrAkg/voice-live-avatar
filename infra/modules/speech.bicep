param location string = resourceGroup().location
param speechName string
param tags object = {}

resource speech 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: speechName
  location: location
  kind: 'SpeechServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: speechName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
  tags: tags
}

output speechAccountName string = speech.name
output speechEndpoint string = speech.properties.endpoint
output speechResourceId string = speech.id
