import { describe, expect, it } from 'vitest'
import { sha256Base64Url, sha256Hex } from '../../src/core/digest.js'

describe('Web Crypto digests', () => {
  it('produces hexadecimal and base64url SHA-256 values', async () => {
    await expect(sha256Hex('hello')).resolves.toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    await expect(sha256Base64Url('hello')).resolves.toBe('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')
  })
})
