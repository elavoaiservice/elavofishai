/**
 * Object storage for photos, on any S3-compatible service (Cloudflare R2 by
 * default — same account as the tunnel, and no egress fees, which matters when
 * phones are the ones loading the pictures).
 *
 * Signed by hand with SigV4 rather than pulling in an SDK: it is one signing
 * function and three verbs, and the AWS SDK is a large dependency for that.
 *
 * Photos are stored PRIVATE. They are served through the app so the catch's
 * visibility can be enforced on every request — a presigned URL, once created,
 * cannot be un-shared, which is exactly wrong for "friends only".
 */
import crypto from 'crypto';

export interface StorageConfig {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string; // R2 ignores it but SigV4 requires one
}

export function storageConfig(): StorageConfig | null {
  const account = process.env.R2_ACCOUNT_ID || '';
  const endpoint = process.env.S3_ENDPOINT || (account ? `https://${account}.r2.cloudflarestorage.com` : '');
  const bucket = process.env.R2_BUCKET || process.env.S3_BUCKET || '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY || '';
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.S3_REGION || 'auto' };
}

export const storageConfigured = (): boolean => storageConfig() !== null;

const sha256hex = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * AWS Signature V4 for a single request. Exported for tests — the canonical
 * request is the part everyone gets subtly wrong, and a wrong signature fails
 * with a 403 that says nothing useful.
 */
export function signRequest(opts: {
  cfg: StorageConfig;
  method: 'PUT' | 'GET' | 'DELETE' | 'HEAD';
  key: string;
  payloadHash: string;
  contentType?: string;
  /** Already-encoded and sorted, e.g. "list-type=2&max-keys=100". */
  query?: string;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  const { cfg, method, key, payloadHash, contentType, query } = opts;
  const now = opts.now || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260909T221500Z
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(cfg.endpoint).host;
  // Each path segment is encoded, but the slashes between them are not.
  const canonicalUri = `/${cfg.bucket}/${key}`.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/');

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  // The canonical query string is part of what is signed; listing a bucket is
  // the first call here that has one, and a signature over the wrong string
  // fails with a 403 that explains nothing.
  const canonicalRequest = [method, canonicalUri, query || '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url: `${cfg.endpoint}${canonicalUri}${query ? `?${query}` : ''}`, headers };
}

/** Store an object. Returns the key it was stored under. */
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const cfg = storageConfig();
  if (!cfg) throw new Error('object storage is not configured');
  const { url, headers } = signRequest({ cfg, method: 'PUT', key, payloadHash: sha256hex(body), contentType });
  const res = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`storage PUT ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

export interface StoredObject { key: string; size: number; modified: string }

/**
 * What is actually in the bucket.
 *
 * Photos are the one thing that grows without bound and costs money, and until
 * now nothing could see them: the database knows which objects it MEANT to
 * create, and the bucket knows what is really there. The gap between those two
 * lists is what a cascade left behind.
 */
export async function listObjects(prefix = '', max = 1000, token?: string): Promise<{ objects: StoredObject[]; next?: string } | null> {
  const cfg = storageConfig();
  if (!cfg) return null;
  const params: Record<string, string> = { 'list-type': '2', 'max-keys': String(Math.min(max, 1000)) };
  if (prefix) params.prefix = prefix;
  if (token) params['continuation-token'] = token;
  const query = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const { url, headers } = signRequest({ cfg, method: 'GET', key: '', query, payloadHash: 'UNSIGNED-PAYLOAD' });
  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const xml = await res.text();
  const objects: StoredObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const get = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[1])?.[1] || '';
    const key = get('Key');
    if (key) objects.push({ key, size: Number(get('Size')) || 0, modified: get('LastModified') });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, next: truncated ? next : undefined };
}

/** Fetch an object's bytes. */
export async function getObject(key: string): Promise<{ body: Buffer; contentType: string } | null> {
  const cfg = storageConfig();
  if (!cfg) return null;
  const { url, headers } = signRequest({ cfg, method: 'GET', key, payloadHash: 'UNSIGNED-PAYLOAD' });
  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  return {
    body: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

export async function deleteObject(key: string): Promise<void> {
  const cfg = storageConfig();
  if (!cfg) return;
  const { url, headers } = signRequest({ cfg, method: 'DELETE', key, payloadHash: sha256hex('') });
  await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(20_000) }).catch(() => {});
}

/** Does the configured bucket actually accept our credentials? */
export async function testStorage(): Promise<{ ok: boolean; message: string }> {
  const cfg = storageConfig();
  if (!cfg) return { ok: false, message: 'Not configured — needs account id, bucket and keys.' };
  const key = `healthcheck/${Date.now()}.txt`;
  try {
    const body = Buffer.from('elavofishai storage check');
    await putObject(key, body, 'text/plain');
    const back = await getObject(key);
    await deleteObject(key);
    if (!back || back.body.toString() !== body.toString()) {
      return { ok: false, message: 'Wrote an object but could not read it back.' };
    }
    return { ok: true, message: `Storage works — wrote, read and deleted from "${cfg.bucket}".` };
  } catch (e) {
    return { ok: false, message: (e as Error).message.slice(0, 160) };
  }
}
