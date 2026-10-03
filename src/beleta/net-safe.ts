import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

/** Soukromé, loopback, link-local, CGNAT, multicast a další nepoužitelné adresy (ochrana proti SSRF). */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); if (m) return isPrivateIp(m[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true; // neznámý formát = nepovolit
}

export type LookupFn = (host: string) => Promise<string[]>;
const defaultLookup: LookupFn = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

export class FetchError extends Error { constructor(public code: string, msg: string) { super(msg); } }
export interface SafeFetchOptions { userAgent: string; timeoutMs?: number; maxBytes?: number; maxRedirects?: number; lookup?: LookupFn; allowedPorts?: number[]; /** JEN PRO TESTY (lokální server). Nikdy nenastavovat z konfigurace. */ allowPrivate?: boolean }
export interface FetchedDoc { url: string; contentType: string; body: Buffer; truncated: boolean }

function once(opts: SafeFetchOptions, url: URL): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  const lookupFn = opts.lookup ?? defaultLookup;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET', timeout: opts.timeoutMs ?? 10_000,
      headers: { 'user-agent': opts.userAgent, accept: 'text/html,application/xhtml+xml,text/plain,application/pdf;q=0.8', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'cs,en;q=0.5' },
      // DNS se překládá a ověřuje přímo při spojení => nelze obejít přes DNS rebinding
      lookup: ((host: string, o: any, cb: any) => {
        lookupFn(host).then((addrs) => {
          if (!addrs.length || (!opts.allowPrivate && addrs.some(isPrivateIp))) return cb(new FetchError('blocked_address', 'Adresa není povolena'));
          const list = addrs.map((address) => ({ address, family: isIP(address) }));
          o?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
        }).catch((e) => cb(e));
      }) as any,
    }, (res) => {
      const status = res.statusCode ?? 0;
      let stream: Readable = res;
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip()); else if (enc === 'deflate') stream = res.pipe(zlib.createInflate()); else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks: Buffer[] = []; let size = 0; let truncated = false; let done = false;
      const finish = () => { if (done) return; done = true; resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated }); };
      stream.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > maxBytes) { chunks.push(c.subarray(0, c.length - (size - maxBytes))); truncated = true; req.destroy(); finish(); } else chunks.push(c);
      });
      stream.on('end', finish);
      stream.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
    req.on('timeout', () => req.destroy(new FetchError('timeout', 'Vypršel čas')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}

/** Bezpečné stažení: jen http(s) na standardních portech, bez přihlašovacích údajů, ověřený DNS, ruční přesměrování (max N), limit velikosti a času. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<FetchedDoc> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new FetchError('bad_url', 'Neplatná URL'); }
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new FetchError('bad_scheme', 'Povoleno jen http/https');
    if (url.username || url.password) throw new FetchError('bad_url', 'URL s přihlašovacími údaji není povolena');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!opts.allowPrivate && !(opts.allowedPorts ?? [80, 443]).includes(port)) throw new FetchError('bad_port', 'Port není povolen');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!opts.allowPrivate && isIP(host) && isPrivateIp(host)) throw new FetchError('blocked_address', 'Adresa není povolena');
    if (!opts.allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) throw new FetchError('blocked_address', 'Adresa není povolena');
    const r = await once(opts, url);
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      try { url = new URL(String(r.headers.location), url); } catch { throw new FetchError('bad_url', 'Neplatné přesměrování'); }
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new FetchError('http_' + r.status, `HTTP ${r.status}`);
    return { url: url.toString(), contentType: String(r.headers['content-type'] ?? ''), body: r.body, truncated: r.truncated };
  }
  throw new FetchError('too_many_redirects', 'Příliš mnoho přesměrování');
}

/* ---------- robots.txt ---------- */
export interface RobotsRules { allows(path: string): boolean }
export function parseRobots(txt: string, agent: string): RobotsRules {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let cur: (typeof groups)[number] | null = null; let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); const i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
    if (k === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === 'allow' || k === 'disallow') && v) cur.rules.push({ allow: k === 'allow', path: v });
  }
  const a = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((x) => x !== '*' && a.includes(x))) ?? groups.find((g) => g.agents.includes('*'));
  const rules = group?.rules ?? [];
  const toRe = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return { allows(path) {
    let best: { allow: boolean; len: number } | null = null;
    for (const r of rules) if (toRe(r.path).test(path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
    return best ? best.allow : true;
  } };
}

/* ---------- HTML → text ---------- */
const ENT: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”' };
export function htmlToText(html: string): string {
  const contacts = [...html.matchAll(/href\s*=\s*["'](mailto|tel):([^"'?]+)/gi)].map((m) => `${m[1].toLowerCase()}: ${decodeURIComponent(m[2])}`);
  const t = html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|br)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return contacts.length ? `${t}\n\nKontakty na stránce:\n${[...new Set(contacts)].join('\n')}` : t;
}

export function decodeBody(body: Buffer, contentType: string): string {
  const cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? (/<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1]?.toLowerCase()) ?? 'utf-8';
  try { return new TextDecoder(cs).decode(body); } catch { return body.toString('utf8'); }
}
