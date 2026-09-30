# Chusky remote MCP server

This Cloudflare Worker exposes a remote, stateless MCP endpoint over Chusky's public `/v1` API. It does not contain an agent runtime, Composio credentials, or a second workflow engine. Chusky remains the orchestrator; Composio continues to own connected accounts and tool execution.

Version `0.3.0` supports two authentication modes:

- Private/server-to-server mode: `Authorization: Bearer chsk_...` plus `X-Chusky-User-Id`.
- Interactive MCP mode: OAuth 2.1 authorization-code flow with S256 PKCE, dynamic client registration, encrypted provider grants, and standard protected-resource/authorization-server discovery. OAuth requires a Cloudflare KV binding named `OAUTH_KV`.

## Tools

- Discover templates and list/create project-scoped company agent profiles.
- Inspect Composio-backed apps and triggers; start Composio OAuth consent flows for a connected toolkit.
- Start durable, policy-governed runs; inspect status, events, and run history; cancel or resume runs.
- Check approval status without approving; list, inspect, cancel, and retry durable tasks.
- Start bounded autonomous missions that continue across slices and restarts; inspect checkpoints and budgets; pause, resume, or cancel them.
- Inspect mission event history, attach evidence, verify outcomes, repair failed work, and plan department-specific outcome packages.
- Search and save purpose-scoped context, including decisions, open loops, tool receipts, artifacts, meetings, and department handoffs.
- Read per-identity usage and company-project run, audit, and monthly usage summaries.
- Discover Chusky tools and trusted skills, revisit threads, inspect approvals, and retrieve artifact/file metadata.
- Manage agent profiles, triggers, and webhook targets when the caller has the `mcp:manage` scope.

No MCP tool approves an external action. Approval is a human decision made through the authenticated Chusky dashboard or an explicitly authorized host application. Chusky's API checks the project key's scopes, stable end-user identity, agent/project grants, budgets, and approval policy on every request. The server does not expose arbitrary upstream URLs or API paths.

## Local development

From this directory:

```sh
npm install
npm run typecheck
npm test
npm run dev
```

Set `CHUSKY_API_ORIGIN` in a local `.dev.vars` file to the Chusky backend origin (for example `http://localhost:8080`). Never place a project key in Worker configuration or `.dev.vars`; the MCP client supplies it in `Authorization: Bearer …`.

For OAuth development, create a KV namespace and bind it as `OAUTH_KV` in `wrangler.jsonc`:

```sh
npx wrangler kv namespace create CHUSKY_MCP_OAUTH
```

The OAuth authorize page verifies the submitted project key against Chusky, stores the key only inside the provider's encrypted grant, and issues a short-lived MCP access token. Do not use a root operator key.

Run the deterministic live smoke check against the deployed Worker after setting
an intentionally limited project key and a test identity. It discovers tools,
asserts that the approval boundary is present, and calls the read-only template
tool; it does not start a business run:

```sh
set CHUSKY_MCP_URL=https://chusky-mcp.adesrnd.workers.dev/mcp
set CHUSKY_MCP_API_KEY=chsk_...
set CHUSKY_MCP_USER_ID=staging-smoke
npm run test:live
```

Keep this key restricted to `agents:read`. For a full staging release test, use
a separate short-lived key and exercise `chusky_run_start`, duplicate the same
idempotency key, verify the durable result, and confirm that a second identity
cannot read the first identity's private run or Composio state. Those checks
require a real Chusky staging backend with Redis, QStash, and Composio configured.

## Deploy

The checked-in `wrangler.jsonc` points at the current Chusky API origin. Confirm the correct production URL, then deploy:

```sh
npx wrangler deploy
```

Configure the MCP client with a project-scoped key created in the Chusky company workspace. OAuth scopes are `mcp:read`, `mcp:run`, `mcp:manage`, and `mcp:company`; the underlying Chusky project scopes remain authoritative. `approvals:write` is intentionally excluded from the MCP surface: an MCP client can inspect status but cannot approve its own external actions. Do not use the root operator key.

Example client configuration (use the MCP URL assigned to your Worker):

```json
{
  "mcpServers": {
    "chusky": {
      "url": "https://chusky-mcp.<your-worker-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${CHUSKY_API_KEY}",
        "X-Chusky-User-Id": "${CHUSKY_END_USER_ID}"
      }
    }
  }
}
```

The host application must provide a stable, non-PII identifier for each customer/end-user. Never expose a project key in browser JavaScript. Chusky scopes durable session state and Composio connected accounts to the supplied identity; if the caller uses a workspace service identity, that workspace's connected accounts must already be linked to the corresponding Chusky identity. OAuth setup and account linking remain in Composio/Chusky, not this MCP Worker.

For general MCP clients, paste the `/mcp` URL and let the client follow OAuth discovery. The client receives a `401` challenge, discovers the protected-resource metadata and authorization server, completes PKCE, and opens the Chusky consent page. For private agents that support custom headers, the shorter configuration above remains supported.

