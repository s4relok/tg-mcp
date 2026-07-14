# OAuth 2.1 and MCP scopes plan

## Decision

`tg-mcp` is an OAuth protected resource server, not an authorization server. An established external identity provider issues access tokens and publishes OAuth/OIDC discovery metadata. The service verifies signed JWT access tokens through the provider's JWKS endpoint on every MCP request.

This follows OpenAI's current [Apps SDK authentication guidance](https://developers.openai.com/apps-sdk/build/auth), the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [RFC 9728 protected resource metadata](https://www.rfc-editor.org/rfc/rfc9728), and [RFC 8707 resource indicators](https://www.rfc-editor.org/rfc/rfc8707).

The existing app-token endpoint and optional anonymous read-only endpoint remain separate. OAuth is opt-in and has its own MCP URL so rollout and rollback do not alter current clients.

## Scope model

| Scope | Grants |
| --- | --- |
| `telegram:read` | Enabled-source lists, sync status, digests, summaries, search, message context, and action items |
| `telegram:sources:read` | Disabled-source visibility and source settings |
| `telegram:sources:manage` | Enable/disable sources, edit tags, and update source settings |
| `telegram:sync:run` | Start an exact, bounded manual source sync |

`telegram:read` is required for the OAuth MCP transport. Privileged tool calls check their additional scopes at execution time, so a refreshed token with fewer permissions cannot continue using permissions from an older session.

## Implementation phases

- [x] Add an opt-in OAuth MCP endpoint and fail-closed runtime configuration.
- [x] Publish path-specific and root-fallback protected resource metadata.
- [x] Verify JWT signature, issuer, audience/resource, expiry, asymmetric algorithm, subject allowlist, and scopes.
- [x] Return RFC-compatible bearer challenges on transport authentication failures.
- [x] Advertise per-tool OAuth schemes through MCP tool metadata and return `mcp/www_authenticate` challenges for incremental scope requests.
- [x] Bind stateful MCP sessions to route, OAuth subject, and client id; re-check the current token on every request/tool call.
- [x] Keep source-management tools behind both `MCP_SOURCE_MANAGEMENT_ENABLED` and the required scopes.
- [x] Complete unit/integration tests, documentation, and final security review.

## Authorization-server requirements

The selected IdP must:

- expose OAuth 2.0 authorization-server or OpenID Connect discovery metadata;
- support authorization code with PKCE (`S256`);
- preserve the OAuth `resource` parameter and issue access tokens whose audience exactly matches `OAUTH_RESOURCE`;
- issue expiring JWT access tokens containing `sub`, `scope` or `scp`, and `client_id` or `azp` when available;
- publish a JWKS URL and support one of the configured asymmetric signing algorithms;
- register or dynamically accept ChatGPT's callback/client metadata according to the selected ChatGPT connection setup.

For a personal deployment, configure `OAUTH_ALLOWED_SUBJECTS` even when the IdP already restricts scope assignment. This is defense in depth against an accidentally broad IdP policy.

## Rollout

1. Configure the IdP and test authorization code + PKCE with a staging resource URL.
2. Set OAuth environment variables while leaving `OAUTH_ENABLED=false`; run configuration and token-verification tests.
3. Enable OAuth, connect ChatGPT to `OAUTH_RESOURCE`, and validate read-only access first.
4. Grant source scopes to the owner, enable `MCP_SOURCE_MANAGEMENT_ENABLED`, and verify preview/audit behavior before live mutations.
5. Retain `APP_AUTH_TOKEN` for CLI/admin/legacy MCP access unless those surfaces are migrated separately.
