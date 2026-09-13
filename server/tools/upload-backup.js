/**
 * Copy a database dump into object storage.
 *
 *   docker compose exec -T app node tools/upload-backup.js <name> < dump.sql.gz
 *
 * Runs inside the container because that is where the credentials and the
 * signing code live — the host has neither.
 *
 * Exit codes matter here: 0 means the dump is really in the bucket, 3 means
 * there is no bucket to put it in, and 1 means we tried and failed. Returning
 * 0 for "not configured" made the backup status claim the copy was offsite
 * when nothing had left the machine.
 */
const { putObject, storageConfigured } = require('../dist/services/storage');

const name = process.argv[2] || `backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.sql.gz`;

if (!storageConfigured()) {
  console.log('[backup] object storage not configured — keeping the local copy only');
  process.exit(3);
}
if (!/^(1|true|yes)$/i.test(process.env.BACKUP_TO_STORAGE || '1')) {
  console.log('[backup] BACKUP_TO_STORAGE is off — keeping the local copy only');
  process.exit(3);
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const body = Buffer.concat(chunks);
  if (body.length < 1024) {
    console.error(`[backup] refusing to upload ${body.length} bytes — that is not a dump`);
    process.exit(1);
  }
  const key = `backups/${name}`;
  try {
    await putObject(key, body, 'application/gzip');
    console.log(`[backup] uploaded ${(body.length / 1024).toFixed(0)} KB to ${key}`);
    process.exit(0);
  } catch (e) {
    console.error('[backup] upload failed:', e.message);
    process.exit(1);
  }
});
