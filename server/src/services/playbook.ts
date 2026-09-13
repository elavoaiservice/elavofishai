/**
 * Species playbooks — what a good angler knows about one fish, by season.
 *
 * The planner already gets this lake's own log, live conditions, agency
 * reports and the AI lake guide. What it did not have was the ordinary craft
 * knowledge of a species: that 50°F is what starts crappie moving, that they
 * hold in deep water without being deep, that a jig dipped back toward a
 * following fish ends the follow. A model will produce a plausible version of
 * that from general knowledge; it will also drift, and it has no way to say
 * which of two plausible answers is the one anglers actually use.
 *
 * So this is written down instead of inferred. The crappie playbook is
 * distilled from two years of Crappie Moment (@crappiemoment) — 173 videos,
 * one a week through every month of the year, on North Carolina piedmont
 * reservoirs. Where his water differs from ours the phases still hold, because
 * they are keyed to water temperature rather than the calendar, which is his
 * own first rule.
 *
 * Phases are chosen by water temperature when we have it and by month when we
 * do not, because temperature is what the fish actually respond to — the same
 * week of November was 80°F one year and low 60s the next.
 */

export interface Phase {
  /** What to call this period in the plan. */
  name: string;
  /** Water temperatures (°F) this phase covers, low inclusive, high exclusive. */
  tempF: [number, number];
  /** Months it usually falls in at mid-South latitudes — the fallback when no temperature is known. */
  months: number[];
  /** Whether the water is warming or cooling through this phase; some temperatures mean different things in each direction. */
  trend?: 'warming' | 'cooling';
  where: string;
  depth: string;
  presentation: string;
  bait: string;
  /** The single thing most likely to change the day. */
  key: string;
}

export interface Playbook {
  species: string;
  /** True whatever the season — the things everything else is downstream of. */
  laws: string[];
  phases: Phase[];
  /** Mistakes that cost fish in any month. */
  mistakes: string[];
  source: string;
}

