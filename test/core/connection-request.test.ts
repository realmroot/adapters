import { createServer } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import { createBrokerRequestVerifiers } from '../../src/core/connection-request.js'
import { GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE } from '../../src/providers/github/authorization-details.js'

let closeServer: (() => Promise<void>) | undefined

afterEach(async () => closeServer?.())

describe('Realmroot broker request authentication', () => {
  it('validates connection and revocation request signatures, audience, and lifetimes', async () => {
    const keys = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'realmroot-1', alg: 'RS256' }
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test JWKS server did not bind a TCP port.')
    closeServer = () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

    const config: AppConfig = {
      origin: 'https://adapter.example',
      realmrootIssuer: 'https://id.example/api/auth',
      realmrootJwksUrl: `http://127.0.0.1:${address.port}/jwks`,
    }
    const verifier = createBrokerRequestVerifiers(config)
    const now = Math.floor(Date.now() / 1000)
    const connection = await new SignJWT({
      state: 'state-1',
      connection_id: 'provider-connection-1',
      expected_external_subject: null,
      owner_type: 'user',
      callback_uri: 'https://id.example/api/account-connections/oauth/callback',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'github:metadata:read',
      authorization_details: [{ type: GITHUB_INSTALLATION_AUTHORIZATION_DETAIL_TYPE }],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'realmroot-1', typ: 'JWT' })
      .setIssuer(config.realmrootIssuer)
      .setSubject('user-1')
      .setAudience(`${config.origin}/github`)
      .setJti('connection-request-1')
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(keys.privateKey)
    const revocation = await new SignJWT({
      connection_id: 'provider-connection-1',
      resource_authorization_id: 'resource-authorization-1',
      broker_reference: 'broker-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'realmroot-1', typ: 'JWT' })
      .setIssuer(config.realmrootIssuer)
      .setSubject('user-1')
      .setAudience(`${config.origin}/github`)
      .setJti('revocation-request-1')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(keys.privateKey)

    await expect(verifier.verifyConnection(connection)).resolves.toMatchObject({
      sub: 'user-1',
      connection_id: 'provider-connection-1',
    })
    await expect(verifier.verifyRevocation(revocation)).resolves.toMatchObject({
      sub: 'user-1',
      broker_reference: 'broker-1',
    })

    const wrongAudience = await new SignJWT({
      connection_id: 'provider-connection-1',
      resource_authorization_id: 'resource-authorization-1',
      broker_reference: 'broker-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'realmroot-1', typ: 'JWT' })
      .setIssuer(config.realmrootIssuer)
      .setSubject('user-1')
      .setAudience('https://other.example/github')
      .setJti('revocation-request-2')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(keys.privateKey)
    await expect(verifier.verifyRevocation(wrongAudience)).rejects.toThrow('revocation request is invalid')
  })
})
