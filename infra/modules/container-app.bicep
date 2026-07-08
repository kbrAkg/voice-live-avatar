param location string = resourceGroup().location
param appName string
@description('azd service name used to map this Container App to a service in azure.yaml. Required for azd deploy to find the app.')
param serviceName string = ''
param containerAppEnvironmentResourceId string
@description('Resource id of the shared user-assigned managed identity (service user).')
param userAssignedIdentityResourceId string
param acrLoginServer string
@description('Container image (repo:tag) in ACR. Empty on first provision -> a public placeholder image is used until azd deploy pushes the real image.')
param imageName string = ''
param cpu string = '0.5'
param memory string = '1Gi'
param minReplicas int = 1
param maxReplicas int = 2
param ingressEnabled bool = true
param targetPort int = 8080
param externalIngress bool = true
param envVars array = []
param tags object = {}

// On the very first provision the ACR is empty, so a public placeholder image is
// used to let the Container App start. azd deploy then pushes the real image and
// updates the app (matched via the azd-service-name tag).
var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
var containerImage = empty(imageName) ? placeholderImage : '${acrLoginServer}/${imageName}'
var appTags = empty(serviceName) ? tags : union(tags, {
  'azd-service-name': serviceName
})

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnvironmentResourceId
    configuration: {
      ingress: ingressEnabled ? {
        external: externalIngress
        targetPort: targetPort
        transport: 'auto'
      } : null
      registries: [
        {
          server: acrLoginServer
          identity: userAssignedIdentityResourceId
        }
      ]
    }
    template: {
      containers: [
        {
          name: appName
          image: containerImage
          env: [for variable in envVars: {
            name: variable.name
            value: variable.value
          }]
          resources: {
            cpu: json(cpu)
            memory: memory
          }
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
  tags: appTags
}

output containerAppResourceId string = app.id
output fqdn string = ingressEnabled ? app.properties.configuration.ingress.fqdn : ''
