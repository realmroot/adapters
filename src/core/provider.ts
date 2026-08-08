export type ProviderManifest = Readonly<{
  schemaVersion: '0.1'
  provider: string
  status: 'design' | 'alpha' | 'beta' | 'stable' | 'deprecated'
  identity: Readonly<{
    level: 'native-agent' | 'native-service-principal' | 'brokered'
    visibleInProduct: boolean
    visibleInAuditLog: boolean
    attribution: 'provider-native' | 'content-injection' | 'audit-only'
  }>
  actorModes: readonly string[]
  credentialModes: readonly string[]
  resourceTypes: readonly string[]
  scopes: Readonly<Record<string, Readonly<{ providerPermissions: Readonly<Record<string, string>> }>>>
  operations: readonly Readonly<{ operationId: string; method: string; path: string; scope: string }>[]
  revocationSignals: readonly string[]
  nativeReadinessGaps: readonly string[]
  retirementCondition: string
}>
