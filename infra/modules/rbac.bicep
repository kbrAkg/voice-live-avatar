param assignments array = []

resource roleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for assignment in assignments: {
  name: guid(resourceGroup().id, assignment.principalId, assignment.roleDefinitionId)
  scope: resourceGroup()
  properties: {
    principalId: assignment.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', assignment.roleDefinitionId)
    principalType: 'ServicePrincipal'
  }
}]

output roleAssignmentCount int = length(roleAssignments)
