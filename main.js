// @ts-check
/**
 * Logfire OIDC Auth — main action entry point.
 *
 * Authenticates GitHub Actions with Logfire via RFC 8693 token exchange:
 * 1. Resolves the Logfire API URL from region/url inputs
 * 2. Computes a deterministic traceparent from the run context
 * 3. Fetches a GitHub OIDC JWT
 * 4. Exchanges it for a short-lived Logfire workload token
 *    (`POST /api/oidc/token`). The trust policy decides which scopes the
 *    issued token carries and therefore which Logfire surfaces it can
 *    reach.
 * 5. Saves state for the post-action revocation step
 *
 * Uses only built-in Node.js modules — no npm dependencies required.
 */

const crypto = require('crypto');
const fs = require('fs');
const { requestWithRetry } = require('./http-client');

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

function debug(message) {
  console.log(`::debug::${message}`);
}

// --- RFC 8693 token exchange ---

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

async function exchangeToken(tokenUrl, { subjectToken, audience, scope }, httpOpts) {
  const params = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: subjectToken,
    subject_token_type: JWT_TOKEN_TYPE,
    audience,
  });
  if (scope) {
    params.set('scope', scope);
  }
  const formBody = params.toString();

  const response = await requestWithRetry(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody),
    },
  }, formBody, httpOpts);

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

// --- GitHub OIDC token fetching ---

async function getIDToken(audience, httpOpts) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error(
      'GitHub OIDC not available. Ensure the job has "permissions: id-token: write" ' +
      'and the workflow uses a supported event trigger.'
    );
  }

  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const response = await requestWithRetry(url, {
    method: 'GET',
    headers: {
      Authorization: `bearer ${requestToken}`,
      Accept: 'application/json',
    },
  }, undefined, httpOpts);

  if (response.statusCode !== 200) {
    throw new Error(`Failed to get GitHub OIDC token (HTTP ${response.statusCode}): ${response.body}`);
  }

  return JSON.parse(response.body).value;
}

// --- Traceparent computation ---

function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function computeTraceId(runId, runAttempt) {
  return sha256hex(`logfire:github:trace:${runId}:${runAttempt}`).substring(0, 32);
}

function computeJobSpanId(runId, runAttempt, jobName) {
  return sha256hex(`logfire:github:job:${runId}:${runAttempt}:${jobName}`).substring(0, 16);
}

// --- URL resolution ---