const CRAPPIE: Playbook = {
  species: 'crappie',
  laws: [
    'Water temperature decides where they are. Not the date — the same week of the year runs 20°F apart between years, and the fish follow the water, not the calendar.',
    'Bait fish decide the rest. Find the shad and you have found the crappie; they follow the bait shallow and back out again. A side-imaging pass that finds bait balls is worth more than any colour choice.',
    'Crappie need food and safety. Cover is the safety half — brush, timber, stumps, laydowns, bridge pilings, weed edges — and it is where they ambush from.',
    'Deeper water does not mean deep. Fish sitting over 30–40 ft are routinely 5–15 ft below the surface. Search the whole column, not the bottom.',
    'Presentation outranks colour and profile every time. A perfect colour fished badly loses to the wrong colour fished well.',
  ],
  phases: [
    {
      name: 'Winter — deep and slow',
      tempF: [32, 50],
      months: [1, 2, 12],
      where:
        'Water clarity decides the pattern. Clear water: suspended near bridges, over brush piles and deep grass. Stained: 15–20 ft break lines and contours adjacent to deeper water. Heavily stained: out over the deepest water in the lake, suspended. Ledges and drop-offs off the points where creek arms cut back are the reliable start. At bridges, fish away from the bridge too — the channel, contours and cover on both sides of it.',
      depth: '20–35 ft of water, but the fish are usually 5–15 ft down, not on the bottom.',
      presentation:
        'Slow down hard. Steady, finesse, often no retrieve at all. For fish that spook off the splash, dip rather than cast — a 14–16 ft rod, creep up, put it on their nose and hold it still until they take it.',
      bait: 'Smaller profiles. 1/8–1/4 oz heads to get down quickly. Scent (crappie nibbles, bait dip) earns its keep when they are lethargic.',
      key: 'There is no such thing as too cold. Big females are already carrying eggs by January, and the stretch from late January through April is the best big-fish window of the year.',
    },
    {
      name: 'Pre-spawn — the move shallow',
      tempF: [50, 57],
      trend: 'warming',
      months: [2, 3],
      where:
        'They move in stages, stopping at each: river-channel swings and bends, points adjacent to those swings, the mouths of creeks, then mid-way back into the creeks, then the flats. Brush on a channel bend is the prime piece of water — deep escape on one side, feeding flat on the other.',
      depth: 'Every depth at once. Fish still in 25–35 ft, fish at 15–25, fish at 10–15, and the first fish up in 6 ft or less.',
      presentation: 'Quicker retrieves start working. They are feeding up and will chase.',
      bait: 'Almost anything: paddle tails, curly tails, hair jigs, under-spins, small crankbaits. Size and colour matter less now than at any other time except the spawn itself.',
      key: '50°F is the trigger. When the water touches it, the move has started — do not wait for the dogwoods, that is weeks late and the biggest females are the first to go.',
    },
    {
      name: 'Spawn',
      tempF: [57, 66],
      trend: 'warming',
      months: [3, 4],
      where:
        'Shallow flats, and inside them the little cuts and pockets along the bank that hold hard cover — stumps, brush, laydowns, standing timber, dock posts, riprap, bulrush and lily pads. Protected from wind and current: a bed on a hammered bank does not survive. The north end of the lake warms first, so it spawns first.',
      depth: '1–5 ft for bedding fish; 5–10 ft for the ones staging behind them.',
      presentation:
        'Work out-to-in: start in the creeks around 15 ft and push toward the flats. Males arrive first and darken almost black; they guard, so they hit anything that comes near. Watch for moving marks, not just stationary ones — a guarding male patrols.',
      bait: 'Whatever is tied on. This is the one time of year bait choice barely matters.',
      key:
        'Stable temperature matters more than warm. A cold snap backs them off exactly one depth band — 4 ft becomes 4–8 ft, not 25 ft — and they return when it steadies. Females drop eggs in the mid-60s, in more than one visit, then leave; males stay with the eggs and then the fry for a few days.',
    },
    {
      name: 'Post-spawn — the funk, then the recovery',
      tempF: [66, 76],
      trend: 'warming',
      months: [4, 5],
      where:
        'The pre-spawn route in reverse: back to the staging water they came through, then to the first cover off the flats. Cover on the first drop — where 5 ft rolls into 10 — holds them while they recover.',
      depth: '5–10 ft first, then settling into 8–15 ft with cover.',
      presentation:
        'Work in-to-out now, the opposite of the spawn. Finesse early: for a week or two they are spent and will not chase. By late in the phase the bite turns back on and a livelier retrieve pays.',
      bait: 'Small early — 1.5–2 in shad profiles. Upsize and add action (paddle and curly tails) as they come back on.',
      key: 'They are not gone, they are tired. Most anglers hang the rods up here, which is why the water is empty right as the fish start feeding again.',
    },
    {
      name: 'Summer — cover, shade and oxygen',
      tempF: [76, 95],
      months: [6, 7, 8],
      where:
        'Cover sitting on structure is the combination worth hunting: brush, stumps, timber or weed edges on a contour, ledge, drop-off or main-lake point. Fish the shade side of it. Main-lake points where shallow ground runs out into deep water are reliable all summer, as are bank drop-offs beside points — they hold on the drop and run up to ambush bait.',
      depth:
        '10–20 ft covers most water, 15–25 on deeper lakes. Fish are caught in 7–12 ft in 85–90°F water all summer, so do not write shallow off. Where a thermocline has set up, everything is at or above it — below it there is no oxygen and nothing but catfish.',
      presentation:
        'Slow. Let the jig reach the strike zone before retrieving, then a slow steady crawl so it stays there — reeling lifts it out of the zone. Keep the jig horizontal and the bait steady; boat wakes rocking the rod tip ruin more summer bites than colour ever will. Never dip the jig back toward a following fish, that ends the follow.',
      bait: 'Downsize. Clip the head off a bigger plastic if that is all you have. Change often — once a school has looked at something and refused it, they rarely look again.',
      key:
        'Make your best cast the first time; every extra pass teaches the school to ignore it. Fishing a school, take the top of it and your own side first — pulling a fish up through the middle scatters the rest.',
    },
    {
      name: 'Fall transition — following the bait shallow',
      tempF: [70, 80],
      trend: 'cooling',
      months: [9, 10],
      where:
        'Start at the creek mouths — main-lake points, break lines, weed edges — and work back into the creeks as the month goes on. The bait moves into the creeks and onto the shallow flats beside the channels, and the crappie go with it.',
      depth: '10–15 ft and getting shallower; fish sitting 2–4 ft under the surface over much deeper water.',
      presentation: 'Aggressive again. Casting and retrieving works now in a way it does not in summer — spinners, beetle spins, rooster tails, small crankbaits all come back into play.',
      bait: 'Upsize. The spring shad hatch has grown, so the forage is bigger — start around 2.5–3 in and work down.',
      key: 'Below 80°F the transition starts; 70–75°F is when it is properly on. They are not spawning in the fall, whatever the shallow water suggests — they are chasing bait.',
    },
    {
      name: 'Late fall — the best bite of the year',
      tempF: [55, 70],
      trend: 'cooling',
      months: [10, 11],
      where:
        'Up in the creek arms, on and around brush, stumps, timber, submerged bridges and roadbeds, and anywhere shallow ground sits next to a drop-off. Scan a bank or two and look for the bait balls; the crappie will be in them or on their edges.',
      depth: '8–15 ft, often less. Fish in 5–8 ft of water sitting 2–3 ft down — close enough to reach from the bank.',
      presentation: 'They will chase a bait 5–10 ft and hit it hard. Almost anything works, so spend the time finding them rather than choosing a lure.',
      bait: 'Bigger profiles still — 2.5–3 in bodies, curly tails, under-spins, crankbaits, live minnows.',
      key: '55–68°F is the window, and it closes. This is the easiest time of the whole year to catch a lot of crappie and some of the biggest.',
    },
    {
      name: 'Winter transition — back out to deep',
      tempF: [45, 55],
      trend: 'cooling',
      months: [11, 12],
      where:
        'They leave the creeks in stages: creek mouths, then deep ledges, bluff walls and drop-offs near banks, then the main lake. Look for cover sitting on a contour line, and for points and shallow flats immediately beside the deepest water — they still run up to ambush and drop straight back.',
      depth: '25–40 ft of water, holding 5–20 ft down.',
      presentation: 'Slow and steady, and be willing to simply hold it still. Patience beats action from here until spring.',
      bait: 'Heavier head (1/8–1/4 oz) to reach them quickly, smaller body for fish that will not chase.',
      key: 'Consistently below 55°F is what starts it, and it is gradual — for a couple of weeks you can find fish shallow, mid-creek and out deep on the same day.',
    },
  ],
  mistakes: [
    'Sitting on a spot that is not producing. If a few casts and an adjustment do not raise anything, move — the time is worth more than the spot.',
    'Fishing a spot rather than a pattern. Ask why that fish was there — depth, cover type, position on a contour, clarity — and repeat those conditions elsewhere on the lake.',
    'Changing nothing when it stops working. Colour, size, profile, depth, speed: change one and find out.',
    'Fishing where they were last year on this date. Temperature moves the whole calendar by weeks in either direction.',
    'Scanning brush and never panning off it. The better fish often sit alone or in pairs just off the edge of a school.',
  ],
  source: 'Crappie Moment (youtube.com/@crappiemoment) — two years of weekly videos, distilled by month',
};

