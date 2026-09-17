/**
 * cline-providers.mjs — Approved provider/model routes for the Cline worker path.
 *
 * Cline is execution plumbing, not a provider. Every Cline invocation actually
 * runs against one direct provider API (Google AI Studio / Gemini, NVIDIA NIM,
 * or OpenRouter), and AR chooses which one deliberately:
 *
 *   AR -> select provider/model -> Cline -> selected direct provider API
 *
 * This module is the single place that says which provider/model pairs AR is
 * allowed to use, and in what order they are tried. Nothing else may invent a
 * provider or a model: the adapter re-validates every route against this
 * registry immediately before spawning Cline, so an unapproved model cannot
 * silently enter the pool through a config edit, a failover path, or a stale
 * caller.
 *
 * Credentials are NOT here. Cline stores each provider's API key in its own
 * secure per-provider configuration (~/.cline/data/settings/providers.json) and
 * AR only ever names the provider (`-P <id>`) and the model (`-m <id>`).
 */

// Google AI Studio / Gemini: the existing, already-working Cline configuration.
// These are exactly the models the Cline tier pools in smart-router.mjs use
// (primaries + fallbacks); a test asserts the two lists never drift apart.
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash',
  'gemini-2.5-flash'
];

export const CLINE_PROVIDERS = {
  gemini: {
    id: 'gemini',
    // The provider id Cline itself knows (`cline -P <clineProvider>`).
    clineProvider: 'gemini',
    label: 'Google AI Studio (Gemini)',
    shortLabel: 'Gemini',
    models: GEMINI_MODELS,
    disabledModels: {}
  },
  nvidia: {
    id: 'nvidia',
    clineProvider: 'nvidia',
    label: 'NVIDIA NIM',
    shortLabel: 'NVIDIA NIM',
    models: ['nvidia/nemotron-3-super-120b-a12b'],
    disabledModels: {
      // Verified failing on 2026-09-17: no usable response through Cline after
      // 55s, and no usable response on a direct NVIDIA NIM call after 120s.
      // Deliberately kept listed (rather than deleted) so an attempt to route
      // to it fails with the real reason instead of a generic "unknown model".
      'openai/gpt-oss-20b': 'Verified non-responsive on 2026-09-17 (Cline 55s and direct NVIDIA NIM 120s); not approved for routing.'
    }
  },
  openrouter: {
    id: 'openrouter',
    clineProvider: 'openrouter',
    label: 'OpenRouter',
    shortLabel: 'OpenRouter',
    models: ['cohere/north-mini-code:free', 'poolside/laguna-s-2.1:free'],
    disabledModels: {}
  }
};

// Deterministic default order. Gemini first: it is the long-standing verified
// Cline configuration, so existing behaviour is unchanged until it fails. The
// other two approved providers are then tried in a fixed order rather than
// anything adaptive — intelligent provider scoring is explicitly a later phase.
export const DEFAULT_PROVIDER_ORDER = ['gemini', 'nvidia', 'openrouter'];

export function listProviders() {
  return Object.values(CLINE_PROVIDERS);
}

export function getProvider(providerId) {
  if (!providerId) return null;
  const key = String(providerId).trim().toLowerCase();
  if (CLINE_PROVIDERS[key]) return CLINE_PROVIDERS[key];
  // Accept a few unambiguous aliases for the same provider so a config or a
  // caller written in business language still resolves to one real provider.
  const aliases = {
    'google': 'gemini',
    'google-ai-studio': 'gemini',
    'ai-studio': 'gemini',
    'nvidia-nim': 'nvidia',
    'nim': 'nvidia',
    'open-router': 'openrouter'
  };
  return CLINE_PROVIDERS[aliases[key]] || null;
}

export function isApprovedClineRoute(providerId, model) {
  const provider = getProvider(providerId);
  if (!provider || !model) return false;
  return provider.models.includes(model);
}

/**
 * Resolve one provider/model pair into a full route, or throw with the real
 * reason. Every path that can reach a live provider call goes through this.
 */
