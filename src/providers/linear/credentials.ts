import type { LinearCredentialCipher } from './types.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createLinearCredentialCipher(encodedKey: string): LinearCredentialCipher {
  const bytes = decodeBase64(encodedKey)
  if (bytes.byteLength !== 32) throw new TypeError('Linear credential encryption key must contain 32 bytes.')
  const key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])

  return {
    async seal(value, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
        await key,
        encoder.encode(value),
      )
      return `v1.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`
    },
    async open(value, context) {
      const [version, encodedIv, encodedCiphertext] = value.split('.')
      if (version !== 'v1' || !encodedIv || !encodedCiphertext) {
        throw new TypeError('Linear credential ciphertext is invalid.')
      }
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decodeBase64(encodedIv), additionalData: encoder.encode(context) },
        await key,
        decodeBase64(encodedCiphertext),
      )
      return decoder.decode(plaintext)
    },
  }
}

function encodeBase64(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function decodeBase64(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  } catch {
    throw new TypeError('Linear credential encryption key is not valid base64.')
  }
}
