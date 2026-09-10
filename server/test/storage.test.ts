/**
 * SigV4. A wrong signature fails with a 403 that explains nothing, so this is
 * checked against a reference implementation written independently from the AWS
 * spec — which was itself first verified against AWS's own published example
 * (GET examplebucket/test.txt, signature f0e8bdb8…).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';
import { signRequest, type StorageConfig } from '../src/services/storage';

const cfg: StorageConfig = {
  endpoint: 'https://acct123.r2.cloudflarestorage.com',
  bucket: 'photos',
  accessKeyId: 'testaccesskey',
  secretAccessKey: 'testsecretkey',
  region: 'auto',
};
const at = new Date(Date.UTC(2026, 8, 9, 22, 15, 0));
const payloadHash = crypto.createHash('sha256').update('hello photo bytes').digest('hex');

describe('signRequest', () => {
  test('matches an independent implementation of SigV4', () => {
    const { headers } = signRequest({
      cfg, method: 'PUT', key: 'abc/def.jpg', payloadHash, contentType: 'image/jpeg', now: at,
    });
    // Produced by the reference signer for exactly this request.
    assert.match(headers.authorization, /Signature=1b5e64995856852db2580d78d6f49dc0be4e820c1113c927b7b9c68c2699c452$/);
  });

  test('signs the headers it actually sends, in order', () => {
    const { headers } = signRequest({ cfg, method: 'PUT', key: 'a.jpg', payloadHash, contentType: 'image/jpeg', now: at });
    assert.match(headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
    assert.equal(headers['x-amz-date'], '20260909T221500Z');
  });

  test('a GET has no content-type to sign', () => {
    const { headers } = signRequest({ cfg, method: 'GET', key: 'a.jpg', payloadHash: 'UNSIGNED-PAYLOAD', now: at });
    assert.match(headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  });

  test('the URL carries the bucket, and path separators survive encoding', () => {
    const { url } = signRequest({ cfg, method: 'GET', key: 'catch/2026/abc.jpg', payloadHash: 'x', now: at });
    assert.equal(url, 'https://acct123.r2.cloudflarestorage.com/photos/catch/2026/abc.jpg');
  });

  test('a different key produces a different signature', () => {
    const a = signRequest({ cfg, method: 'PUT', key: 'one.jpg', payloadHash, contentType: 'image/jpeg', now: at });
    const b = signRequest({ cfg, method: 'PUT', key: 'two.jpg', payloadHash, contentType: 'image/jpeg', now: at });
    assert.notEqual(a.headers.authorization, b.headers.authorization);
  });
});
