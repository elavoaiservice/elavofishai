import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateIp } from '../src/lib/net';

// This decides whether a dev/console sign-in link is handed back to a caller,
// so a false positive here is an account-takeover bug.
test('loopback and LAN addresses are private', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.254', '::1', '::ffff:192.168.1.5', 'fd00::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test('public addresses are not private', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '193.168.1.1', '2606:4700::1111', '', 'not-an-ip']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('a hostile string cannot masquerade as a LAN address', () => {
  for (const ip of ['192.168.1.1.evil.com', '10.0.0.1x', 'a.b.c.d']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});
