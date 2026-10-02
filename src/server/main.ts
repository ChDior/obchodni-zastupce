import { OpenAIProvider } from '../ai-core/index.js';
import { bootstrap } from '../beleta/bootstrap.js';
import { buildServer } from './app.js';

const env = process.env;
const production = env.NODE_ENV === 'production';
if (production && (!env.INTERNAL_TOKEN || env.INTERNAL_TOKEN.length < 24)) throw new Error('INTERNAL_TOKEN (min. 24 znaků) je v produkci povinný');

const llm = env.OPENAI_API_KEY ? new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? 'gpt-4.1', baseUrl: env.OPENAI_BASE_URL }) : undefined;
const app = await bootstrap({
  dataDir: env.DATA_DIR ?? '.data/pg', llm, seedDemo: env.SEED_DEMO ? env.SEED_DEMO === 'true' : !production,
  admin: env.ADMIN_EMAIL && env.ADMIN_PASSWORD ? { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } : undefined,
  log: (m, e) => console.error(m, e instanceof Error ? e.message : ''),
});
const server = await buildServer(app, {
  publicOrigin: env.PUBLIC_ORIGIN ?? `http://localhost:${env.PORT ?? 3000}`, internalToken: env.INTERNAL_TOKEN,
  secureCookies: production, trustProxy: env.TRUST_PROXY === 'true',
});
await server.listen({ port: Number(env.PORT ?? 3000), host: env.HOST ?? '0.0.0.0' });
console.log(`BELETA AI SALES běží na portu ${env.PORT ?? 3000} (AI: ${llm ? 'zapnuto' : 'vypnuto – chybí OPENAI_API_KEY'})`);
const stop = async () => { await server.close(); await app.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
