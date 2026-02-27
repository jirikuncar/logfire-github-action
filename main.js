// @ts-check
/**
 * Logfire OIDC Auth — main action entry point.
 *
 * Authenticates GitHub Actions with Logfire via OIDC:
 * 1. Resolves the Logfire API URL from region/url inputs
 * 2. Computes deterministic traceparent from run context
 * 3. Fetches a GitHub OIDC token
 * 4. Exchanges it for short-lived Logfire tokens via RFC 8693
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

// --- RFC 8693 token exchange helpers ---

/**
 * Build a form-encoded body for RFC 8693 token exchange.
 */
function buildTokenExchangeForm(idToken, audience, scope) {
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: idToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    audience: audience,
  });
  if (scope) {
    params.set('scope', scope);
  }
  return params.toString();
}

/**
 * Perform an RFC 8693 token exchange request.
 */
async function tokenExchange(url, formBody) {
  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody),
    },
  }, formBody);

  if (response.statusCode !== 200) {
    let detail = response.body;
    try {
      const parsed = JSON.parse(response.body);
      detail = parsed.error_description || parsed.error || detail;
    } catch (_) { /* use raw body */ }
    throw new Error(`Token exchange failed (HTTP ${response.statusCode}): ${detail}`);
  }

  return JSON.parse(response.body);
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

    // 4. Build audience URL for RFC 8693 token exchange
    const organization = getInput('organization');
    if (!organization) {
      throw new Error('Input "organization" is required');
    }

    const project = getInput('project');

    // Resolve token flags
    const wantApiToken = getInput('api-token') !== 'false';
    const writeTokenInput = getInput('write-token');
    const wantWriteToken = writeTokenInput
      ? writeTokenInput !== 'false'
      : !!project; // default: true when project is provided

    if (wantWriteToken && !project) {
      throw new Error('Input "project" is required when write-token is true');
    }

    if (!wantApiToken && !wantWriteToken) {
      throw new Error('At least one of api-token or write-token must be true');
    }

    const audienceUrl = project
      ? `${audience}/${organization}/${project}`
      : `${audience}/${organization}`;

    const scopes = getInput('scopes');
    // Convert comma-separated scopes to space-separated per RFC 8693
    const scopeParam = scopes
      ? scopes.split(',').map((s) => s.trim()).filter(Boolean).join(' ')
      : '';

    // 5. Exchange OIDC token for Logfire tokens via RFC 8693
    let accessToken = '';
    let logfireToken = '';
    let expiresIn = 0;
    let grantedScopes = '';

    // Get write token for SDK/intake (requires project)
    if (wantWriteToken) {
      const writeTokenForm = buildTokenExchangeForm(idToken, audienceUrl, scopeParam);
      const writeResult = await tokenExchange(
        `${resolvedUrl}/api/oidc/write-token`,
        writeTokenForm,
      );
      logfireToken = writeResult.access_token;
      expiresIn = writeResult.expires_in;
      debug('Obtained write token via /api/oidc/write-token');
    }

    // Get JWT access token for API access
    if (wantApiToken) {
      const jwtForm = buildTokenExchangeForm(idToken, audienceUrl, scopeParam);
      const jwtResult = await tokenExchange(
        `${resolvedUrl}/api/oidc/token`,
        jwtForm,
      );
      accessToken = jwtResult.access_token;
      if (!expiresIn) expiresIn = jwtResult.expires_in;
      grantedScopes = jwtResult.scope || '';
    }

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

    if (exportToken && logfireToken) {
      exportVariable('LOGFIRE_TOKEN', logfireToken);
      exportVariable('LOGFIRE_BASE_URL', resolvedUrl);
      exportVariable('LOGFIRE_SEND_TO_LOGFIRE', 'true');
    }

    if (exportTraceparent) {
      exportVariable('TRACEPARENT', traceparent);
    }

    const tokenSummary = [
      wantApiToken && 'api-token',
      wantWriteToken && 'write-token',
    ].filter(Boolean).join(', ');
    console.log(`Logfire OIDC authentication successful (${tokenSummary}, expires in ${expiresIn}s, scopes: ${grantedScopes})`);
  } catch (error) {
    setFailed(error.message);
  }
}

main();