/** @type {Record<string, string>} */
const REGION_URLS = {
  us: 'https://logfire-us.pydantic.dev',
  eu: 'https://logfire-eu.pydantic.dev',
  'staging-eu': 'https://logfire-eu.pydantic.info',
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
    // 1. Resolve URL
    const region = getInput('region');
    const url = getInput('url');
    const resolvedUrl = resolveUrl(region, url);

    setOutput('logfire-url', resolvedUrl);
    debug(`Resolved Logfire URL: ${resolvedUrl}`);

    // HTTP behavior: retries, per-request timeout, and proxy. The proxy
    // override falls back to the HTTPS_PROXY/HTTP_PROXY/NO_PROXY env vars when
    // empty. Retries cover transient network errors, timeouts, 429, and 5xx —
    // a 4xx policy rejection (invalid_scope, invalid_target) is not retried.
    const maxRetriesInput = parseInt(getInput('max-retries'), 10);
    const timeoutInput = parseInt(getInput('request-timeout'), 10);
    const httpOpts = {
      maxRetries: Number.isNaN(maxRetriesInput) ? undefined : Math.max(0, maxRetriesInput),
      timeoutMs: Number.isNaN(timeoutInput) ? undefined : Math.max(1, timeoutInput) * 1000,
      proxy: getInput('proxy') || undefined,
      /** @param {{attempt: number, maxRetries: number, reason: string, delayMs: number}} info */
      onRetry: (info) =>
        debug(`Retry ${info.attempt}/${info.maxRetries} in ${info.delayMs}ms (${info.reason})`),
    };

    // 2. Compute traceparent. For matrix jobs, GITHUB_JOB collapses across
    //    matrix entries — incorporate `job-id` so each combination gets a
    //    unique span id.
    const runId = process.env.GITHUB_RUN_ID || '';
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
    const jobId = getInput('job-id') || process.env.GITHUB_JOB || '';

    const traceId = computeTraceId(runId, runAttempt);
    const jobSpanId = computeJobSpanId(runId, runAttempt, jobId);
    const traceparent = `00-${traceId}-${jobSpanId}-01`;

    setOutput('traceparent', traceparent);
    setOutput('trace-id', traceId);
    debug(`Traceparent: ${traceparent}`);

    // 3. Resolve the audience. Two mutually-exclusive modes:
    //    - Explicit `audience`: used verbatim for both the OIDC JWT `aud`
    //      claim and the RFC 8693 exchange. It must already encode whatever
    //      org/project path the backend expects, so `organization`/`project`
    //      are rejected here to avoid an ambiguous double-encoding.
    //    - Otherwise: the OIDC `aud` claim is the resolved Logfire URL and the
    //      exchange audience encodes the org (+ optional project) as a path,
    //      which the backend parses to route to the right org/project.
    const audienceInput = getInput('audience');
    const organization = getInput('organization');
    const project = getInput('project');

    if (audienceInput && (organization || project)) {
      throw new Error(
        'Input "audience" cannot be combined with "organization" or "project". ' +
        'Provide a full audience that already encodes the org/project path, or ' +
        'omit "audience" and pass "organization" (+ optional "project") instead.'
      );
    }

    let oidcAudience;
    let exchangeAudience;
    if (audienceInput) {
      oidcAudience = audienceInput;
      exchangeAudience = audienceInput;
    } else {
      if (!organization) {
        throw new Error('Input "organization" is required (unless a full "audience" is provided)');
      }
      oidcAudience = resolvedUrl;
      exchangeAudience = project
        ? `${resolvedUrl}/${organization}/${project}`
        : `${resolvedUrl}/${organization}`;
    }

    // 4. Fetch the GitHub OIDC JWT
    const subjectToken = await getIDToken(oidcAudience, httpOpts);
    setSecret(subjectToken);

    // Scopes are space-separated, per the OAuth / RFC 8693 convention. Collapse
    // any whitespace (newlines, double spaces) the input may carry into single
    // separators. Validity of the requested scopes is enforced by the exchange
    // endpoint against the trust policy.
    const scopesInput = getInput('scopes');
    const scope = scopesInput
      ? scopesInput.split(/\s+/).filter(Boolean).join(' ')
      : '';

    // 5. Exchange the OIDC JWT for a Logfire workload token. If the trust
    //    policy rejects the request (claims don't match, requested scope
    //    outside the policy, etc.) the exchange returns an RFC 6749 §5.2
    //    error envelope and the action fails the step.
    const result = await exchangeToken(`${resolvedUrl}/api/oidc/token`, {
      subjectToken,
      audience: exchangeAudience,
      scope,
    }, httpOpts);

    const accessToken = result.access_token;
    const expiresIn = result.expires_in;
    const grantedScopes = result.scope || '';

    setSecret(accessToken);

    setOutput('token', accessToken);
    setOutput('expires-in', String(expiresIn));
    setOutput('scopes', grantedScopes);

    // 6. Save state for the post-action revocation step. `skip-cleanup` is
    //    persisted here (rather than read in the post step) because input env
    //    vars aren't guaranteed in the post context.
    const skipCleanup = getInput('skip-cleanup').toLowerCase() === 'true';
    saveState('access_token', accessToken);
    saveState('logfire_url', resolvedUrl);
    saveState('skip_cleanup', skipCleanup ? 'true' : '');

    console.log(`Logfire OIDC authentication successful (expires in ${expiresIn}s, scopes: ${grantedScopes})`);
  } catch (error) {
    setFailed(error.message);
  }
}

main();
