import { createCredentialCipher } from '../../core/credential-cipher.js'
import type { LinearCredentialCipher } from './types.js'

export function createLinearCredentialCipher(encodedKey: string): LinearCredentialCipher {
  return createCredentialCipher(encodedKey)
}
