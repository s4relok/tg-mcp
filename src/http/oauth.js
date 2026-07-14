import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const OAuthScopes = Object.freeze({
  read: 'telegram:read',
  sourcesRead: 'telegram:sources:read',
  sourcesManage: 'telegram:sources:manage',
  syncRun: 'telegram:sync:run'
});

function stringClaim(payload, name) {
  return typeof payload[name] === 'string' && payload[name].trim()
    ? payload[name].trim()
    : '';
}

function parseTokenScopes(payload) {
  const scopes = new Set();
  const add = (value) => {
    if (typeof value === 'string') {
      for (const scope of value.split(/\s+/).filter(Boolean)) {
        scopes.add(scope);
      }
    } else if (Array.isArray(value)) {
      for (const scope of value) {
        if (typeof scope === 'string' && scope.trim()) {
          scopes.add(scope.trim());
        }
      }
    }
  };

  add(payload.scope);
  add(payload.scp);
  return [...scopes];
}

export function getSupportedOAuthScopes(config) {
  const scopes = [OAuthScopes.read];
  if (config.mcpSourceManagementEnabled) {
    scopes.push(
      OAuthScopes.sourcesRead,
      OAuthScopes.sourcesManage,
      OAuthScopes.syncRun
    );
  }
  return scopes;
}

export function createOAuthTokenVerifier(config, options = {}) {
  const jwks = options.jwks || createRemoteJWKSet(
    new URL(config.oauthJwksUrl),
    { timeoutDuration: config.oauthJwksTimeoutMs || 5000 }
  );
  const allowedSubjects = new Set(config.oauthAllowedSubjects || []);

  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.oauthIssuer,
          audience: config.oauthResource,
          algorithms: config.oauthJwtAlgorithms,
          clockTolerance: config.oauthClockToleranceSeconds || 0
        });
        const subject = stringClaim(payload, 'sub');
        if (!subject) {
          throw new Error('Missing sub claim');
        }
        if (!Number.isFinite(payload.exp)) {
          throw new Error('Missing exp claim');
        }
        if (allowedSubjects.size > 0 && !allowedSubjects.has(subject)) {
          throw new Error('Subject is not allowed');
        }

        const clientId = stringClaim(payload, 'client_id')
          || stringClaim(payload, 'azp')
          || 'oauth-client';
        return {
          token,
          clientId,
          scopes: parseTokenScopes(payload),
          expiresAt: payload.exp,
          resource: new URL(config.oauthResource),
          extra: {
            subject,
            issuer: payload.iss
          }
        };
      } catch (caught) {
        if (caught instanceof InvalidTokenError) {
          throw caught;
        }
        throw new InvalidTokenError('Access token is invalid, expired, or not intended for this MCP resource.');
      }
    }
  };
}

export function createOAuthBearerAuth(config, options = {}) {
  const verifier = options.verifier || createOAuthTokenVerifier(config, options);
  return requireBearerAuth({
    verifier,
    requiredScopes: [OAuthScopes.read],
    resourceMetadataUrl: config.oauthProtectedResourceMetadataUrl
  });
}

export function createProtectedResourceMetadata(config) {
  const metadata = {
    resource: config.oauthResource,
    authorization_servers: [config.oauthIssuer],
    scopes_supported: getSupportedOAuthScopes(config),
    bearer_methods_supported: ['header'],
    resource_name: 'tg-mcp'
  };
  if (config.oauthResourceDocumentation) {
    metadata.resource_documentation = config.oauthResourceDocumentation;
  }
  return metadata;
}

function quoteChallengeValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function createOAuthChallenge(config, scopes, options = {}) {
  const parts = [
    `resource_metadata="${quoteChallengeValue(config.oauthProtectedResourceMetadataUrl)}"`
  ];
  if (options.error) {
    parts.push(`error="${quoteChallengeValue(options.error)}"`);
  }
  if (options.description) {
    parts.push(`error_description="${quoteChallengeValue(options.description)}"`);
  }
  if (scopes.length > 0) {
    parts.push(`scope="${quoteChallengeValue(scopes.join(' '))}"`);
  }
  return `Bearer ${parts.join(', ')}`;
}

export function oauthSessionPrincipal(authInfo) {
  if (!authInfo) {
    return '';
  }
  const subject = authInfo.extra && typeof authInfo.extra.subject === 'string'
    ? authInfo.extra.subject
    : '';
  return subject ? `${subject}\u0000${authInfo.clientId}` : '';
}
