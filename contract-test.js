#!/usr/bin/env node
/* Lake Granbury Fishing AI — API CONTRACT TEST
   Runs against ANY backend implementing the six routes, regardless of stack.
   Usage:   BASE_URL=http://localhost:3000 node contract-test.js
   Every PASS here means the fishing app frontend will work unmodified. */

const B = process.env.BASE_URL || 'http://localhost:8787';
const uniq = 'ct_' + Date.now().toString(36);
let jarA = '', jarB = '';
const out = [];
const ok = (n, c, x) => out.push((c ? 'PASS' : 'FAIL') + ' | ' + n + (x ? ' | ' + x : ''));
const warn = (n, c, x) => out.push((c ? 'PASS' : 'WARN') + ' | ' + n + (x ? ' | ' + x : ''));
const grabCookie = r => {
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  return sc.map(c => c.split(';')[0]).join('; ');
};
const post = (p, body, jar) => fetch(B + p, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(jar ? { cookie: jar } : {}) },
  body: JSON.stringify(body) });

(async () => {
  /* 1. /api/me — anonymous shape */
  let r = await fetch(B + '/api/me');
  let d = await r.json().catch(() => ({}));
  ok('GET /api/me responds 200 JSON', r.ok && typeof d === 'object');
  ok('me: user is null when signed out', d.user === null || d.user === undefined);
  ok('me: inviteRequired is boolean-ish', 'inviteRequired' in d, 'frontend shows the invite field off this flag');

  /* 2. register */
  r = await post('/api/register', { username: uniq, password: 'granbury-test-1' });
  d = await r.json().catch(() => ({}));
  jarA = grabCookie(r);
  ok('register: 200 + {user}', r.status === 200 && d.user === uniq);
  ok('register: sets a session cookie', jarA.length > 0);
  r = await post('/api/register', { username: uniq, password: 'granbury-test-1' });
  ok('register: duplicate rejected (409 or 400)', r.status === 409 || r.status === 400);
  r = await post('/api/register', { username: uniq + 'w', password: 'short' });
  ok('register: weak password rejected', r.status >= 400);

  /* 3. session validity */
  r = await fetch(B + '/api/me', { headers: { cookie: jarA } });
  d = await r.json();
  ok('me: reflects signed-in user via cookie', d.user === uniq);

  /* 4. login */
  r = await post('/api/login', { username: uniq, password: 'WRONG-PASSWORD' });
  ok('login: wrong password is 401', r.status === 401);
  r = await post('/api/login', { username: uniq, password: 'granbury-test-1' });
  jarA = grabCookie(r) || jarA;
  ok('login: correct password 200 + cookie', r.status === 200 && jarA.length > 0);

  /* 5. kv storage — the heart of the app */
  const KEY = encodeURIComponent('granbury:trips');
  r = await fetch(B + '/api/kv/' + KEY);
  ok('kv: 401 without session', r.status === 401);
  r = await fetch(B + '/api/kv/' + KEY, { headers: { cookie: jarA } });
  ok('kv: unset key returns 404', r.status === 404, 'frontend treats 404 as "no data yet"');
  const payload = JSON.stringify([{ id: 1, date: '2026-09-08', spot: 'US 377 bridge', count: '9' }]);
  r = await fetch(B + '/api/kv/' + KEY, { method: 'PUT', headers: { cookie: jarA }, body: payload });
  ok('kv: PUT raw text body accepted', r.status === 200, 'body is the raw value, NOT wrapped in JSON');
  r = await fetch(B + '/api/kv/' + KEY, { headers: { cookie: jarA } });
  d = await r.json();
  ok('kv: GET returns {value} exactly as stored', r.status === 200 && d.value === payload,
     'must round-trip byte-identical');
  r = await fetch(B + '/api/kv/' + encodeURIComponent('granbury:thermo'), { method: 'PUT', headers: { cookie: jarA }, body: '{"ft":22}' });
  ok('kv: colon in key name works', r.status === 200, 'all app keys look like granbury:something');

  /* 6. isolation between users */
  r = await post('/api/register', { username: uniq + 'b', password: 'granbury-test-2' });
  jarB = grabCookie(r);
  r = await fetch(B + '/api/kv/' + KEY, { headers: { cookie: jarB } });
  ok('kv: users fully isolated', r.status === 404, 'user B must never see user A data');

  /* 7. logout */
  r = await post('/api/logout', {}, jarA);
  r = await fetch(B + '/api/kv/' + KEY, { headers: { cookie: jarA } });
  ok('logout: old session rejected', r.status === 401);

  /* 8. hygiene (WARN-level: recommended, not required by the frontend) */
  r = await fetch(B + '/api/kv/' + encodeURIComponent('../../etc/passwd'), { headers: { cookie: jarB } });
  warn('hygiene: hostile key rejected', r.status === 400 || r.status === 404);
  let limited = false;
  for (let i = 0; i < 12; i++) {
    r = await post('/api/login', { username: uniq, password: 'nope' + i });
    if (r.status === 429) { limited = true; break; }
  }
  warn('hygiene: login rate limiting present', limited, 'protects the password from brute force');

  console.log(out.join('\n'));
  const fails = out.filter(l => l.startsWith('FAIL')).length;
  console.log(fails ? '\n' + fails + ' CONTRACT FAILURES — frontend will not work yet.'
                    : '\nCONTRACT SATISFIED — the fishing app frontend will work as-is.');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('Could not reach ' + B + ' — is the server running? (' + e.message + ')'); process.exit(2); });
