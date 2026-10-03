import { bootstrap } from '../beleta/bootstrap.js';
import { buildServer } from './app.js';
import { pricingFromEnv } from '../ai-core/index.js';
import { searchFromEnv } from '../beleta/search.js';
import { createLlmFromEnv } from './llm-config.js';

const env = process.env;
const production = env.NODE_ENV === 'production';
if (production && (!env.INTERNAL_TOKEN || env.INTERNAL_TOKEN.length < 24)) throw new Error('INTERNAL_TOKEN (min. 24 znaků) je v produkci povinný');

const { llm, label: llmLabel } = createLlmFromEnv(env);
const { provider: search, label: searchLabel } = searchFromEnv(env);
const app = await bootstrap({
  search, llmPricing: pricingFromEnv(env),
  dataDir: env.DATA_DIR ?? '.data/pg', databaseUrl: env.DATABASE_URL || undefined, llm, seedDemo: env.SEED_DEMO ? env.SEED_DEMO === 'true' : !production,
  admin: env.ADMIN_EMAIL && env.ADMIN_PASSWORD ? { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } : undefined,
  log: (m, e) => console.error(m, e instanceof Error ? e.message : ''),
});
const server = await buildServer(app, {
  publicOrigin: env.PUBLIC_ORIGIN ?? `http://localhost:${env.PORT ?? 3000}`, internalToken: env.INTERNAL_TOKEN,
  widgetFrameAncestors: env.WIDGET_FRAME_ANCESTORS?.split(/[\s,]+/).filter((o) => /^https?:\/\/[^\s;']+$/.test(o)), sharedRateLimit: !!env.DATABASE_URL, llmPricing: pricingFromEnv(env), secureCookies: production, trustProxy: env.TRUST_PROXY === 'true',
});
await server.listen({ port: Number(env.PORT ?? 3000), host: env.HOST ?? '0.0.0.0' });
console.log(`BELETA AI SALES běží na portu ${env.PORT ?? 3000} (AI: ${llmLabel}; vyhledávání: ${searchLabel})`);
const stop = async () => { await server.close(); await app.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