The `/health` endpoint is a liveness check only and discloses no configuration. `/mcp` accepts Streamable HTTP MCP in both the current modern wire mode and the stateless 2025-era compatibility mode. The Worker bounds upstream calls to 25 seconds, returns structured MCP content with readable text fallback, annotates tools as read-only/destructive/idempotent where applicable, and reports protocol errors without logging credentials or tool arguments.

## Exact OAuth discovery endpoints

OAuth-capable MCP clients should start with the `/mcp` URL and follow the
`WWW-Authenticate` challenge. The server publishes:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/oauth/register
/authorize
/oauth/token
```

The authorization flow is OAuth 2.1 authorization code with S256 PKCE. The
client must send the canonical MCP resource URI in the `resource` parameter,
keep its `state` value, and send the bearer access token on every MCP request.
The Worker rejects plain PKCE and implicit flow. The project key entered on the
Chusky consent page is kept inside the encrypted OAuth grant; it is not returned
to the MCP client.

If OAuth is not required, project-key mode remains supported and is usually the
best fit for a trusted backend. OAuth requires the `OAUTH_KV` binding in every
deployed environment. Creating a namespace is not enough: copy its production
ID into the `OAUTH_KV` binding in `wrangler.jsonc` or the target Wrangler
environment before deploying.

## Complete public tool catalog

The live MCP schema from `tools/list` is authoritative. These are the current
public names and their minimum MCP scope:

| Group | Tools |
| --- | --- |
| Discovery | `chusky_agent_templates`, `chusky_agents_list`, `chusky_tools_list`, `chusky_skills_search`, `chusky_skill_read` |
| Agent profiles | `chusky_agent_create`, `chusky_agent_get`, `chusky_agent_update`, `chusky_agent_delete` |
| Composio | `chusky_composio_apps_list`, `chusky_composio_connect_app`, `chusky_triggers_list` |
| Runs | `chusky_run_start`, `chusky_run_get`, `chusky_runs_list`, `chusky_run_events`, `chusky_run_cancel`, `chusky_run_resume` |
| Tasks | `chusky_tasks_list`, `chusky_task_get`, `chusky_task_cancel`, `chusky_task_retry` |
| Autonomous missions | `chusky_missions_list`, `chusky_mission_get`, `chusky_mission_start`, `chusky_mission_step_complete`, `chusky_mission_replan`, `chusky_mission_event`, `chusky_mission_pause`, `chusky_mission_resume`, `chusky_mission_cancel` |
| Mission proof and outcomes | `chusky_mission_events`, `chusky_mission_proof`, `chusky_mission_evidence`, `chusky_mission_verify`, `chusky_mission_repair`, `chusky_outcomes_list`, `chusky_outcome_plan` |
| Context graph | `chusky_context_search`, `chusky_context_save` |
| Threads | `chusky_threads_list`, `chusky_thread_get`, `chusky_thread_update` |
| Approvals | `chusky_approval_status`, `chusky_approvals_list` |
| Files and artifacts | `chusky_file_get`, `chusky_artifacts_list`, `chusky_artifact_get` |
| Triggers | `chusky_trigger_create`, `chusky_trigger_update`, `chusky_trigger_delete` |
| Webhooks | `chusky_webhooks_list`, `chusky_webhook_create`, `chusky_webhook_update`, `chusky_webhook_delete`, `chusky_webhook_deliveries_list`, `chusky_webhook_delivery_retry` |
| Usage | `chusky_usage_get`, `chusky_company_runs_list`, `chusky_company_audit_list`, `chusky_company_usage_get` |
| Autonomy | `chusky_autonomy_status`, `chusky_autonomy_reconcile`, `chusky_company_autonomy_status`, `chusky_company_autonomy_reconcile` |

Read/list/get tools require `mcp:read`; run start/cancel/resume and task
cancel/retry, mission evidence/verification/repair, and context writes require `mcp:run`; profile, connection, trigger, thread, and
webhook mutations require `mcp:manage`; company aggregates require
`mcp:company`. A stronger scope includes the weaker read scopes, but the
underlying Chusky project key scopes are still checked by the API.

The server also publishes two owner-scoped MCP resources for clients that
prefer resource reads during planning:

```text
chusky://outcomes/catalog
chusky://missions/overview
```

Resources require `mcp:read` and resolve through the same authenticated Chusky
API as the tools. They never expose another identity's missions, context, or
connected accounts.

The most important input contracts are:

```json
{
  "chusky_run_start": {
    "input": "string",
    "agentId": "optional profile or template slug",
    "budget": "optional duration, maxToolCalls, maxCost",
    "tools": "optional allow, deny, requireApproval arrays",
    "idempotencyKey": "required string, 8–200 characters"
  },
  "chusky_run_get": { "threadId": "string", "runId": "string" },
  "chusky_mission_start": {
    "title": "string",
    "objective": "string",
    "definitionOfDone": "string",
    "budgets": "optional maxDurationSeconds, maxSteps, maxToolCalls, maxCost",
    "idempotencyKey": "required string, 8–200 characters"
  },
  "chusky_mission_event": {
    "missionId": "string",
    "provider": "string",
    "providerEventId": "stable provider event id"
  },
  "chusky_mission_evidence": {
    "missionId": "string",
    "stepId": "optional string",
    "evidence": "bounded array of source, receipt, artifact, assertion, before/after, or human-confirmation records"
  },
  "chusky_mission_verify": {
    "missionId": "string",
    "evidenceIds": "optional array",
    "confidence": "optional number from 0 to 1"
  },
  "chusky_outcome_plan": {
    "slug": "qualified-fintech-leads | support-case-resolution | competitor-change-report | employee-onboarding | finance-exception-reconciliation | executive-weekly-review | production-incident-repair",
    "input": "object of business inputs"
  },
  "chusky_context_search": {
    "purpose": "planning | execution | meeting | support | sales | reporting | handoff",
    "scope": "user | organization | department | project | mission | meeting | conversation | channel",
    "query": "optional text query"
  },
  "chusky_skill_read": { "name": "string", "path": "optional skill-relative path" },
  "chusky_composio_connect_app": { "toolkit": "string", "alias": "optional string" },
  "chusky_webhook_create": { "url": "HTTPS URL", "idempotencyKey": "optional string" }
}
```

The server currently exposes no approval-write tool, arbitrary file upload tool,
arbitrary upstream URL tool, or root project administration tool. That is
intentional: MCP is the governed orchestration surface, not an unrestricted
control-plane proxy.

## Client setup examples

PowerShell variables for project-key mode:

```powershell
$env:CHUSKY_API_KEY = "chsk_..."
$env:CHUSKY_END_USER_ID = "acme_workspace_service"
```

macOS/Linux:

```sh
export CHUSKY_API_KEY=chsk_...
export CHUSKY_END_USER_ID=acme_workspace_service
```

Use `${CHUSKY_API_KEY}` and `${CHUSKY_END_USER_ID}` only if the selected MCP
client actually expands environment variables. Otherwise use its secret-store
configuration. Never paste the raw key into a model prompt or commit it to a
client configuration file.

For local development, create `.dev.vars` with only the trusted backend origin:

```dotenv
CHUSKY_API_ORIGIN=http://localhost:8080
```

The client still supplies the project key at request time. To use OAuth locally,
create a KV namespace, put its ID in the `OAUTH_KV` binding, and verify the
discovery URLs through the local Worker. The Chusky API must also be running for
the consent page to verify a project key.

## Production proof checklist

`npm run typecheck` and `npm test` are deterministic local checks. They do not
prove Redis, QStash, Composio, Cloudflare KV, or an external OAuth client are
configured correctly. Before a production launch, run `npm run test:live` with a
short-lived read-only staging key, then run a separate staging matrix that covers:

1. MCP `initialize`, `tools/list`, and a read-only `tools/call` through the
   deployed Worker.
2. Missing, malformed, revoked, wrong-project, and wrong-scope keys.
3. OAuth protected-resource discovery, dynamic registration, S256 PKCE, consent,
   refresh, and revoke.
4. Two stable identities cannot read each other's threads, tasks, approvals,
   files, artifacts, usage, or Composio connections.
5. A project key cannot access another project's agents or company telemetry.
6. Repeating one `chusky_run_start` idempotency key does not create a duplicate;
   changing the request with that key returns an idempotency conflict.
7. A risky run pauses for human approval, cannot self-approve, and resumes only
   with the original action and policy.
8. Task cancellation, retry, webhook delivery retry, upstream timeout, invalid
   JSON, redirects, and oversized responses fail safely and stay bounded.
9. Worker logs contain no project keys, OAuth tokens, consent URLs, prompts,
   provider payloads, or unredacted tool arguments.

The live smoke test intentionally stops before a business run. Use real staging
Redis/QStash/Composio accounts for the durable-run and isolation checks; a local
test cannot substitute for those external state boundaries.

## MCP versus the other Chusky surfaces

| Need | Use |
| --- | --- |
| Another model host should discover Chusky capabilities | Remote MCP |
| Your backend needs typed streaming, files, or deterministic CRUD | TypeScript SDK or `/v1` REST |
| A background event should start work without an active MCP connection | Chusky webhook or Composio trigger |
| A dashboard needs organizations, project keys, policy, or human approvals | Authenticated Chusky dashboard |
| Chusky itself needs to act in Gmail, Salesforce, Slack, or HubSpot | Composio/native tool layer |

The MCP Worker remains stateless. If its connection drops, keep the returned
`threadId` and `runId`, reconnect, and call `chusky_run_get` or
`chusky_run_events`. A lost MCP response is not proof that the durable run
failed, and starting a replacement run without checking is unsafe.
