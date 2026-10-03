export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchProvider { name: string; search(query: string, count: number): Promise<SearchResult[]> }

/** Brave Search API (klíč v hlavičce X-Subscription-Token). */
export class BraveSearch implements SearchProvider {
  name = 'brave';
  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch) {}
  async search(query: string, count: number): Promise<SearchResult[]> {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', query); u.searchParams.set('count', String(Math.min(count, 20))); u.searchParams.set('country', 'CZ'); u.searchParams.set('search_lang', 'cs');
    const res = await this.fetchImpl(u, { headers: { accept: 'application/json', 'x-subscription-token': this.apiKey }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
    const j: any = await res.json();
    return (j.web?.results ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.description ?? '') })).filter((r: SearchResult) => r.url);
  }
}

/** Vlastní instance SearXNG (zdarma, bez klíče; musí mít povolený formát JSON). */
export class SearxngSearch implements SearchProvider {
  name = 'searxng';
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch) {}
  async search(query: string, count: number): Promise<SearchResult[]> {
    const u = new URL('/search', this.baseUrl);
    u.searchParams.set('q', query); u.searchParams.set('format', 'json'); u.searchParams.set('language', 'cs');
    const res = await this.fetchImpl(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
    const j: any = await res.json();
    return (j.results ?? []).slice(0, count).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.content ?? '') })).filter((r: SearchResult) => r.url);
  }
}

export function searchFromEnv(env: Record<string, string | undefined>): { provider?: SearchProvider; label: string } {
  const choice = (env.SEARCH_PROVIDER ?? '').toLowerCase();
  if (choice === 'none') return { label: 'vypnuto' };
  if ((choice === 'brave' || !choice) && env.BRAVE_SEARCH_API_KEY) return { provider: new BraveSearch(env.BRAVE_SEARCH_API_KEY), label: 'Brave Search' };
  if ((choice === 'searxng' || !choice) && env.SEARXNG_URL) return { provider: new SearxngSearch(env.SEARXNG_URL), label: `SearXNG (${env.SEARXNG_URL})` };
  if (choice === 'brave') throw new Error('SEARCH_PROVIDER=brave vyžaduje BRAVE_SEARCH_API_KEY');
  if (choice === 'searxng') throw new Error('SEARCH_PROVIDER=searxng vyžaduje SEARXNG_URL');
  return { label: 'nenastaveno (BRAVE_SEARCH_API_KEY nebo SEARXNG_URL)' };
}
