#!/usr/bin/env node
/* Lake Granbury Fishing AI — backend
   Zero dependencies: node server.js  (Node 18+)
   - Serves the app's static files from this folder
   - User accounts: scrypt-hashed passwords, HttpOnly session cookies
   - Per-user key-value storage the app syncs against
   - Optional invite code: INVITE_CODE=something node server.js
   Data lives in ./data — back that folder up and you've backed up everything. */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const INVITE = process.env.INVITE_CODE || null;
const SESSION_DAYS = 90;

fs.mkdirSync(DATA, { recursive: true });

/* ---------- tiny JSON file store with atomic writes ---------- */
function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); }
  catch (e) { return fallback; }
}
function writeJson(f, obj) {
  const p = path.join(DATA, f), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}
let users = readJson('users.json', {});
let sessions = readJson('sessions.json', {});

/* ---------- auth primitives ---------- */
function hashPassword(pw) {
  return new Promise((res, rej) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(pw, salt, 64, (e, dk) => e ? rej(e) : res(salt + ':' + dk.toString('hex')));
  });
}
function verifyPassword(pw, stored) {
  return new Promise((res) => {
    const [salt, hex] = String(stored).split(':');
    crypto.scrypt(pw, salt, 64, (e, dk) => {
      if (e) return res(false);
      try { res(crypto.timingSafeEqual(Buffer.from(hex, 'hex'), dk)); }
      catch (x) { res(false); }
    });
  });
}
function newSession(user) {
  const tok = crypto.randomBytes(32).toString('hex');
  sessions[tok] = { u: user, exp: Date.now() + SESSION_DAYS * 86400000 };
  writeJson('sessions.json', sessions);
  return tok;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)gsession=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = sessions[m[1]];
  if (!s) return null;
  if (s.exp < Date.now()) { delete sessions[m[1]]; writeJson('sessions.json', sessions); return null; }
  return s.u;
}
function killSession(req) {
  const m = /(?:^|;\s*)gsession=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m && sessions[m[1]]) { delete sessions[m[1]]; writeJson('sessions.json', sessions); }
}
function cookieFor(req, tok) {
  const secure = req.socket.encrypted || /https/i.test(req.headers['x-forwarded-proto'] || '');
  return 'gsession=' + tok + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
         (SESSION_DAYS * 86400) + (secure ? '; Secure' : '');
}

/* ---------- login rate limiting (per IP) ---------- */
const fails = {};
function tooMany(ip) {
  const f = fails[ip];
  return f && f.n >= 10 && Date.now() - f.t < 600000;
}
function noteFail(ip) {
  const f = fails[ip] || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  f.n++; fails[ip] = f;
}

/* ---------- per-user kv ---------- */
function kvFile(user) { return 'kv_' + user + '.json'; }
const VALID_USER = /^[a-zA-Z0-9_.-]{3,24}$/;
const VALID_KEY = /^[\w:.-]{1,80}$/;

/* ---------- helpers ---------- */
function send(res, code, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(code, h);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((res, rej) => {
    let b = ''; let n = 0;
    req.on('data', c => { n += c.length; if (n > (limit || 1048576)) { rej(new Error('too big')); req.destroy(); } b += c; });
    req.on('end', () => res(b));
    req.on('error', rej);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.gpx': 'application/gpx+xml' };

/* ---------- server ---------- */
http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');
  try {
    /* ----- API ----- */
    if (url.pathname === '/api/me') {
      const u = sessionUser(req);
      return send(res, 200, { user: u, inviteRequired: !!INVITE });
    }
    if (url.pathname === '/api/register' && req.method === 'POST') {
      if (tooMany(ip)) return send(res, 429, { error: 'Too many attempts. Wait ten minutes.' });
      const b = JSON.parse(await readBody(req, 4096) || '{}');
      const u = String(b.username || '').trim();
      if (!VALID_USER.test(u)) return send(res, 400, { error: 'Username: 3-24 letters, numbers, . _ -' });
      if (String(b.password || '').length < 8) return send(res, 400, { error: 'Password needs at least 8 characters.' });
      if (INVITE && b.invite !== INVITE) { noteFail(ip); return send(res, 403, { error: 'Invite code required or wrong.' }); }
      if (users[u]) return send(res, 409, { error: 'That username is taken.' });
      users[u] = { hash: await hashPassword(b.password), created: new Date().toISOString() };
      writeJson('users.json', users);
      const tok = newSession(u);
      return send(res, 200, { user: u }, { 'Set-Cookie': cookieFor(req, tok) });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (tooMany(ip)) return send(res, 429, { error: 'Too many attempts. Wait ten minutes.' });
      const b = JSON.parse(await readBody(req, 4096) || '{}');
      const u = String(b.username || '').trim();
      const rec = users[u];
      if (!rec || !(await verifyPassword(String(b.password || ''), rec.hash))) {
        noteFail(ip);
        return send(res, 401, { error: 'Wrong username or password.' });
      }
      delete fails[ip];
      const tok = newSession(u);
      return send(res, 200, { user: u }, { 'Set-Cookie': cookieFor(req, tok) });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      killSession(req);
      return send(res, 200, { user: null }, { 'Set-Cookie': 'gsession=; Path=/; HttpOnly; Max-Age=0' });
    }
    if (url.pathname.startsWith('/api/kv/')) {
      const u = sessionUser(req);
      if (!u) return send(res, 401, { error: 'Sign in first.' });
      const key = decodeURIComponent(url.pathname.slice(8));
      if (!VALID_KEY.test(key)) return send(res, 400, { error: 'Bad key.' });
      const kv = readJson(kvFile(u), {});
      if (req.method === 'GET') {
        if (!(key in kv)) return send(res, 404, { error: 'empty' });
        return send(res, 200, { value: kv[key] });
      }
      if (req.method === 'PUT') {
        kv[key] = await readBody(req, 2097152); // 2 MB per key is plenty
        writeJson(kvFile(u), kv);
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'GET or PUT.' });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'No such endpoint.' });

    /* ----- static files ----- */
    let p = url.pathname === '/' ? '/lake-granbury-planner.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || file.startsWith(DATA)) return send(res, 404, { error: 'not found' });
    fs.readFile(file, (e, buf) => {
      if (e) return send(res, 404, { error: 'not found' });
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(buf);
    });
  } catch (e) {
    send(res, 500, { error: 'Server hiccup.' });
  }
}).listen(PORT, () => {
  console.log('Lake Granbury Fishing AI on http://localhost:' + PORT +
    (INVITE ? '  (invite code required to register)' : '  (open registration)'));
});
