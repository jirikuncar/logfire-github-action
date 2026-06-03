/**
 * Logfire OIDC Auth — post-action cleanup.
 *
 * Revokes the workload token issued during the main step via the RFC 7009
 * revocation endpoint (`POST /api/oauth/revoke`). Runs as the `post` entry
 * point, so it executes even when the job fails.
 */

import { requestWithRetry } from './http-client';

function getState(name: string): string {
  return (process.env[`STATE_${name}`] || '').trim();
}

function warning(message: string): void {
  console.log(`::warning::${message}`);
}

function debug(message: string): void {
  console.log(`::debug::${message}`);
}

async function revokeToken(revokeUrl: string, token: string): Promise<boolean> {
  const formBody = new URLSearchParams({
    token,
    token_type_hint: 'access_token',
  }).toString();

  const response = await requestWithRetry(
    revokeUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
    },
    formBody,
    {
      onRetry: (info) =>
        debug(
          `Revoke retry ${info.attempt}/${info.maxRetries} in ${info.delayMs}ms (${info.reason})`,
        ),
    },
  );

  return (
    typeof response.statusCode === 'number' &&
    response.statusCode >= 200 &&
    response.statusCode < 300
  );
}

async function cleanup(): Promise<void> {
  const accessToken = getState('access_token');
  const logfireUrl = getState('logfire_url');

  if (getState('skip_cleanup') === 'true') {
    debug('skip-cleanup is set; leaving the token to expire naturally');
    return;
  }
  if (!accessToken) {
    debug('No token to revoke');
    return;
  }
  if (!logfireUrl) {
    warning('Cannot revoke token: Logfire URL not saved from main step');
    return;
  }

  try {
    const ok = await revokeToken(`${logfireUrl}/api/oauth/revoke`, accessToken);
    if (ok) {
      debug('Revoked workload token');
    } else {
      warning('Token revocation returned non-200 (token will expire naturally)');
    }
  } catch (error) {
    warning(`Token revocation failed: ${(error as Error).message} (token will expire naturally)`);
  }
}

void cleanup();
