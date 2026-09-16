import { describe, expect, it } from 'vitest';
import { businessSnapshot, cleanBase } from '../lib/emergent-crm.mjs';

const jsonResponse = (body, status = 200) => ({
  status,
  text: async () => JSON.stringify(body),
});

function fetchMap(routes, calls) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    const route = routes.find(([suffix]) => url.endsWith(suffix));
    if (!route) throw new Error(`unexpected request: ${url}`);
    const [suffix, body, status] = route;
    return jsonResponse(body, status);
  };
}

const dateHealth = {
  status: 'ok', db_connected: true, redis_connected: true, square_connected: true,
  square_signature_configured: false, wallet_rails_proven: false,
  wallet_rails_status: 'unproven', payment_proof_labels: [], user_count: 3,
};
const crmDashboard = {
  total_leads: 12, total_groups: 4, total_templates: 2, total_campaigns: 3,
  total_sequences: 1, total_cities: 48, total_categories: 12,
  lead_funnel: { new: 5, qualified: 4, converted: 3 }, hot_leads: 2,
  email_stats: { sent: 20, opened: 10, open_rate: 50 },
  recent_leads: [{ name: 'Do not return me', email: 'private@example.test' }],
};

const fullRoutes = [
  ['/api/v1/health', dateHealth],
  ['/api/dashboard/stats', crmDashboard],
  ['/api/leads/stats/overview', { total: 12, score_ranges: { hot: 2 }, conversion_rate: 25, total_conversion_value: 100 }],
  ['/api/automation/rules?active_only=false', [{ active: true }, { active: false }]],
  ['/api/social-capture', [{ active: true, leads_captured: 7 }]],
  ['/api/landing-pages', [{ active: true, visits: 100, conversions: 8 }]],
  ['/api/v1/analytics/summary', { total_events: 20, unique_users: 3, signups_total: 5, paying_count: 1, events_by_type: { signup: 5 } }],
];

describe('businessSnapshot', () => {
  it('composes Date App, CRM, and marketing aggregates without lead PII', async () => {
    const calls = [];
    const snapshot = await businessSnapshot({
      env: { EMERGENT_BASE_URL: 'http://date-app.test:8000', CRM_BASE_URL: 'http://crm.test:8001', EMERGENT_ADMIN_TOKEN: 'server-only' },
      fetch: fetchMap(fullRoutes, calls),
      now: () => '2026-09-16T00:00:00.000Z',
    });

    expect(snapshot).toMatchObject({
      source: 'ANTIGRAVITY', at: '2026-09-16T00:00:00.000Z',
      emergent: { state: 'UP', analytics: { state: 'UP', analytics: { payingCount: 1 } } },
      crm: { state: 'UP', crm: { totalLeads: 12, hotLeads: 2, email: { openRate: 50 } } },
      marketing: { state: 'UP', marketing: { activeAutomationRules: 1, socialLeadsCaptured: 7, landingPageConversions: 8 } },
    });
    expect(JSON.stringify(snapshot)).not.toContain('private@example.test');
    expect(JSON.stringify(snapshot)).not.toContain('server-only');
    expect(calls.find(({ url }) => url.endsWith('/api/v1/analytics/summary')).options.headers.authorization).toBe('Bearer server-only');
  });

  it('does not request protected analytics without a server token', async () => {
    const calls = [];
    const snapshot = await businessSnapshot({ env: {}, fetch: fetchMap(fullRoutes.slice(0, 6), calls) });
    expect(snapshot.emergent.analytics.state).toBe('UNAVAILABLE');
    expect(calls.some(({ url }) => url.includes('/analytics/summary'))).toBe(false);
  });

  it('reports partial marketing health and wrong JSON types honestly', async () => {
    const routes = fullRoutes.slice(0, 3).concat([
      ['/api/automation/rules?active_only=false', { active: true }],
      ['/api/social-capture', [{ active: true, leads_captured: 2 }]],
      ['/api/landing-pages', [], 503],
    ]);
    const snapshot = await businessSnapshot({ env: {}, fetch: fetchMap(routes, []) });
    expect(snapshot.marketing.state).toBe('PARTIAL');
    expect(snapshot.marketing.marketing.socialLeadsCaptured).toBe(2);
    expect(snapshot.marketing.marketing.activeAutomationRules).toBe(0);
  });

  it('marks unreachable services down instead of inventing zero metrics', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED'); };
    const snapshot = await businessSnapshot({ env: {}, fetch });
    expect(snapshot.emergent.state).toBe('DOWN');
    expect(snapshot.crm.state).toBe('DOWN');
    expect(snapshot.marketing.state).toBe('DOWN');
  });
});

describe('configuration safety', () => {
  it('accepts HTTP(S) bases and falls back from malformed values', () => {
    expect(cleanBase('https://sabertooth.test/', 'http://fallback.test')).toBe('https://sabertooth.test');
    expect(cleanBase('file:///secret', 'http://fallback.test')).toBe('http://fallback.test');
  });
});
