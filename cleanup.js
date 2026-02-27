// @ts-check
/**
 * Logfire OIDC Auth — post-action cleanup.
 *
 * Automatically revokes all tokens issued during the main action step
 * via the RFC 7009 token revocation endpoint.
 * This runs as the `post` entry point, so it executes even if the job fails.
 *
 * Uses only built-in Node.js modules — no npm dependencies required.
 */

const https = require('https');
const http = require('http');

// --- GitHub Actions helpers ---

function getState(name) {
  return (process.env[`STATE_${name}`] || '').trim();
}

function warning(message) {
  console.log(`::warning::${message}`);
}

function debug(message) {
  console.log(`::debug::${message}`);
}

// --- HTTP helpers ---

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// --- RFC 7009 token revocation ---

/**
 * Revoke a single token via RFC 7009 POST /api/oidc/revoke.
 */
async function revokeToken(revokeUrl, token, tokenTypeHint) {
  const params = new URLSearchParams({ token });
  if (tokenTypeHint) {
    params.set('token_type_hint', tokenTypeHint);
  }
  const formBody = params.toString();

  const response = await httpRequest(revokeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody),
    },
  }, formBody);

  return response.statusCode === 200;
}

// --- Cleanup ---

async function cleanup() {
  const accessToken = getState('access_token');
  const logfireToken = getState('logfire_token');
  const logfireUrl = getState('logfire_url');

  if (!accessToken && !logfireToken) {
    debug('No tokens to revoke');
    return;
  }

  if (!logfireUrl) {
    warning('Cannot revoke tokens: Logfire URL not saved from main step');
    return;
  }

  const revokeUrl = `${logfireUrl}/api/oidc/revoke`;

  try {
    let revoked = 0;

    if (logfireToken) {
      if (await revokeToken(revokeUrl, logfireToken, 'logfire_token')) {
        revoked++;
        debug('Revoked write token');
      }
    }

    if (accessToken) {
      if (await revokeToken(revokeUrl, accessToken, 'access_token')) {
        revoked++;
        debug('Revoked access token');
      }
    }

    if (revoked > 0) {
      debug(`Revoked ${revoked} token(s) successfully`);
    } else {
      warning('Token revocation returned non-200 (tokens will expire naturally)');
    }
  } catch (error) {
    warning(`Token revocation failed: ${error.message} (tokens will expire naturally)`);
  }
}

cleanup();
