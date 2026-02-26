# Logfire OIDC Auth GitHub Action

Authenticate GitHub Actions with [Logfire](https://logfire.pydantic.dev) via OpenID Connect (OIDC). No stored secrets needed — GitHub provides short-lived JWTs that Logfire validates directly.

Tokens are automatically revoked when the job completes via a built-in post step.

## Quick Start

```yaml
permissions:
  id-token: write # Required for OIDC

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: jirikuncar/logfire-github-action@main
        with:
          organization: myorg
          project: myapp
          region: us

      - uses: actions/checkout@v4
      - run: pip install -e ".[test]"
      - run: pytest --logfire
```

After this step, `LOGFIRE_TOKEN`, `LOGFIRE_BASE_URL`, and `TRACEPARENT` are automatically set as environment variables. The logfire SDK and pytest plugin pick them up with zero configuration.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `organization` | Yes | — | Logfire organization slug |
| `project` | No | — | Logfire project slug. Required for write token / SDK integration |
| `scopes` | No | — | Comma-separated scopes (e.g. `project:read,project:write`) |
| `token-ttl-seconds` | No | Trust policy setting | Token TTL in seconds (60–86400) |
| `region` | No | `us` | Region preset: `us`, `eu`, `staging-eu` |
| `url` | No | — | Custom Logfire API URL (overrides `region`) |
| `audience` | No | Derived from URL | OIDC audience claim |
| `export-token` | No | `true` | Export `LOGFIRE_TOKEN` env var |
| `export-traceparent` | No | `true` | Export `TRACEPARENT` env var |
| `job-id` | No | `github.job` | Unique job ID for traceparent (use with matrix) |

## Outputs

| Output | Description |
|--------|-------------|
| `token` | Short-lived JWT access token for API use |
| `logfire-token` | Write token for SDK/intake (`LOGFIRE_TOKEN`) |
| `traceparent` | W3C traceparent header value |
| `trace-id` | Deterministic trace ID for this workflow run |
| `expires-in` | Token TTL in seconds |
| `scopes` | Granted scopes (comma-separated) |
| `logfire-url` | Resolved Logfire API URL |

## Configuration Examples

### Logfire Cloud (US — default)

```yaml
- uses: jirikuncar/logfire-github-action@main
  with:
    organization: myorg
    project: myapp
```

### Logfire Cloud (EU)

```yaml
- uses: jirikuncar/logfire-github-action@main
  with:
    organization: myorg
    project: myapp
    region: eu
```

### Self-Hosted Logfire

For self-hosted Logfire deployments, use the `url` input to point at your instance. The audience defaults to `https://logfire.pydantic.dev` for all deployments:

```yaml
- uses: jirikuncar/logfire-github-action@main
  with:
    organization: myorg
    project: myapp
    url: https://logfire.internal.company.com
```

### Self-Hosted with GitHub Enterprise

If you're using GitHub Enterprise Server with a custom OIDC issuer, ensure your self-hosted Logfire backend is configured with:

```env
GITHUB_OIDC_ISSUER=https://github.yourcompany.com/_services/token
GITHUB_OIDC_JWKS_URL=https://github.yourcompany.com/_services/token/.well-known/jwks
```

Then in your workflow:

```yaml
- uses: jirikuncar/logfire-github-action@main
  with:
    organization: myorg
    project: myapp
    url: https://logfire.internal.company.com
```

## Matrix Workflows

In a matrix strategy, `GITHUB_JOB` is the same across all matrix entries. Pass the matrix context via `job-id` to get unique span IDs per combination:

```yaml
jobs:
  test:
    strategy:
      matrix:
        python: ['3.11', '3.12', '3.13']
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: jirikuncar/logfire-github-action@main
        with:
          organization: myorg
          project: myapp
          job-id: ${{ github.job }}-${{ toJson(matrix) }}

      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
      - run: pip install -e ".[test]"
      - run: pytest --logfire
```

Each matrix combination appears as a distinct job span in the Logfire trace.

## AI Evals Example

Run Pydantic Evals against multiple LLM models with full observability — every model call, token cost, and evaluation score traced as spans:

```yaml
name: AI Evals
on:
  workflow_dispatch:
    inputs:
      model:
        description: 'Model to evaluate'
        default: 'openai:gpt-4o'

permissions:
  id-token: write

jobs:
  eval:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: jirikuncar/logfire-github-action@main
        with:
          organization: myorg
          project: ai-evals
          region: eu
          token-ttl-seconds: 1800

      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -e ".[evals]"
      - run: python run_evals.py --model ${{ inputs.model }}
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The logfire SDK and `logfire.instrument_pydantic_ai()` automatically send all eval spans under the `TRACEPARENT` set by the action.

## Token Lifecycle

1. **Main step**: Fetches GitHub OIDC JWT, exchanges it for short-lived Logfire tokens, exports env vars
2. **Post step** (automatic, runs on `always()`): Revokes all issued tokens — write token deleted from DB, JWT added to Redis denylist

No manual cleanup step needed. Tokens are revoked even if the job fails.

## Distributed Tracing

The action computes deterministic trace/span IDs from the GitHub run context:

```
trace_id = SHA-256("logfire:github:trace:{run_id}:{run_attempt}")[0:32]
job_span  = SHA-256("logfire:github:job:{run_id}:{run_attempt}:{job_id}")[0:16]
```

This enables:
- Webhook spans (workflow_run, workflow_job) and SDK spans to share the same trace
- `TRACEPARENT` auto-propagation to all logfire SDK calls in subsequent steps
- Cross-job correlation within the same workflow run

## Prerequisites

1. **Trust policy** configured in Logfire organization settings
2. **`id-token: write`** permission in workflow
3. **Logfire project** (for write token / SDK integration)

## Environment Variables Set

| Variable | Condition | Value |
|----------|-----------|-------|
| `LOGFIRE_TOKEN` | `export-token: true` (default) | Write token (if project scoped) or JWT |
| `LOGFIRE_BASE_URL` | `export-token: true` (default) | Resolved Logfire API URL |
| `LOGFIRE_SEND_TO_LOGFIRE` | `export-token: true` (default) | `true` |
| `TRACEPARENT` | `export-traceparent: true` (default) | W3C traceparent header |

## Local Testing

You can test the full OIDC exchange flow locally without a real GitHub Actions runner. The helper script at `scripts/test_github_oidc_local.py` starts a mock OIDC provider that signs JWTs with a locally-generated RSA key pair.

### Prerequisites

```bash
# Start postgres and redis (if not already running)
make compose-up-ff-companion

# Ensure PyJWT with RSA support is available
uv pip install PyJWT cryptography
```

### Step 1: Start the mock OIDC provider

```bash
uv run python scripts/test_github_oidc_local.py serve
```

This starts a local JWKS server at `http://localhost:9099` that serves:
- `/.well-known/jwks` — the RSA public key in JWK format
- `/.well-known/openid-configuration` — OIDC discovery document

### Step 2: Start the backend with OIDC pointed at the mock

```bash
GITHUB_OIDC_ISSUER=http://localhost:9099 \
GITHUB_OIDC_JWKS_URL=http://localhost:9099/.well-known/jwks \
GITHUB_OIDC_AUDIENCE=http://localhost:9000 \
uv run python src/services/logfire-backend/local.py
```

The backend starts on port 9000 and validates JWTs against the mock provider instead of GitHub.

### Step 3: Trust policy (auto-created)

The backend bootstrap (`local.py`) automatically creates a default trust policy for the `e2e-test` org:

| Field | Value |
|-------|-------|
| Name | `Local Development` |
| `repository_owner` | `pydantic` |
| `repository` | `NULL` (any pydantic/* repo) |
| `ref_pattern` | `NULL` (any branch/tag) |
| Scopes | `project:read`, `project:write` |
| TTL | 3600s (1 hour) |

If you need a different policy (e.g., for a non-pydantic repo), add one manually:

```bash
docker exec -it platform-postgres-1 psql -U postgres -d crud -c "
  INSERT INTO logfire.github_oidc_trust_policies (
    organization_id, name, repository, repository_owner,
    scopes, token_ttl_seconds, created_by
  )
  SELECT o.id, 'Custom Policy', 'your-org/your-repo', 'your-org',
         ARRAY['project:read','project:write'], 3600, u.id
  FROM logfire.organizations o, logfire.users u
  WHERE o.organization_name = 'e2e-test'
  LIMIT 1;
"
```

Or see `uv run python scripts/test_github_oidc_local.py create-policy` for UI and curl alternatives.

### Step 4: Exchange a token

```bash
uv run python scripts/test_github_oidc_local.py exchange \
    --org e2e-test \
    --repo pydantic/logfire
```

This mints a JWT, sends it to `POST /api/github/oidc/exchange`, and prints the result including export commands for `LOGFIRE_TOKEN` and `TRACEPARENT`.

### Step-by-step alternative

If you want to control each step:

```bash
# Mint a JWT only (prints the raw token)
uv run python scripts/test_github_oidc_local.py mint-jwt \
    --repo pydantic/logfire \
    --ref refs/heads/main

# Exchange it manually
curl -s -X POST http://localhost:9000/api/github/oidc/exchange \
    -H 'Content-Type: application/json' \
    -d '{"token": "<paste-jwt-here>", "organization": "e2e-test"}' | jq .
```

### Testing different scenarios

```bash
# Different repository
uv run python scripts/test_github_oidc_local.py exchange \
    --org e2e-test --repo other-org/other-repo

# With project scoping (creates a write token)
uv run python scripts/test_github_oidc_local.py exchange \
    --org e2e-test --project my-project --repo pydantic/logfire

# With specific scopes
uv run python scripts/test_github_oidc_local.py exchange \
    --org e2e-test --repo pydantic/logfire --scopes project:read

# Simulating a specific ref (to test ref_pattern matching)
uv run python scripts/test_github_oidc_local.py exchange \
    --org e2e-test --repo pydantic/logfire --ref refs/tags/v1.0.0

# Test revocation
curl -s -X POST http://localhost:9000/api/github/oidc/revoke \
    -H 'Content-Type: application/json' \
    -d '{"logfire_token": "<token>", "access_token": "<jwt>"}'
```

### Testing webhooks

To test the webhook endpoint locally:

```bash
# Create a webhook config
docker exec -it platform-postgres-1 psql -U postgres -d crud -c "
  INSERT INTO logfire.github_webhook_configs (
    organization_id, project_id, webhook_secret_hash, track_workflow_runs, track_workflow_jobs
  )
  SELECT o.id, p.id, 'my-webhook-secret', true, true
  FROM logfire.organizations o
  JOIN logfire.projects p ON p.organization_id = o.id
  WHERE o.organization_name = 'e2e-test'
  LIMIT 1;
"

# Send a fake workflow_run event
curl -s -X POST http://localhost:9000/api/github/webhooks/events \
    -H 'Content-Type: application/json' \
    -H 'X-GitHub-Event: workflow_run' \
    -H "X-Hub-Signature-256: sha256=$(echo -n '{"action":"completed","workflow_run":{"id":123,"run_attempt":1,"name":"CI","conclusion":"success","status":"completed","head_branch":"main","head_sha":"abc123","event":"push","actor":{"login":"test"},"html_url":"https://github.com/pydantic/logfire/actions/runs/123","run_started_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:05:00Z"},"repository":{"full_name":"pydantic/logfire"}}' | openssl dgst -sha256 -hmac 'my-webhook-secret' | awk '{print $2}')" \
    -H 'X-GitHub-Delivery: test-delivery-1' \
    -d '{"action":"completed","workflow_run":{"id":123,"run_attempt":1,"name":"CI","conclusion":"success","status":"completed","head_branch":"main","head_sha":"abc123","event":"push","actor":{"login":"test"},"html_url":"https://github.com/pydantic/logfire/actions/runs/123","run_started_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:05:00Z"},"repository":{"full_name":"pydantic/logfire"}}'
```

### Cleaning up

The generated RSA key pair is stored in `scripts/.oidc-test-keys/` (gitignored). Delete it to force regeneration:

```bash
rm -rf scripts/.oidc-test-keys/
```

## Testing with Real GitHub (ngrok)

To test the full end-to-end flow with real GitHub Actions OIDC tokens, you need to expose your local backend to the internet so GitHub's runners can reach it. [ngrok](https://ngrok.com/) is the simplest way to do this.

### Prerequisites

- [ngrok](https://ngrok.com/download) installed and authenticated (`ngrok config add-authtoken <token>`)
- Docker Compose services running: `make compose-up-ff-companion`
- A GitHub repository where you can create workflows

### Step 1: Start the backend

Start the backend normally — no mock OIDC overrides needed since we're using real GitHub tokens:

```bash
uv run python src/services/logfire-backend/local.py
```

The backend starts on port 9000 with the default `GITHUB_OIDC_ISSUER=https://token.actions.githubusercontent.com`.

### Step 2: Start ngrok

```bash
ngrok http 9000
```

ngrok prints a public URL like `https://a1b2c3d4.ngrok-free.app`. Copy this — it's your `LOGFIRE_URL` for API routing.

The OIDC audience is always `https://logfire.pydantic.dev` (the default), so no backend restart is needed.

### Step 3: Trust policy

The default bootstrap policy already matches any `pydantic/*` repository. If your test repo is under a different owner, create an additional policy:

```bash
docker exec -it platform-postgres-1 psql -U postgres -d crud -c "
  INSERT INTO logfire.github_oidc_trust_policies (
    organization_id, name, repository, repository_owner,
    scopes, token_ttl_seconds, created_by
  )
  SELECT o.id, 'ngrok Test', 'YOUR_ORG/YOUR_REPO', 'YOUR_ORG',
         ARRAY['project:read','project:write'], 3600, u.id
  FROM logfire.organizations o, logfire.users u
  WHERE o.organization_name = 'e2e-test'
  LIMIT 1;
"
```

### Step 5: Create a test workflow

In your GitHub repository, create `.github/workflows/test-oidc.yml`:

```yaml
name: Test Logfire OIDC
on: workflow_dispatch

permissions:
  id-token: write
  contents: read

jobs:
  test-oidc:
    runs-on: ubuntu-latest
    steps:
      - name: Logfire OIDC Auth
        uses: jirikuncar/logfire-github-action@<your-branch>
        id: logfire
        with:
          organization: e2e-test
          url: https://a1b2c3d4.ngrok-free.app

      - name: Verify tokens
        run: |
          echo "Access token present: $([ -n '${{ steps.logfire.outputs.token }}' ] && echo yes || echo no)"
          echo "Logfire token present: $([ -n '${{ steps.logfire.outputs.logfire-token }}' ] && echo yes || echo no)"
          echo "Traceparent: ${{ steps.logfire.outputs.traceparent }}"
          echo "Expires in: ${{ steps.logfire.outputs.expires-in }}s"
          echo "Scopes: ${{ steps.logfire.outputs.scopes }}"
          echo "LOGFIRE_TOKEN env set: $([ -n "$LOGFIRE_TOKEN" ] && echo yes || echo no)"
          echo "TRACEPARENT env set: $([ -n "$TRACEPARENT" ] && echo yes || echo no)"

      - name: Test SDK integration (optional)
        run: |
          pip install logfire
          python -c "
          import logfire
          logfire.configure()
          with logfire.span('oidc-test-span'):
              logfire.info('Hello from GitHub Actions via OIDC')
          "
```

Replace `<your-branch>` with the branch containing the action code (e.g., `claude/github-actions-oidc-integration-HtCFX`).

### Step 6: Trigger the workflow

Go to the repository's Actions tab and manually dispatch the "Test Logfire OIDC" workflow. Watch the logs to confirm:

1. GitHub OIDC token was fetched
2. Exchange with your local backend succeeded (you'll see the request in ngrok's web inspector at `http://localhost:4040`)
3. Environment variables were exported
4. Post-step revocation ran

### Debugging

**ngrok web inspector:** Open `http://localhost:4040` in your browser to see all HTTP requests hitting your local backend, including full request/response bodies.

**Common issues:**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Invalid audience` (401) | Backend `GITHUB_OIDC_AUDIENCE` doesn't match | Ensure backend uses default `https://logfire.pydantic.dev` |
| `No trust policy matches` (403) | Trust policy `repository` doesn't match | Check the policy matches `owner/repo` exactly |
| `Connection refused` | ngrok tunnel not running or wrong port | Verify ngrok is forwarding to port 9000 |
| `502 Bad Gateway` | Backend not running | Start the backend first, then ngrok |
| Exchange works but SDK fails | `LOGFIRE_BASE_URL` points to ngrok but SDK needs different host | Check the action's `url` input matches the ngrok URL |

### Testing webhooks with ngrok

ngrok also works for testing real GitHub webhooks:

1. In your GitHub repository, go to Settings > Webhooks > Add webhook
2. Set Payload URL to `https://a1b2c3d4.ngrok-free.app/api/github/webhooks/events`
3. Set Content type to `application/json`
4. Set Secret to a value, then create a matching webhook config in the DB:

```bash
docker exec -it platform-postgres-1 psql -U postgres -d crud -c "
  INSERT INTO logfire.github_webhook_configs (
    organization_id, project_id, webhook_secret_hash,
    track_workflow_runs, track_workflow_jobs
  )
  SELECT o.id, p.id, '<your-webhook-secret>', true, true
  FROM logfire.organizations o
  JOIN logfire.projects p ON p.organization_id = o.id
  WHERE o.organization_name = 'e2e-test'
  LIMIT 1;
"
```

5. Select events: `Workflow runs` and `Workflow jobs`
6. Trigger a workflow — webhook events will appear in the ngrok inspector and create spans in the backend
