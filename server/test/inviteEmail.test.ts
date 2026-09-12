/**
 * An invitation email goes out from our domain, with our name on it. Anything
 * a user typed into it is text — unescaped markup would be a phishing kit with
 * our reputation behind it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inviteEmail } from '../src/services/email';

describe('invite email', () => {
  test('a note with markup in it arrives as the characters the sender typed', () => {
    const { html } = inviteEmail('Dave', 'https://example.com/signup?invite=abc', '<a href="https://evil.example">Claim your prize</a>');
    assert.doesNotMatch(html, /<a href="https:\/\/evil\.example"/);
    assert.match(html, /&lt;a href=&quot;https:\/\/evil\.example&quot;/);
  });

  test('a name cannot close a tag either', () => {
    const { html, subject } = inviteEmail('Dave</p><script>alert(1)</script>', 'https://example.com/x', null);
    assert.doesNotMatch(html, /<script>/);
    assert.match(subject, /invited you to ElavoFishAI$/);
  });

  test('an ordinary note still reads like a note', () => {
    const { html } = inviteEmail('Dave', 'https://example.com/x', 'Come fish Granbury with us Saturday');
    assert.match(html, /Come fish Granbury with us Saturday/);
  });
});
