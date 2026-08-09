export interface BrokerRequestReplayStore {
  brokerRequestReplayStatements(input: { jti: string; expiresAt: number; now: number }): readonly D1PreparedStatement[]
  hasBrokerRequest(jti: string): Promise<boolean>
}
