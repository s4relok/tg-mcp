import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { createOAuthTokenVerifier, OAuthScopes } from '../src/http/oauth.js';

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

test('OAuth verifier validates JWT signature, issuer, audience, expiry, subject, and scopes', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  const jwksServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await listen(jwksServer);

  try {
    const { port } = jwksServer.address();
    const issuer = `http://127.0.0.1:${port}`;
    const resource = 'http://127.0.0.1:3010/tg-mcp/oauth-mcp';
    const config = {
      oauthIssuer: issuer,
      oauthResource: resource,
      oauthJwksUrl: `${issuer}/jwks.json`,
      oauthJwksTimeoutMs: 1000,
      oauthJwtAlgorithms: ['RS256'],
      oauthClockToleranceSeconds: 0,
      oauthAllowedSubjects: ['owner-1']
    };
    const verifier = createOAuthTokenVerifier(config);
    const token = await new SignJWT({
      scope: OAuthScopes.read,
      scp: [OAuthScopes.sourcesRead],
      client_id: 'chatgpt-client'
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject('owner-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const authInfo = await verifier.verifyAccessToken(token);
    assert.equal(authInfo.clientId, 'chatgpt-client');
    assert.equal(authInfo.extra.subject, 'owner-1');
    assert.equal(authInfo.resource.href, resource);
    assert.deepEqual(
      new Set(authInfo.scopes),
      new Set([OAuthScopes.read, OAuthScopes.sourcesRead])
    );

    const wrongAudienceToken = await new SignJWT({ scope: OAuthScopes.read })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience('http://127.0.0.1:3010/another-resource')
      .setSubject('owner-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await assert.rejects(
      () => verifier.verifyAccessToken(wrongAudienceToken),
      /not intended for this MCP resource/
    );

    const expiredToken = await new SignJWT({ scope: OAuthScopes.read })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject('owner-1')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);
    await assert.rejects(
      () => verifier.verifyAccessToken(expiredToken),
      /not intended for this MCP resource/
    );

    const disallowedSubjectToken = await new SignJWT({ scope: OAuthScopes.read })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject('someone-else')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await assert.rejects(
      () => verifier.verifyAccessToken(disallowedSubjectToken),
      /not intended for this MCP resource/
    );
  } finally {
    jwksServer.close();
  }
});
