import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { sha256Base64Url } from '../../src/core/digest.js'
import { createRealmrootAuthenticator } from '../../src/core/realmroot-auth.js'

describe('Realmroot DPoP authentication', () => {
  it('validates issuer, audience, Agent actor, token binding, and proof replay', async () => {
    const issuer = 'https://id.example/api/auth'
    const audience = 'https://adapter.example/github/installations/42'
    const accessKeys = await generateKeyPair('RS256')
    const dpopKeys = await generateKeyPair('ES256')
    const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: 'access-1', alg: 'RS256' }
    const dpopJwk = await exportJWK(dpopKeys.publicKey)
    const now = 1_800_000_000_000
    const token = await new SignJWT({
      scope: 'github:metadata:read',
      cnf: { jkt: await calculateJwkThumbprint(dpopJwk) },
      act: { iss: issuer, sub: 'agt_1', sub_profile: 'ai_agent' },
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'access-1' })
      .setIssuer(issuer)
      .setSubject('org_1')
      .setAudience(audience)
      .setIssuedAt(now / 1000)
      .setExpirationTime(now / 1000 + 300)
      .sign(accessKeys.privateKey)
    const url = `${audience}/repositories`
    const proof = await new SignJWT({
      htu: url,
      htm: 'GET',
      ath: await sha256Base64Url(token),
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: dpopJwk })
      .setIssuedAt(now / 1000)
      .setJti('proof-1')
      .sign(dpopKeys.privateKey)
    const request = new Request(url, { headers: { authorization: `DPoP ${token}`, dpop: proof } })
    const authenticator = createRealmrootAuthenticator({
      issuer,
      jwks: { keys: [accessJwk] },
      replayStore: replayStore(),
      now: () => now,
    })

    await expect(authenticator.authenticate(request, audience)).resolves.toMatchObject({
      subject: 'org_1',
      actor: { issuer, subject: 'agt_1', profile: 'ai_agent' },
    })
    await expect(authenticator.authenticate(request, audience)).rejects.toThrow('already used')
  })

  it('rejects missing and invalid Realmroot credentials before authorization', async () => {
    const accessKeys = await generateKeyPair('RS256')
    const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: 'access-1', alg: 'RS256' }
    const authenticator = createRealmrootAuthenticator({
      issuer: 'https://id.example/api/auth',
      jwks: { keys: [accessJwk] },
      replayStore: replayStore(),
    })
    const url = 'https://adapter.example/github/installations/42/repositories'

    await expect(authenticator.authenticate(new Request(url), url)).rejects.toThrow('access token is required')
    await expect(
      authenticator.authenticate(new Request(url, { headers: { authorization: 'DPoP invalid' } }), url),
    ).rejects.toThrow('access token is invalid')
  })
})

function replayStore() {
  const proofs = new Set<string>()
  return {
    async claim(input: { keyThumbprint: string; jti: string }) {
      const key = `${input.keyThumbprint}:${input.jti}`
      if (proofs.has(key)) return false
      proofs.add(key)
      return true
    },
  }
}
