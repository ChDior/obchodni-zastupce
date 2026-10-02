import type { Actor } from '../ai-core/index.js';

export const SCOPES = {
  catalog: 'catalog:read', calc: 'calc:run', crm: 'crm:write', quote: 'quote:write',
  email: 'email:send', followup: 'followup:write', approval: 'approval:request', kb: 'kb:read',
} as const;

const ALL = Object.values(SCOPES);

export const webAdvisorActor = (): Actor => ({ type: 'ai', id: 'ai:web-advisor', scopes: [...ALL] });
export const followupBotActor = (): Actor => ({ type: 'ai', id: 'ai:followup-bot', scopes: [SCOPES.catalog, SCOPES.email, SCOPES.followup, SCOPES.approval, SCOPES.kb] });
/** Veřejné REST čtení (bez AI): katalog + kalkulace. */
export const publicActor = (): Actor => ({ type: 'public', id: 'public:web', scopes: [SCOPES.catalog, SCOPES.calc, SCOPES.kb] });
export const humanActor = (user: { id: string; email: string }): Actor => ({ type: 'human', id: `human:${user.email}`, scopes: ['*'] });
export const systemActor = (id = 'system'): Actor => ({ type: 'system', id: `system:${id}`, scopes: ['*'] });
