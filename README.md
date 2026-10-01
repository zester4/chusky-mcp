# Chusky MCP

Connect Chusky to an MCP-compatible AI client so it can discover the right
capability, use your connected business apps, and keep work moving after a
conversation ends.

Chusky MCP is useful when you want an AI host to:

- qualify a lead, update a CRM, and draft a follow-up;
- investigate a support issue across email, CRM, and internal tools;
- research a company and turn the findings into a brief;
- coordinate a multi-step business process that may need a human reply;
- run work for a person, a team, or a company with durable history and policy.

The server exposes Chusky's agent, run, mission, context, artifact, and
connected-app capabilities through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/docs/getting-started/intro).

## How it works

```text
ChatGPT / Codex / Claude / Cursor / your application
                         |
                         | MCP over HTTPS
                         v
                   Chusky MCP
                         |
                         | authenticated Chusky API calls
                         v
       Chusky policy, identity, durable runs, and missions
                         |
                         | connected app actions
                         v
             Gmail / HubSpot / Slack / Salesforce / ...
```

The MCP adapter is stateless. Chusky owns identity, policy, budgets,
idempotency, durable execution, and provider receipts. Connected-app
authentication and toolkit actions remain behind Chusky's integration layer.
Keep the returned `threadId`, `runId`, `taskId`, or `missionId` and use
those identifiers to reconnect, inspect progress, or resume work.

## Hosted endpoint

Use this remote MCP endpoint:

```text
https://chusky-mcp.adesrnd.workers.dev/mcp
```

The `/mcp` path is part of the URL. Clients that support MCP discovery can
use the endpoint to discover authentication and available tools.

## Authentication

Choose the mode that matches your client:

| Client | Recommended authentication |
| --- | --- |
| ChatGPT, Claude, Cursor, or another interactive host | OAuth 2.1 with PKCE |
| Your trusted backend or a controlled CI job | Chusky project key plus a stable user identity |

### OAuth

OAuth is the easiest option for an interactive client. The client opens the
Chusky consent flow, you sign in, and the client receives a scoped grant. Use
the same Chusky identity when reconnecting so its runs, files, approvals,
artifacts, and connected apps stay together.

### Project-key mode

For a trusted server, send both headers on every request:

```http
Authorization: Bearer chsk_your_project_key
X-Chusky-User-Id: your-stable-user-id
```

Create the project key in the Chusky workspace that owns the project. Use a
stable, non-secret identifier for `X-Chusky-User-Id`; do not put a project key
in browser code, a prompt, a public repository, or a client-side config file.

## Connect a client

The exact labels vary by product, but every client needs the same two things:
the remote URL and an authentication method.

### ChatGPT

1. Open ChatGPT web and enable Developer mode in the workspace or account
   settings. Workspace administrators may need to enable it first.
2. Open **Apps** (or **Settings → Apps**) and choose **Create app**.
3. Enter the MCP URL, select OAuth when prompted, and let ChatGPT scan the
   tools.
4. Create the draft app, open a new chat, and select it from the tools/apps
   menu.
5. Start with a read-only request such as “list my Chusky agents.” Review any
   confirmation shown before a write action.

