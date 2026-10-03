import { describe, expect, test } from 'vitest';
import { DbRateLimiter } from '../src/server/ratelimit.js';
import { buildServer } from '../src/server/app.js';
import { makeApp } from './helpers.js';

describe('sdílený rate limiter (DB)', () => {
  test('dvě instance sdílejí čítač; klíče jsou oddělené; limity různých jmen se nemíchají', async () => {
    const app = await makeApp();
    const a = new DbRateLimiter(app.db, 't', 3, 3600_000), b = new DbRateLimiter(app.db, 't', 3, 3600_000), other = new DbRateLimiter(app.db, 'jiny', 3, 3600_000);
    const res = [await a.take('ip1'), await b.take('ip1'), await a.take('ip1'), await b.take('ip1'), await a.take('ip1')];
    expect(res).toEqual([true, true, true, false, false]);
    expect(await a.take('ip2')).toBe(true);
    expect(await other.take('ip1')).toBe(true);
    await app.close();
  });
  test('souběžné požadavky: povoleno přesně max', async () => {
    const app = await makeApp();
    const l = new DbRateLimiter(app.db, 'c', 5, 3600_000);
    const r = await Promise.all(Array.from({ length: 12 }, () => l.take('x')));
    expect(r.filter(Boolean).length).toBe(5);
    await app.close();
  });
  test('při výpadku DB spadne na paměťový limiter (nepropustí neomezeně)', async () => {
    const broken = { query: async () => { throw new Error('db down'); } };
    const l = new DbRateLimiter(broken as any, 'x', 2, 3600_000);
    expect([await l.take('k'), await l.take('k'), await l.take('k')]).toEqual([true, true, false]);
  });
  test('server se sharedRateLimit omezuje chat a login přes DB', async () => {
    const app = await makeApp();
    const srv = await buildServer(app, { publicOrigin: 'http://localhost:3000', secureCookies: false, trustProxy: false, sharedRateLimit: true, chatPerMinute: 2, loginMax: 2 });
    const chat = () => srv.inject({ method: 'POST', url: '/api/public/chat', payload: { message: 'Dobrý den' } });
    const codes = [(await chat()).statusCode, (await chat()).statusCode, (await chat()).statusCode];
    expect(codes[2]).toBe(429); expect(codes[0]).not.toBe(429);
    const H = { 'x-requested-with': 'beleta-admin', 'content-type': 'application/json' };
    const login = () => srv.inject({ method: 'POST', url: '/api/admin/login', headers: H, payload: { email: 'x@y.cz', password: 'spatne' } });
    expect([(await login()).statusCode, (await login()).statusCode, (await login()).statusCode]).toEqual([401, 401, 429]);
    await srv.close(); await app.close();
  });
});
