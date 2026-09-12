/**
 * Who the server thinks is calling.
 *
 * This was verified as exploitable against production: sending
 * `X-Forwarded-For: 1.2.3.4` from the open internet made the server treat the
 * request as coming from 1.2.3.4, so every per-address rate limit could be
 * defeated by changing a header.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveClientIp } from '../src/lib/auth';

describe('resolveClientIp', () => {
  test('a request straight off the internet is judged by its socket, not its headers', () => {
    assert.equal(resolveClientIp('203.0.113.9', { 'x-forwarded-for': '1.2.3.4' }), '203.0.113.9');
    assert.equal(resolveClientIp('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4' }), '203.0.113.9');
  });

  test('behind our own tunnel, Cloudflare"s header is the one we believe', () => {
    // cloudflared runs beside the app, so the peer is a private address.
    assert.equal(resolveClientIp('172.18.0.4', { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' }), '198.51.100.7');
  });

  test('with no Cloudflare header it falls back to the forwarded chain', () => {
    assert.equal(resolveClientIp('10.0.0.2', { 'x-forwarded-for': '198.51.100.7, 10.0.0.2' }), '198.51.100.7');
  });

  test('a proxy that forwards nothing leaves the peer as the answer', () => {
    assert.equal(resolveClientIp('127.0.0.1', {}), '127.0.0.1');
  });

  test('header arrays and blanks do not produce an empty identity', () => {
    assert.equal(resolveClientIp('10.0.0.2', { 'cf-connecting-ip': ['198.51.100.7'] }), '198.51.100.7');
    assert.equal(resolveClientIp('10.0.0.2', { 'cf-connecting-ip': '' }), '10.0.0.2');
  });
});