See [ChatGPT developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
for the current workspace steps. ChatGPT keeps a tool snapshot for a published
app, so rescan or refresh it after changing the server's tool contract.

### Codex CLI

Add the hosted server:

```bash
codex mcp add chusky --url https://chusky-mcp.adesrnd.workers.dev/mcp
codex mcp list
```

Complete the OAuth prompt in the browser, then ask Codex to list agents or
inspect a run. Codex and its supported IDE clients use the same MCP
configuration, so a server added once can be reused by those clients.

See the [OpenAI MCP setup guide](https://developers.openai.com/learn/docs-mcp).

### Claude Code

```bash
claude mcp add --transport http chusky https://chusky-mcp.adesrnd.workers.dev/mcp
claude mcp list
```

Run `/mcp` inside Claude Code to finish or inspect the connection. Use
`--scope user` if the connection should be available across your user
projects rather than only the current project.

See [Claude Code MCP servers](https://docs.anthropic.com/en/docs/claude-code/mcp).

### Cursor

Add a remote server to `~/.cursor/mcp.json` for all projects, or
`.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "chusky": {
      "url": "https://chusky-mcp.adesrnd.workers.dev/mcp"
    }
  }
}
```

Open Cursor's MCP settings, enable the server, and complete OAuth if the
client presents it.

See [Cursor's MCP documentation](https://docs.cursor.com/context/model-context-protocol).

### Your own application

Any MCP client that supports Streamable HTTP can use the same endpoint. A
backend using the OpenAI Agents API can represent it like this:

```json
{
  "type": "mcp",
  "server_label": "chusky",
  "server_url": "https://chusky-mcp.adesrnd.workers.dev/mcp",
  "authorization": "OAUTH_ACCESS_TOKEN"
}
```

For project-key mode, keep the key on your server and send the stable identity
as a header:

```json
{
  "type": "mcp",
  "server_label": "chusky",
  "server_url": "https://chusky-mcp.adesrnd.workers.dev/mcp",
  "headers": {
    "Authorization": "Bearer chsk_your_project_key",
    "X-Chusky-User-Id": "your-stable-user-id"
  }
}
```

See [OpenAI MCP connections](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)
for the current API shape.

## Connect business apps

The client does not need a separate Gmail, HubSpot, or Slack adapter. Chusky
discovers the available app connections and starts the provider's consent
flow.

1. Call `chusky_composio_apps_list` to see what is available.
2. Call `chusky_composio_connect_app` for the app the user chooses.
3. Let the user complete the provider's consent screen.
4. Call `chusky_composio_apps_list` again and confirm that the connection is
   ready.
5. Use the same stable Chusky identity for future runs.

A client should pause and explain what is missing when an app is not connected.
After the user connects it, resume the original run or mission instead of
starting a duplicate.

## Tools at a glance

The client can discover the complete live catalog with MCP `tools/list`.
These are the main groups, shown by the job they help accomplish:

| Goal | Example tools |
| --- | --- |
| Find or configure an agent | `chusky_agent_templates`, `chusky_agents_list`, `chusky_agent_create`, `chusky_agent_get`, `chusky_agent_update` |
| Connect and inspect business apps | `chusky_composio_apps_list`, `chusky_composio_connect_app`, `chusky_tools_list` |
| Understand autonomy and available building blocks | `chusky_autonomy_status`, `chusky_autonomy_reconcile`, `chusky_company_autonomy_status`, `chusky_company_autonomy_reconcile`, `chusky_triggers_list`, `chusky_skills_search`, `chusky_skill_read` |
| Start and monitor work | `chusky_run_start`, `chusky_run_get`, `chusky_run_events`, `chusky_runs_list` |
| Discover and run native capabilities | `chusky_tools_list`, `chusky_tool_schema_get`, `chusky_native_tool_run` |
| Research and live intelligence | `chusky_tinyfish_search`, `chusky_tinyfish_fetch`, `chusky_tinyfish_research`, `chusky_tinyfish_monitor`, `chusky_treg_search`, `chusky_treg_get`, `chusky_treg_call`, `chusky_treg_resolve`, `chusky_treg_enrich_person`, `chusky_treg_enrich_company` |
| Run a specific reliability capability or recover work | `chusky_tool_run`, `chusky_run_resume`, `chusky_run_cancel`, `chusky_approval_status`, `chusky_tasks_list`, `chusky_task_get`, `chusky_task_retry`, `chusky_task_cancel` |
| Run a long-lived process | `chusky_missions_list`, `chusky_mission_start`, `chusky_mission_get`, `chusky_mission_events`, `chusky_mission_event`, `chusky_mission_step_complete`, `chusky_mission_replan` |
| Prove or repair an outcome | `chusky_mission_evidence`, `chusky_mission_verify`, `chusky_mission_repair`, `chusky_mission_proof`, `chusky_outcomes_list`, `chusky_outcome_plan` |
| Reuse knowledge and files | `chusky_context_search`, `chusky_context_save`, `chusky_artifacts_list`, `chusky_artifact_get`, `chusky_file_get` |
| Inspect conversations and approvals | `chusky_threads_list`, `chusky_thread_get`, `chusky_thread_update`, `chusky_approvals_list` |
| Automate recurring work | `chusky_trigger_create`, `chusky_trigger_update`, `chusky_trigger_delete`, `chusky_webhooks_list`, `chusky_webhook_create`, `chusky_webhook_update`, `chusky_webhook_delete`, `chusky_webhook_deliveries_list`, `chusky_webhook_delivery_retry` |
| Understand usage and company activity | `chusky_usage_get`, `chusky_company_runs_list`, `chusky_company_audit_list`, `chusky_company_usage_get` |

The agent-management tools also include `chusky_agent_delete`. Mission
control actions are represented by the mission event and checkpoint tools so a
client can record progress without inventing a second workflow protocol.

Tool names and schemas can grow over time. Treat the live `tools/list`
response and each tool's input schema as authoritative instead of copying a
static catalog into your application. `chusky_tools_list` returns the current
native catalog and matching connected-app tools. For one exact native
capability, call `chusky_tool_schema_get` with its `CHUCK_*` name, then pass
that name and validated arguments to `chusky_native_tool_run`. The runner
checks the live schema and starts a one-tool durable run, so new native
capabilities become available through MCP without a second hard-coded catalog.
Identity isolation, agent policy, budgets, and human approval remain enforced
by Chusky. A native tool that needs a file or image must receive an owner-scoped
file ID in `attachments`, obtained through the authenticated `/v1/files` API.

TinyFish and Treg also have first-class MCP aliases for easier model discovery.
They use the same live native schemas and durable one-tool run boundary as
`chusky_native_tool_run`; the aliases do not bypass project scopes, spend caps,
approval gates, connected-account ownership, or provider evidence requirements.
Research and monitor operations return a run handle, so reconnecting clients
should use `chusky_run_get` or `chusky_run_events` rather than starting a second
request after a lost response.

Two read-only resources are also available:

- `chusky://outcomes/catalog` — outcome templates and planning context.
- `chusky://missions/overview` — mission concepts and lifecycle guidance.

## Start a useful run

A run is appropriate for a bounded request that can finish in one workflow.
For example:

```json
{
  "input": "Find the latest unanswered customer question, check the CRM record, draft a helpful reply, and pause before sending.",
  "agentId": "customer-support",
  "budget": {
    "maxSteps": 12,
    "maxDurationSeconds": 300
  },
  "idempotencyKey": "support-case-2026-09-30-001"
}
```

The response gives you identifiers and an initial status. Use
`chusky_run_get` for the current state and `chusky_run_events` for progress.
If the run pauses for a connection, approval, or human answer, resolve that
dependency and call `chusky_run_resume` with the original `runId`.

Use a mission when the work spans multiple conversations, provider calls, or
human checkpoints:

```json
{
  "title": "Turn a qualified inquiry into a confirmed order",
  "objective": "Research the buyer, answer questions, negotiate within policy, and prepare the order for human confirmation.",
  "definitionOfDone": [
    "The buyer's needs and budget are recorded",
    "The CRM record is updated",
    "A final offer is prepared",
    "No irreversible purchase is made without the required approval"
  ],
  "idempotencyKey": "deal-2026-09-30-001"
}
```

Missions can be paused and resumed without losing their checkpoint. Verify the
result with mission evidence and proof rather than treating a model response as
evidence that an external action happened.

## Files and images

Upload a file through Chusky's file API or SDK first. Then pass the returned
file ID in the run or mission's `attachments` field. The file must belong to
the same authenticated identity and project.

Do not put raw image bytes, credentials, or arbitrary remote URLs in a tool
request. A provider action should receive a verified Chusky file reference; if
the file cannot be resolved, stop before creating a text-only or incomplete
external post.

## Permissions and approvals

The MCP server exposes four OAuth scopes:

| Scope | Allows |
| --- | --- |
| `mcp:read` | Read agents, runs, tasks, missions, context, files, artifacts, usage, and tool metadata |
| `mcp:run` | Start and control runs, tasks, and missions |
| `mcp:manage` | Manage agents, triggers, webhooks, and other project configuration |
| `mcp:company` | Read company-level run, audit, and usage views |

The Chusky project policy remains the final authority. A tool may still be
blocked because the connected app is missing, the project policy disallows it,
the user lacks permission, or human approval is required. MCP can inspect
approval state; approval decisions remain in the authorized Chusky control
surface.

Start with read-only tools. Add write tools only after you can identify the
target account, show the intended change, and explain how the work can be
verified or reversed.

## Build on Chusky MCP

When building an application on top of this server:

1. Give every person or service a stable Chusky identity.
2. Discover tools at startup and validate arguments against their schemas.
3. Keep `threadId`, `runId`, `taskId`, and `missionId` in durable state.
4. Use idempotency keys for every write that may be retried.
5. Treat provider receipts and fresh readbacks as proof of external changes.
6. Pause clearly when a connection, approval, or human decision is required.
7. Resume the existing run or mission after the dependency is resolved.
8. Keep credentials and authorization decisions outside the model prompt.
9. Show concise progress and a recoverable error instead of claiming success.

If you are adding a Chusky capability, make it a small, goal-oriented tool
with a precise input schema, bounded output, the narrowest required scope, and
explicit read/write behavior. Reuse Chusky's authenticated API and durable
runtime rather than creating a second workflow or credential store.

## Troubleshooting

### The client cannot connect

- Check that the URL ends in `/mcp`.
- Confirm the client supports remote Streamable HTTP.
- Restart the OAuth flow if the grant was cancelled or expired.
- Confirm that the client can reach HTTPS endpoints from its environment.

### The client connects but shows no tools

- Run the client's refresh or rescan action.
- Check that the OAuth grant includes the scope required by the tool.
- In ChatGPT, refresh the draft app after a server tool change.

### A run is paused or failed

Read the run or mission by ID before retrying. The status should tell you
whether the next step is a missing app connection, a human approval, an input
request, a provider error, or a retryable runtime failure. Resume the same
identifier once the dependency is fixed.

### A provider action did not happen

Check the provider receipt and then perform a fresh readback. A successful MCP
response alone is not proof that an email, CRM update, or social post was
created.

## Local contribution

If you are contributing to this MCP adapter, install dependencies and run the
focused checks from this directory:

```bash
npm install
npm run typecheck
npm test
```

For interactive protocol debugging, use the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) against the
hosted endpoint or your local server. Do not put real project keys or provider
tokens in a shared issue, fixture, log, or repository.

## Further reading

- [Model Context Protocol introduction](https://modelcontextprotocol.io/docs/getting-started/intro)
- [ChatGPT developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [OpenAI MCP connections](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp)
- [Claude Code MCP servers](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
