// @ts-check
/**
 * Shared HTTP client for the Logfire OIDC action.
 *
 * Wraps Node's built-in http/https with three things the bare modules lack:
 *   - a per-request socket timeout, so a hung connection fails fast instead of
 *     blocking until the job-level timeout;
 *   - HTTP(S) proxy support — plain proxying for http targets and CONNECT
 *     tunneling for https targets — honoring the conventional HTTPS_PROXY /
 *     HTTP_PROXY / ALL_PROXY / NO_PROXY environment variables that Node's
 *     http/https otherwise ignore;
 *   - retry with jittered exponential backoff on transient failures (network
 *     errors, request timeouts, HTTP 408/429, and 5xx). 4xx responses are
 *     returned as-is so the caller can surface a permanent policy rejection.
 *
 * Built-in Node.js modules only — no npm dependencies.
 */

const http = require('http');
const https = require('https');
const tls = require('tls');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 10000;

// --- Proxy resolution (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY) ---

/**
 * @param {string} hostname
 * @param {string} port
 * @param {string} noProxy comma/space-separated NO_PROXY list
 */
function inNoProxy(hostname, port, noProxy) {
  return noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      let host = entry;
      let entryPort = '';
      const m = entry.match(/^(.+):(\d+)$/);
      if (m) {
        host = m[1];
        entryPort = m[2];
      }
      if (entryPort && entryPort !== String(port)) return false;
      // Normalize leading "*." or "." so ".example.com" matches "example.com".
      host = host.replace(/^\*?\.?/, '');
      if (!host) return false;
      return hostname === host || hostname.endsWith(`.${host}`);
    });
}

/**
 * Resolve the proxy URL for a target, or '' if the target should be reached
 * directly. Mirrors the de-facto `proxy-from-env` semantics.
 * @param {string} targetUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function getProxyForUrl(targetUrl, env) {
  env = env || process.env;
  let target;
  try {
    target = new URL(targetUrl);
  } catch (_) {
    return '';
  }
  const isHttps = target.protocol === 'https:';
  const port = target.port || (isHttps ? '443' : '80');
  const noProxy = (env.NO_PROXY || env.no_proxy || '').trim();
  if (noProxy === '*') return '';
  if (noProxy && inNoProxy(target.hostname, port, noProxy)) return '';
  const proxy = isHttps
    ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
    : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  return (proxy || '').trim();
}

// --- Single request (timeout + optional proxy) ---

/**
 * @param {string} targetUrl
 * @param {https.RequestOptions} options
 * @param {string|undefined} body
 * @param {string} proxyUrl '' for a direct connection
 * @param {number} timeoutMs
 * @returns {Promise<{statusCode: number|undefined, body: string, headers: http.IncomingHttpHeaders}>}
 */
function makeRequest(targetUrl, options, body, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const isHttps = target.protocol === 'https:';
    let done = false;
    const succeed = (r) => { if (!done) { done = true; resolve(r); } };
    const fail = (e) => { if (!done) { done = true; reject(e); } };

    const onResponse = (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => succeed({ statusCode: res.statusCode, body: data, headers: res.headers }));
      res.on('error', fail);
    };

    const wire = (req) => {
      req.on('error', fail);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request to ${target.host} timed out after ${timeoutMs}ms`));
      });
      if (body) req.write(body);
      req.end();
    };

    // Direct connection.
    if (!proxyUrl) {
      const transport = isHttps ? https : http;
      wire(transport.request(targetUrl, options, onResponse));
      return;
    }

    const proxy = new URL(proxyUrl);
    const proxyHeaders = {};
    if (proxy.username) {
      const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    }
    const proxyPort = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);

    // Plain HTTP through a proxy: send the absolute URL as the request path.
    if (!isHttps) {
      const req = http.request({
        host: proxy.hostname,
        port: proxyPort,
        method: options.method || 'GET',
        path: targetUrl,
        headers: { ...(options.headers || {}), ...proxyHeaders, Host: target.host },
      }, onResponse);
      wire(req);
      return;
    }

    // HTTPS through a proxy: open a CONNECT tunnel, then run TLS over it.
    const targetPort = target.port || '443';
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: { ...proxyHeaders, Host: `${target.hostname}:${targetPort}` },
    });
    connectReq.on('error', fail);
    connectReq.setTimeout(timeoutMs, () => {
      connectReq.destroy(new Error(`Proxy CONNECT to ${target.host} timed out after ${timeoutMs}ms`));
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy CONNECT to ${target.host} failed (HTTP ${res.statusCode})`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname });
      tlsSocket.on('error', fail);
      const req = https.request(targetUrl, {
        ...options,
        agent: false,
        createConnection: () => tlsSocket,
      }, onResponse);
      wire(req);
    });
    connectReq.end();
  });
}

// --- Retry with jittered exponential backoff ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter backoff, capped. @param {number} base @param {number} attempt */
function backoffDelay(base, attempt) {
  const ceiling = Math.min(base * 2 ** attempt, MAX_DELAY_MS);
  return Math.floor(Math.random() * ceiling);
}

/** @param {number|undefined} status */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
}

/**
 * @typedef {Object} RequestOpts
 * @property {number} [maxRetries]
 * @property {number} [timeoutMs]
 * @property {number} [baseDelayMs]
 * @property {string} [proxy] explicit proxy override; '' / undefined falls back to env
 * @property {(info: {attempt: number, maxRetries: number, reason: string, delayMs: number}) => void} [onRetry]
 */

/**
 * Make an HTTP(S) request, retrying transient failures.
 * @param {string} url
 * @param {https.RequestOptions} options
 * @param {string} [body]
 * @param {RequestOpts} [opts]
 */
async function requestWithRetry(url, options, body, opts = {}) {
  const maxRetries = Number.isFinite(opts.maxRetries) ? Math.max(0, /** @type {number} */ (opts.maxRetries)) : DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const baseDelayMs = opts.baseDelayMs || DEFAULT_BASE_DELAY_MS;
  const onRetry = opts.onRetry || (() => {});
  const proxyUrl = opts.proxy || getProxyForUrl(url);

  let attempt = 0;
  for (;;) {
    try {
      const response = await makeRequest(url, options, body, proxyUrl, timeoutMs);
      if (attempt < maxRetries && isRetryableStatus(response.statusCode)) {
        const delayMs = backoffDelay(baseDelayMs, attempt);
        onRetry({ attempt: attempt + 1, maxRetries, reason: `HTTP ${response.statusCode}`, delayMs });
        await sleep(delayMs);
        attempt += 1;
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delayMs = backoffDelay(baseDelayMs, attempt);
      onRetry({ attempt: attempt + 1, maxRetries, reason: err.message, delayMs });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

module.exports = {
  requestWithRetry,
  makeRequest,
  getProxyForUrl,
  inNoProxy,
};