export function resolveClineRoute(providerId, model) {
  const provider = getProvider(providerId);
  if (!provider) {
    throw Error(`Unapproved Cline provider "${providerId}". Approved providers: ${Object.keys(CLINE_PROVIDERS).join(', ')}.`);
  }
  if (!model) {
    throw Error(`No model specified for Cline provider "${provider.id}". AR never relies on the provider's saved default model.`);
  }
  const disabledReason = provider.disabledModels[model];
  if (disabledReason) {
    throw Error(`Model "${model}" is disabled for ${provider.label}: ${disabledReason}`);
  }
  if (!provider.models.includes(model)) {
    throw Error(`Unapproved model "${model}" for ${provider.label}. Approved: ${provider.models.join(', ')}.`);
  }
  return {
    provider: provider.id,
    clineProvider: provider.clineProvider,
    label: provider.label,
    shortLabel: provider.shortLabel,
    model,
    // Stable identifier used for per-route health telemetry, so a failing
    // provider/model pair is tracked separately from "Cline" as a whole.
    healthId: `cline:${provider.id}:${model}`
  };
}

/**
 * Build the deterministic ordered list of provider/model attempts for one
 * Cline invocation.
 *
 * - `primaryModel`/`fallbackModels` come from the existing Gemini tier pools
 *   in smart-router.mjs, so the Gemini path behaves exactly as before.
 * - Every other provider contributes its approved models in declared order.
 * - `pinnedProvider`/`pinnedModel` narrow the sequence to one provider (or one
 *   exact route) — used by explicit selection and by live verification.
 *
 * Unapproved entries are dropped rather than attempted; if a pin is unapproved
 * it throws, because a pin is an explicit instruction and must never silently
 * become a different model.
 */
export function buildClineRouteSequence({
  primaryModel = '',
  fallbackModels = [],
  providerOrder = DEFAULT_PROVIDER_ORDER,
  pinnedProvider = null,
  pinnedModel = null
} = {}) {
  if (pinnedModel) {
    const providerForModel = pinnedProvider || providerIdForModel(pinnedModel);
    return [resolveClineRoute(providerForModel, pinnedModel)];
  }

  const order = pinnedProvider
    ? [pinnedProvider]
    : (Array.isArray(providerOrder) && providerOrder.length > 0 ? providerOrder : DEFAULT_PROVIDER_ORDER);

  const routes = [];
  const seen = new Set();
  for (const providerId of order) {
    const provider = getProvider(providerId);
    if (!provider) {
      if (pinnedProvider) throw Error(`Unapproved Cline provider "${providerId}".`);
      continue; // an unknown provider in config is ignored, never guessed at
    }
    // Gemini keeps the tier-selected model ordering it already had; if the
    // caller supplied no Gemini models (e.g. a non-Gemini pin), fall back to
    // the provider's declared order.
    const wanted = provider.id === 'gemini'
      ? [primaryModel, ...(Array.isArray(fallbackModels) ? fallbackModels : [])].filter(Boolean)
      : [];
    const models = wanted.filter(m => provider.models.includes(m));
    const finalModels = models.length > 0 ? models : provider.models;
    for (const model of finalModels) {
      if (provider.disabledModels[model]) continue;
      const key = `${provider.id}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(resolveClineRoute(provider.id, model));
    }
  }
  if (routes.length === 0) {
    throw Error('No approved Cline provider/model route is available for this request.');
  }
  return routes;
}

/** Which approved provider owns a model id, if any. */
export function providerIdForModel(model) {
  if (!model) return null;
  for (const provider of listProviders()) {
    if (provider.models.includes(model)) return provider.id;
  }
  return null;
}

/**
 * Business-facing identity for a Cline invocation: the real provider and
 * model, not "Cline". Used in activity text, the staff log and telemetry.
 */
export function describeClineRoute(route) {
  if (!route) return 'Cline';
  const label = route.label || getProvider(route.provider)?.label || 'Cline';
  return route.model ? `${label} (${route.model})` : label;
}
