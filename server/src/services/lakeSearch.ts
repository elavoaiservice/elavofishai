// Lake search via OpenStreetMap Nominatim (free, no key). We bias toward water
// bodies and return normalized candidates the client can add.
export interface LakeCandidate {
  name: string;
  region?: string;
  country?: string;
  lat: number;
  lon: number;
  osmRef: string; // "<osm_type>/<osm_id>"
  bbox?: string; // JSON "[south,north,west,east]" as Nominatim returns
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const WATER_TYPES = new Set([
  'water', 'lake', 'reservoir', 'pond', 'bay', 'lagoon', 'wetland',
  'river', 'stream', 'canal', 'waterway', 'oxbow', 'basin',
]);

interface NominatimRow {
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  osm_type?: string;
  osm_id?: number;
  category?: string;
  class?: string;
  type?: string;
  boundingbox?: string[];
  address?: Record<string, string>;
}

function shortName(row: NominatimRow): string {
  if (row.name && row.name.trim()) return row.name.trim();
  const dn = row.display_name || '';
  return dn.split(',')[0].trim() || dn;
}

function isWater(row: NominatimRow): boolean {
  const cat = (row.category || row.class || '').toLowerCase();
  const t = (row.type || '').toLowerCase();
  if (cat === 'water' || cat === 'waterway') return true;
  if (cat === 'natural' && WATER_TYPES.has(t)) return true;
  return WATER_TYPES.has(t);
}

export async function searchLakes(q: string): Promise<LakeCandidate[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const url = new URL(NOMINATIM);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '15');
  url.searchParams.set('addressdetails', '1');

  let data: NominatimRow[] = [];
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim requires an identifying User-Agent.
        'User-Agent': 'ElavoFishAI/0.1 (https://elavoai.com; fishing planner)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    data = (await res.json()) as NominatimRow[];
  } catch {
    return [];
  }

  const water = data.filter(isWater);
  const chosen = (water.length ? water : data)
    .filter((r) => r.lat && r.lon && r.osm_type && r.osm_id)
    .slice(0, 10);

  return chosen.map((r) => ({
    name: shortName(r),
    region: [r.address?.state, r.address?.county].filter(Boolean).join(', ') || undefined,
    country: r.address?.country_code ? r.address.country_code.toUpperCase() : undefined,
    lat: Number(r.lat),
    lon: Number(r.lon),
    osmRef: `${r.osm_type}/${r.osm_id}`,
    bbox: r.boundingbox ? JSON.stringify(r.boundingbox) : undefined,
  }));
}
