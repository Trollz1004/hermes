/**
 * Read-only business telemetry for the JARVIS HUD.
 *
 * The Date App/Emergent API and the self-hosted CRM remain authoritative for
 * their own data. This module only composes small, server-side summaries:
 * credentials stay in the server process and lead records never reach the
 * browser. Every request is bounded and every unavailable source is explicit.
 */

const DEFAULTS = {
  emergentBaseUrl: 'http://192.168.0.8:8000',
  crmBaseUrl: 'http://192.168.0.8:8001',
};

const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const asArray = (value) => Array.isArray(value) ? value : [];
const asNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function cleanBase(value, fallback) {
  try {
    const url = new URL(String(value || fallback));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function urlFor(base, path) { return `${base}${path}`; }

async function requestJson(url, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text };
  } catch (error) {
    return { status: 0, json: null, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function responseState(response, { requireObject = true } = {}) {
  if (!response || response.status === 0) return { state: 'DOWN', detail: response?.error || 'request failed' };
  if (response.status === 401 || response.status === 403) return { state: 'AUTH REQUIRED', detail: `HTTP ${response.status}` };
  if (response.status >= 500) return { state: 'DOWN', detail: `HTTP ${response.status}` };
  if (response.status < 200 || response.status >= 300) return { state: 'UNAVAILABLE', detail: `HTTP ${response.status}` };
  if (requireObject && !asObject(response.json)) return { state: 'WRONG SERVICE', detail: 'expected a JSON object' };
  return { state: 'UP', detail: 'identity ok' };
}

function dateHealth(response) {
  const base = responseState(response);
  if (base.state !== 'UP') return base;
  if (response.json.status !== 'ok') return { state: 'WRONG SERVICE', detail: 'health status is not ok' };
  const data = response.json;
  return {
    state: 'UP',
    detail: base.detail,
    health: {
      status: String(data.status),
      dbConnected: Boolean(data.db_connected),
      redisConnected: Boolean(data.redis_connected),
      squareConnected: Boolean(data.square_connected),
      squareSignatureConfigured: Boolean(data.square_signature_configured),
      walletRailsProven: Boolean(data.wallet_rails_proven),
      walletRailsStatus: String(data.wallet_rails_status || 'unknown'),
      paymentProofLabels: asArray(data.payment_proof_labels).map((label) => String(label)).slice(0, 20),
      userCount: asNumber(data.user_count),
    },
  };
}

function dateAnalytics(response) {
  const base = responseState(response);
  if (base.state !== 'UP') return base;
  const data = response.json;
  return {
    state: 'UP',
    detail: base.detail,
    analytics: {
      totalEvents: asNumber(data.total_events),
      uniqueUsers: asNumber(data.unique_users),
      eventsByType: Object.fromEntries(Object.entries(asObject(data.events_by_type) || {})
        .slice(0, 30).map(([key, value]) => [String(key), asNumber(value)])),
      signupsToday: asNumber(data.signups_today),
      signupsTotal: asNumber(data.signups_total),
      verifiedCount: asNumber(data.verified_count),
      payingCount: asNumber(data.paying_count),
    },
  };
}

function crmDashboard(response) {
  const base = responseState(response);
  if (base.state !== 'UP') return base;
  const data = response.json;
  return {
    state: 'UP',
    detail: base.detail,
    crm: {
      totalLeads: asNumber(data.total_leads),
      totalGroups: asNumber(data.total_groups),
      totalTemplates: asNumber(data.total_templates),
      totalCampaigns: asNumber(data.total_campaigns),
      totalSequences: asNumber(data.total_sequences),
      totalCities: asNumber(data.total_cities),
      totalCategories: asNumber(data.total_categories),
      leadFunnel: Object.fromEntries(Object.entries(asObject(data.lead_funnel) || {})
        .slice(0, 20).map(([key, value]) => [String(key), asNumber(value)])),
      hotLeads: asNumber(data.hot_leads),
      email: {
        sent: asNumber(data.email_stats?.sent),
        opened: asNumber(data.email_stats?.opened),
        openRate: asNumber(data.email_stats?.open_rate),
      },
    },
  };
}

function leadStats(response) {
  const base = responseState(response);
  if (base.state !== 'UP') return base;
  const data = response.json;
  return {
    state: 'UP', detail: base.detail,
    leadScore: {
      total: asNumber(data.total),
      scoreRanges: Object.fromEntries(Object.entries(asObject(data.score_ranges) || {})
        .slice(0, 10).map(([key, value]) => [String(key), asNumber(value)])),
      conversionRate: asNumber(data.conversion_rate),
      totalConversionValue: asNumber(data.total_conversion_value),
    },
  };
}

function arrayResponseState(response) {
  const base = responseState(response, { requireObject: false });
  if (base.state !== 'UP') return base;
  return Array.isArray(response.json) ? base : { state: 'WRONG SERVICE', detail: 'expected a JSON array' };
}

function marketingStats({ automation, social, landing }) {
  const automationState = arrayResponseState(automation);
  const socialState = arrayResponseState(social);
  const landingState = arrayResponseState(landing);
  const automationData = automationState.state === 'UP' ? asArray(automation.json) : [];
  const socialData = socialState.state === 'UP' ? asArray(social.json) : [];
  const landingData = landingState.state === 'UP' ? asArray(landing.json) : [];
  const available = [automationState, socialState, landingState].filter(({ state }) => state === 'UP').length;
  return {
    state: available === 3 ? 'UP' : available > 0 ? 'PARTIAL' : 'DOWN',
    detail: available ? `${available}/3 marketing feeds available` : 'marketing feeds unavailable',
    marketing: {
      activeAutomationRules: automationData.filter((rule) => rule?.active === true).length,
      automationRules: automationData.length,
      socialCaptureForms: socialData.length,
      socialCaptureFormsActive: socialData.filter((capture) => capture?.active === true).length,
      socialLeadsCaptured: socialData.reduce((sum, capture) => sum + asNumber(capture?.leads_captured), 0),
      landingPages: landingData.length,
      landingPagesActive: landingData.filter((page) => page?.active === true).length,
      landingPageVisits: landingData.reduce((sum, page) => sum + asNumber(page?.visits), 0),
      landingPageConversions: landingData.reduce((sum, page) => sum + asNumber(page?.conversions), 0),
    },
  };
}

/**
 * Fetch the server-side business snapshot.
 *
 * Environment names are intentionally explicit so the default points at the
 * documented Sabertooth services while deployments can override it:
 * EMERGENT_BASE_URL / DATE_APP_BASE_URL, CRM_BASE_URL, and
 * EMERGENT_ADMIN_TOKEN. The token is used only for Date App analytics and is
 * never returned.
 */
export async function businessSnapshot({
  env = {},
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  now = () => new Date().toISOString(),
} = {}) {
  const emergentBase = cleanBase(env.EMERGENT_BASE_URL || env.DATE_APP_BASE_URL, DEFAULTS.emergentBaseUrl);
  const crmBase = cleanBase(env.CRM_BASE_URL, DEFAULTS.crmBaseUrl);
  const adminToken = String(env.EMERGENT_ADMIN_TOKEN || '').trim();
  const adminHeaders = adminToken ? { authorization: `Bearer ${adminToken}` } : null;

  const [healthResponse, crmResponse, leadResponse, automation, social, landing] = await Promise.all([
    requestJson(urlFor(emergentBase, '/api/v1/health'), { fetch: fetchImpl, timeoutMs }),
    requestJson(urlFor(crmBase, '/api/dashboard/stats'), { fetch: fetchImpl, timeoutMs }),
    requestJson(urlFor(crmBase, '/api/leads/stats/overview'), { fetch: fetchImpl, timeoutMs }),
    requestJson(urlFor(crmBase, '/api/automation/rules?active_only=false'), { fetch: fetchImpl, timeoutMs }),
    requestJson(urlFor(crmBase, '/api/social-capture'), { fetch: fetchImpl, timeoutMs }),
    requestJson(urlFor(crmBase, '/api/landing-pages'), { fetch: fetchImpl, timeoutMs }),
  ]);

  const analyticsResponse = adminHeaders
    ? await requestJson(urlFor(emergentBase, '/api/v1/analytics/summary'), { fetch: fetchImpl, timeoutMs, headers: adminHeaders })
    : null;
  const date = dateHealth(healthResponse);
  const analytics = analyticsResponse
    ? dateAnalytics(analyticsResponse)
    : { state: 'UNAVAILABLE', detail: 'EMERGENT_ADMIN_TOKEN is not configured on the dashboard server' };
  const crm = crmDashboard(crmResponse);
  const lead = leadStats(leadResponse);
  const marketing = marketingStats({ automation, social, landing });

  return {
    source: 'ANTIGRAVITY',
    at: now(),
    emergent: { endpoint: 'Date App API', ...date, analytics },
    crm: { endpoint: 'Self-hosted CRM API', ...crm, ...lead },
    marketing: { endpoint: 'CRM marketing feeds', ...marketing },
  };
}

export { DEFAULTS, cleanBase, dateHealth, dateAnalytics, crmDashboard, leadStats, marketingStats, requestJson };
