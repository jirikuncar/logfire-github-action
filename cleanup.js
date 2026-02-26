// @ts-check
/**
 * Logfire OIDC Auth — post-action cleanup.
 *
 * Automatically revokes all tokens issued during the main action step.
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

  const body = {};
  if (logfireToken) body.logfire_token = logfireToken;
  if (accessToken) body.access_token = accessToken;

  const bodyStr = JSON.stringify(body);

  try {
    const response = await httpRequest(`${logfireUrl}/api/github/oidc/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, bodyStr);

    if (response.statusCode === 200) {
      debug('Logfire tokens revoked successfully');
    } else {
      warning(`Token revocation returned HTTP ${response.statusCode} (tokens will expire naturally)`);
    }
  } catch (error) {
    warning(`Token revocation failed: ${error.message} (tokens will expire naturally)`);
  }
}

cleanup();
