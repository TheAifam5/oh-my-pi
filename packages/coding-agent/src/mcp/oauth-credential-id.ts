/** Credential-id prefix for OMP-managed MCP OAuth credentials keyed by profile and server URL. */
export const MCP_OAUTH_URL_CREDENTIAL_PREFIX = "mcp_oauth:";

/** Credential-id prefix for profile-scoped MCP OAuth credentials (`mcp_oauth:profile:<profile>:<serverUrl>`). */
export const MCP_OAUTH_PROFILE_CREDENTIAL_PREFIX = `${MCP_OAUTH_URL_CREDENTIAL_PREFIX}profile:`;

/** Whether a credential id was minted by OMP's MCP OAuth flows (either era). */
export function isManagedMCPOAuthCredentialId(credentialId: string | undefined): credentialId is string {
	return (
		!!credentialId &&
		(credentialId.startsWith("mcp_oauth_") || credentialId.startsWith(MCP_OAUTH_URL_CREDENTIAL_PREFIX))
	);
}