const PLAYBOOKS: Playbook[] = [CRAPPIE];

/** Case- and plural-insensitive: "Black Crappie", "crappie", "White crappie". */
export function playbookFor(species: string): Playbook | null {
  const want = String(species || '').toLowerCase();
  if (!want) return null;
  return PLAYBOOKS.find((p) => want.includes(p.species)) || null;
}

/**
 * Which phase the water is in.
 *
 * Temperature wins when we have it, because it is what the fish answer to.
 * Several phases overlap in temperature — 68°F is late fall going down and
 * post-spawn going up — so the month breaks the tie, and the trend field
 * settles the rest.
 */
export function phaseFor(book: Playbook, month: number, waterTempF: number | null): Phase | null {
  const inMonth = (p: Phase) => p.months.includes(month);
  if (waterTempF != null && Number.isFinite(waterTempF)) {
    const byTemp = book.phases.filter((p) => waterTempF >= p.tempF[0] && waterTempF < p.tempF[1]);
    if (byTemp.length === 1) return byTemp[0];
    if (byTemp.length > 1) return byTemp.find(inMonth) || byTemp[0];
  }
  return book.phases.find(inMonth) || null;
}

/**
 * The block handed to the planner. Empty string for a species we have not
 * written up, so the prompt simply carries on without it.
 */
export function playbookForPrompt(species: string, month: number, waterTempF: number | null): string {
  const book = playbookFor(species);
  if (!book) return '';
  const phase = phaseFor(book, month, waterTempF);
  const lines = [
    `ANGLER PLAYBOOK — ${book.species.toUpperCase()} (craft knowledge, not conditions; ${book.source}):`,
    ...book.laws.map((l) => `- ${l}`),
  ];
  if (phase) {
    lines.push(
      '',
      `The water is in: ${phase.name}${waterTempF != null ? ` (reading ${Math.round(waterTempF)}°F)` : ' (by the calendar — no water temperature available)'}.`,
      `Where: ${phase.where}`,
      `Depth: ${phase.depth}`,
      `Presentation: ${phase.presentation}`,
      `Bait: ${phase.bait}`,
      `The thing that matters most right now: ${phase.key}`
    );
  }
  lines.push(
    '',
    'Common mistakes to steer the angler away from:',
    ...book.mistakes.map((m) => `- ${m}`),
    '',
    'Use this for the HOW — depth, cover, presentation, bait size and the reasoning. It is general craft for the species, so where this lake’s own log or a recent report contradicts it, follow the lake and say so.'
  );
  return lines.join('\n');
}
