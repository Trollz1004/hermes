# Emergent + CRM telemetry in JARVIS

## Purpose

JARVIS exposes a read-only business telemetry card for the Date App/Emergent
surface and the self-hosted CRM/marketing surface. It is an operational view,
not a replacement for either application and it does not perform CRM writes.

## Source provenance

The data contract is derived from the fetched ANTIGRAVITY `origin/main` history:

- Commit `c4d8c2f4` (`feat(emergent): dashboard on :3210 with launch script and JARVIS tie-in plan`)
- `docs/emergent-jarvis-tie-in-plan.md` — Date App health and admin analytics shapes
- `crm/backend/server.py` — CRM dashboard, lead, campaign, automation, social capture, and landing-page routes
- `briefings/CRM-SELFHOST-2026-08-26.md` — self-hosted CRM address (`:8001`) and Date App/backend topology
- `crm/memory/PRD.md`, `crm/memory/FABLE5_DISPATCH_PROMPT.md`, and `crm/memory/CLAUDE_CLI_INTEGRATION_PROMPT.md` — CRM/marketing operating context and Emergent-origin records

ANTIGRAVITY and Hermes remain separate repositories. The ANTIGRAVITY remote was
fetched for inspection; its commits were not merged into the active dirty
Hermes worktree.

## Server route

`GET /api/business` is implemented by `dashboard/jarvis/lib/emergent-crm.mjs`.
It fetches with bounded timeouts and returns explicit `UP`, `PARTIAL`, `DOWN`,
`AUTH REQUIRED`, `WRONG SERVICE`, or `UNAVAILABLE` states.

### Date App / Emergent

- `GET /api/v1/health` from `EMERGENT_BASE_URL` (or `DATE_APP_BASE_URL`)
- `GET /api/v1/analytics/summary` only when `EMERGENT_ADMIN_TOKEN` exists
- Analytics authentication is server-side Bearer auth; the token is never returned

### CRM and marketing

From `CRM_BASE_URL`:

- `/api/dashboard/stats` — aggregate leads, funnel, campaign, sequence, and email metrics
- `/api/leads/stats/overview` — lead score and conversion aggregates
- `/api/automation/rules?active_only=false` — automation counts only
- `/api/social-capture` — platform capture totals only
- `/api/landing-pages` — visit/conversion totals only

Raw lead records, names, email addresses, campaign content, and credentials are
not returned by the route. The browser receives only aggregate fields.

## Defaults and overrides

Defaults target the documented Sabertooth services:

- Date App/Emergent: `http://192.168.0.8:8000`
- CRM: `http://192.168.0.8:8001`

Override in the dashboard server environment or its `.env` without putting
secrets in browser code:

```text
EMERGENT_BASE_URL=http://host:port
DATE_APP_BASE_URL=http://host:port
CRM_BASE_URL=http://host:port
EMERGENT_ADMIN_TOKEN=server-only-secret
```

`EMERGENT_ADMIN_TOKEN` is optional. Without it, Date App health remains visible
and protected analytics is explicitly marked unavailable.

## Verification

- Focused telemetry tests: 5 passed
- Full dashboard suite: 13 files / 129 tests passed
- HTTP smoke test: `/api/business` returned explicit `DOWN`/`UNAVAILABLE`
  states against intentionally unreachable loopback endpoints; `/health`
  returned `status: ok`
