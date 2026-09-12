/**
 * What a push says on a lock screen.
 *
 * The rule worth testing: it is a nudge, never the content. Someone's phone
 * screen is visible to whoever is sitting next to them, and a comment about a
 * honey hole is not worth showing a stranger on a bus.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { messageFor } from '../src/services/push';

describe('push wording', () => {
  test('names the person and the kind of thing, never the thing itself', () => {
    const m = messageFor('comment', 'Dave', null);
    assert.equal(m?.body, 'Dave commented on your post');
    assert.doesNotMatch(m?.body || '', /brush pile|honey hole/);
  });

  test('a group push names the group, because that is who it is from', () => {
    assert.match(messageFor('group_post', 'Dave', 'Bass Buddies')?.body || '', /Bass Buddies/);
  });

  test('someone with no name still reads as a sentence', () => {
    assert.equal(messageFor('friend_request', null, null)?.body, 'Someone wants to join your crew');
  });

  test('each kind lands somewhere useful when tapped', () => {
    assert.equal(messageFor('friend_request', 'Dave', null)?.url, '/app#friends');
    assert.equal(messageFor('comment', 'Dave', null)?.url, '/app#feed');
  });

  test('the quiet kinds send nothing at all — a buzz has to be worth it', () => {
    // A role change or a like on someone else's post is not worth a phone
    // lighting up in a pocket.
    assert.equal(messageFor('group_role', 'Dave', 'Crew'), null);
    assert.equal(messageFor('tournament_rsvp', 'Dave', null), null);
    assert.equal(messageFor('made_up_type', 'Dave', null), null);
  });

  test('same-kind pushes collapse rather than stacking six buzzes', () => {
    assert.equal(messageFor('comment', 'Dave', null)?.tag, 'comment');
    assert.equal(messageFor('like', 'Dave', null)?.tag, 'like');
  });
});
