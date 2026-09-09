import { prisma } from '../db';

// Seed the flagship lake — Lake Granbury — as a HAND-VERIFIED profile the AI never
// overwrites. Idempotent: safe to run on every boot. The frontend still carries
// Granbury's deep built-in content; this row marks it verified and anchors the
// multi-lake model with a real first lake.
const GRANBURY_OSM_REF = 'seed:lake-granbury';

export async function seedGranbury(): Promise<void> {
  const lake = await prisma.lake.upsert({
    where: { osmRef: GRANBURY_OSM_REF },
    update: {},
    create: {
      name: 'Lake Granbury',
      region: 'Texas',
      country: 'US',
      lat: 32.4421,
      lon: -97.7669,
      gaugeId: '08090900',
      gaugeSource: 'usgs',
      fullPool: 693.0,
      osmRef: GRANBURY_OSM_REF,
    },
  });

  const existing = await prisma.lakeProfile.findUnique({ where: { lakeId: lake.id } });
  if (!existing) {
    await prisma.lakeProfile.create({
      data: {
        lakeId: lake.id,
        source: 'hand_verified',
        verified: true,
        content: {
          summary:
            'Lake Granbury — 8,310-acre Brazos River impoundment in Hood County, TX. ' +
            'The app carries hand-verified, lake-specific guidance for Granbury.',
          species: ['Largemouth Bass', 'White Bass', 'Striped/Hybrid Bass', 'Catfish', 'Crappie', 'Sunfish'],
          // Long axis runs NW-SE — hand-verified, and what the wind/fetch
          // advice was originally written around.
          axisDeg: 135,
          regsUrl: 'https://tpwd.texas.gov/fishboat/fish/recreational/lakes/granbury/',
        },
      },
    });
  }
}
