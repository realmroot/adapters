const encoder = new TextEncoder()

export async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Base64Url(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  const binary = String.fromCharCode(...digest)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
