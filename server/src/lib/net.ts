// Is this client address on the local machine or a private LAN? Used to keep
// dev/console magic links from ever leaving the network they were meant for.
// IPv4-mapped IPv6 (::ffff:192.168.1.5) is unwrapped first.
export function isPrivateIp(raw: string): boolean {
  let ip = (raw || '').trim().toLowerCase();
  if (!ip) return false;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  if (ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local IPv6
  if (ip.startsWith('fe80:')) return true; // link-local IPv6

  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((p) => Number(p));
  if (parts.some((p) => !/^\d{1,3}$/.test(p)) || [a, b].some((n) => !Number.isFinite(n))) return false;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}
