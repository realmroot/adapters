export interface IdempotencyStore {
  execute(key: string | null, namespace: string, input: unknown, operation: () => Promise<Response>): Promise<Response>
}
