// @ts-check
/**
 * Logfire OIDC Auth — main action entry point.
 *
 * Authenticates GitHub Actions with Logfire via OIDC:
 * 1. Resolves the Logfire API URL from region/url inputs
 * 2. Computes deterministic traceparent from run context
 * 3. Fetches a GitHub OIDC token
 * 4. Exchanges it for short-lived Logfire tokens
 * 5. Exports environment variables for SDK integration
 * 6. Saves state for post-action cleanup (token revocation)
 *
 * Uses only built-in Node.js modules — no npm dependencies required.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- GitHub Actions helpers (no @actions/core dependency) ---

function getInput(name) {
  const val = process.env[`INPUT_${name.replace(/-/g, '_').toUpperCase()}`] || '';
  return val.trim();
}

function setOutput(name, value) {
  const filePath = process.env.GITHUB_OUTPUT;
  if (filePath) {
    fs.appendFileSync(filePath, `${name}=${value}\n`);
  }
}

function exportVariable(name, value) {
  const filePath = process.env.GITHUB_ENV;
  if (filePath) {
    fs.appendFileSync(filePath, `${name}=${value}\n`);
  }
}

function saveState(name, value) {
  const filePath = process.env.GITHUB_STATE;
  if (filePath) {
    fs.appendFileSync(filePath, `${name}=${value}\n`);
  }
}

function setSecret(value) {
  if (value) {
    console.log(`::add-mask::${value}`);
  }
}

function setFailed(message) {
  console.log(`::error::${message}`);
  process.exitCode = 1;
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
        resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// --- OIDC token fetching ---

async function getIDToken(audience) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error(
      'GitHub OIDC not available. Ensure the job has "permissions: id-token: write" ' +
      'and the workflow uses a supported event trigger.'
    );
  }

  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const response = await httpRequest(url, {
    method: 'GET',
    headers: {
      Authorization: `bearer ${requestToken}`,
      Accept: 'application/json',
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to get OIDC token (HTTP ${response.statusCode}): ${response.body}`);
  }

  const json = JSON.parse(response.body);
  return json.value;
}

// --- Traceparent computation ---

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function computeTraceId(runId, runAttempt) {
  return sha256hex(`logfire:github:trace:${runId}:${runAttempt}`).substring(0, 32);
}

function computeRunSpanId(runId, runAttempt) {
  return sha256hex(`logfire:github:run:${runId}:${runAttempt}`).substring(0, 16);
}

function computeJobSpanId(runId, runAttempt, jobName) {
  return sha256hex(`logfire:github:job:${runId}:${runAttempt}:${jobName}`).substring(0, 16);
}

// --- URL resolution ---

const REGION_URLS = {
  us: 'https://logfire-api.pydantic.dev',
  eu: 'https://logfire-api-eu.pydantic.dev',
  'staging-eu': 'https://logfire-api-staging-eu.pydantic.dev',
};

function resolveUrl(region, url) {
  if (url) return url;
  if (region) {
    const resolved = REGION_URLS[region];
    if (!resolved) {
      throw new Error(`Unknown region '${region}'. Use: us, eu, staging-eu, or provide a custom url.`);
    }
    return resolved;
  }
  return REGION_URLS.us;
}

// --- Main ---

async function main() {
  try {
    // 1. Resolve URL and audience
    const region = getInput('region');
    const url = getInput('url');
    const resolvedUrl = resolveUrl(region, url);
    const audience = getInput('audience') || 'https://logfire.pydantic.dev';

    setOutput('logfire-url', resolvedUrl);
    debug(`Resolved Logfire URL: ${resolvedUrl}`);

    // 2. Compute traceparent
    // For matrix jobs, GITHUB_JOB is the same across all matrix entries.
    // We incorporate the matrix context (passed via job-id input) to produce
    // unique span IDs per matrix combination. Without it, all matrix entries
    // would share the same job span ID.
    const runId = process.env.GITHUB_RUN_ID || '';
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
    const jobId = getInput('job-id') || process.env.GITHUB_JOB || '';

    const traceId = computeTraceId(runId, runAttempt);
    const runSpanId = computeRunSpanId(runId, runAttempt);
    const jobSpanId = computeJobSpanId(runId, runAttempt, jobId);
    const traceparent = `00-${traceId}-${jobSpanId}-01`;

    setOutput('traceparent', traceparent);
    setOutput('trace-id', traceId);
    debug(`Traceparent: ${traceparent}`);

    // 3. Get GitHub OIDC token
    const idToken = await getIDToken(audience);
    setSecret(idToken);

    // 4. Build exchange request body
    const organization = getInput('organization');
    if (!organization) {
      throw new Error('Input "organization" is required');
    }

    const body = { token: idToken, organization };

    const project = getInput('project');
    if (project) body.project = project;

    const scopes = getInput('scopes');
    if (scopes) {
      body.scopes = scopes.split(',').map((s) => s.trim()).filter(Boolean);
    }

    const ttl = getInput('token-ttl-seconds');
    if (ttl) body.token_ttl_seconds = parseInt(ttl, 10);

    // 5. Exchange OIDC token for Logfire tokens
    const exchangeUrl = `${resolvedUrl}/api/github/oidc/exchange`;
    const bodyStr = JSON.stringify(body);

    const response = await httpRequest(exchangeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, bodyStr);

    if (response.statusCode !== 200) {
      let detail = response.body;
      try {
        detail = JSON.parse(response.body).detail || detail;
      } catch (_) { /* use raw body */ }
      throw new Error(`Logfire OIDC exchange failed (HTTP ${response.statusCode}): ${detail}`);
    }

    const result = JSON.parse(response.body);
    const accessToken = result.access_token;
    const logfireToken = result.logfire_token || '';
    const expiresIn = result.expires_in;
    const grantedScopes = (result.scopes || []).join(',');

    // Mask tokens
    setSecret(accessToken);
    if (logfireToken) setSecret(logfireToken);

    // Set outputs
    setOutput('token', accessToken);
    setOutput('logfire-token', logfireToken);
    setOutput('expires-in', String(expiresIn));
    setOutput('scopes', grantedScopes);

    // 6. Save state for post-action cleanup
    saveState('access_token', accessToken);
    saveState('logfire_token', logfireToken);
    saveState('logfire_url', resolvedUrl);

    // 7. Export environment variables
    const exportToken = getInput('export-token') !== 'false';
    const exportTraceparent = getInput('export-traceparent') !== 'false';

    if (exportToken) {
      // Prefer write token (works with ingest), fall back to access token (API only)
      const tokenForSdk = logfireToken || accessToken;
      exportVariable('LOGFIRE_TOKEN', tokenForSdk);
      exportVariable('LOGFIRE_BASE_URL', resolvedUrl);
      exportVariable('LOGFIRE_SEND_TO_LOGFIRE', 'true');
    }

    if (exportTraceparent) {
      exportVariable('TRACEPARENT', traceparent);
    }

    console.log(`Logfire OIDC authentication successful (expires in ${expiresIn}s, scopes: ${grantedScopes})`);
  } catch (error) {
    setFailed(error.message);
  }
}

main();
