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
  /** How the app's species names map onto this book, lower-case substrings. */
  match: string[];
  /** True whatever the season — the things everything else is downstream of. */
  laws: string[];
  phases: Phase[];
  /** Mistakes that cost fish in any month. */
  mistakes: string[];
  source: string;
}

const CRAPPIE: Playbook = {
  species: 'crappie',
  match: ['crappie'],
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

/**
 * Largemouth bass, distilled from Tactical Bassin (@TacticalBassin) — 152
 * videos read in full out of a catalogue of 1,907, chosen for the ones that
 * teach a month or a pattern rather than review a rod. Matt Allen and Tim
 * Little fish new water constantly, which is why their advice is framed as
 * patterns to repeat rather than spots to return to.
 */
const BASS: Playbook = {
  species: 'largemouth bass',
  match: ['largemouth'],
  laws: [
    'Fish a pattern, not a spot. A spot is a brush pile you caught one on four years ago. A pattern is the conditions that put it there — depth, cover type, position on a contour, which bank the wind is on — and it repeats all over the lake. When you catch one, ask why it was there.',
    'Water temperature moves the whole calendar. The fish start shifting toward spring weeks before the air does, and they do it whether or not it still feels like winter.',
    'Find the bait. Bass position on shad, bluegill and whatever else the lake holds, and the whole year reads as "where is the forage and how do I stand out in it".',
    'Cover water to find them, then slow down to catch them. Fast baits are search tools; once a school is located you can often take fish cast after cast from one spot.',
    'The first cast is the good one. Every extra pass teaches a fish what your bait is, and educated fish quit looking.',
  ],
  phases: [
    {
      name: 'Winter — the big-fish grind',
      tempF: [32, 48],
      months: [12, 1, 2],
      where:
        'Main-lake points, long tapering points, rock — chunk rock and rock-to-mud transitions especially. Bluff walls and the channel swings that run into them. Creek-channel intersections and the deepest gut in the back of an arm, where bait gets pinned. On a drawn-down lake, the water pulling out of the backs pushes fish to the main river.',
      depth: '15–40 ft on the structure, but plenty of fish sit well up off the bottom.',
      presentation:
        'Two opposite things both work. Slow: drag a football jig, a Ned rig or a small swimbait, dead-sticking with almost no action. Fast: speed-crank a tight-wobble deep crankbait on a 7:1 or 8:1 reel — burn, burn, pause — which triggers a feed response in water down into the 30s and catches outsized fish.',
      bait: 'Football jig (brown and purple), Ned rig, blade bait hopped on the bottom, jig-and-minnow strolled, an A-rig, and a big swimbait for one giant bite.',
      key: 'Cold does not shut them off, it concentrates them. Winter is stable — find them on a point and they will be on that point for weeks.',
    },
    {
      name: 'Pre-spawn — the shallow push',
      tempF: [48, 58],
      trend: 'warming',
      months: [2, 3],
      where:
        'Secondary points leading into the biggest spawning coves — pick the coves with the most shallow flat in the back and work the points from the back out. Channel bends, transition banks, the first cover near an inflow of water (warmer than the lake is a magnet, colder than the lake is a dead zone).',
      depth: '4–15 ft and getting shallower through the phase.',
      presentation:
        'Power fishing returns. Cover water fast — square bills, lipless, chatterbaits, jerkbaits — to locate groups, then work them over. Fish push up in waves, males first and the big females behind them, so the same spot improves day by day.',
      bait: 'Lipless hopped on the bottom (not burned) for the biggest bites, square bill in red or orange, aggressive flashy jerkbaits, chatterbait, under-spin, an 8-in swimbait for a giant.',
      key:
        'They move before you feel it — often around the February full moon, and it can happen overnight. Check the beginnings of your spring areas a fortnight before you think you should. And stay back: these fish have not seen a boat since autumn and will blow out of a pocket you run into.',
    },
    {
      name: 'Spawn',
      tempF: [58, 68],
      trend: 'warming',
      months: [3, 4, 5],
      where:
        'Shallow flats in the backs of coves and pockets, hard bottom, and anything isolated to bed against — a stump, a laydown, a dock post, a reed clump, a bush. Fish stage on the last piece of cover before the flat.',
      depth: '1–6 ft for bedding fish, 5–10 ft for the ones staging.',
      presentation:
        'All three phases overlap, so keep an open mind: pre-spawn fish still feeding, fish on beds, and the first ones backing out. Slow down and pick cover apart. Bed fish pick at a bait rather than eating it, so a smaller profile hooks more of them.',
      bait: 'Wacky or Texas-rigged stick bait, flipping jig on isolated cover, soft jerkbait, chatterbait along the flat, and a glide bait worked right beside cover.',
      key: 'The bluegill spawn and the shad spawn overlap the tail of this, and both pull big bass shallow — see the next phase.',
    },
    {
      name: 'Post-spawn — the shad spawn and the split',
      tempF: [62, 75],
      trend: 'warming',
      months: [5, 6],
      where:
        'The population splits. Half stay shallow — grass, docks, laydowns, the backs of pockets. Half work back out the way they came: staging cover, then the first break or rock pile nearest the spawning bay, then main-lake structure. The shad spawn happens on HARD shallow surfaces — riprap, gravel, rock points, seawalls, boat ramps, jetty walls — in the dark and the first hour of light.',
      depth: 'Shallow fish 1–8 ft; the outbound fish 8–20 ft and getting deeper.',
      presentation:
        'Be there at first light for the shad spawn — it is over by mid-morning. Use weedless baits on it: hanging up and going in to retrieve a lure ruins the spot for the day. Spinnerbaits with small blades let you go fast, which is what a fleeing shad does.',
      bait: 'Spinnerbait (small blades, fast), under-spin, chatterbait, popper and walking bait, square bill on riprap; deep crank and a big worm for the fish already heading out.',
      key: 'The under-spin is the difference-maker whenever bass are on a bait ball. A bare swimbait is one of ten thousand shad; a blade clears a bubble of space around your bait and makes it the obvious one.',
    },
    {
      name: 'Summer — offshore schools and shallow shade',
      tempF: [75, 88],
      months: [6, 7, 8],
      where:
        'Two games. Offshore: ledges, humps, creek-channel swings, the ends of long tapering points, shell beds and hard bottom, where schools stack up. Shallow: live green grass, docks, laydowns and bluff-wall shade. Current from a dam turns the offshore fish on hard.',
      depth: '12–25 ft offshore; 1–8 ft in the grass and shade. The thermocline is the floor — nothing worth catching lives below it.',
      presentation:
        'Deep-crank and hop a worm or a jig on the offshore stuff; frog, topwater and flipping in the shallow cover. Fish the shade side of everything — as the sun climbs, a bluff-wall shade line narrows to a few feet and pins fish against the wall.',
      bait: 'Deep crankbait, big worm, football jig, flutter spoon, drop shot and strolled minnow offshore; frog, walking bait, popper and soft jerkbait shallow.',
      key: 'Metabolism is at its peak, so they feed — but oxygen is at its lowest. Live green grass makes oxygen and holds everything; dying brown grass holds nothing.',
    },
    {
      name: 'Late summer — the hardest month',
      tempF: [85, 100],
      months: [8, 9],
      where:
        'The coolest, most oxygenated water you can find: the greenest grass, the deepest shade, moving water, and the depth just above the thermocline. Roaming open-water fish chase bait balls — watch for birds and boils.',
      depth: 'Wherever the oxygen is. Often 15–25 ft, but shallow grass still produces at first and last light.',
      presentation:
        'Low light is most of the battle. Downsize everything — the fish are educated by now and this year’s shad are still juvenile-sized, so smaller is also matching the hatch. Slow down, and change baits often.',
      bait: 'Smaller frogs, smaller topwaters, downsized under-spins and swimbaits, drop shot, shaky head, and a deep crank for the offshore schools.',
      key: 'Everything has been thrown at these fish since February. Being different beats being right — a bait they have not seen outfishes a better bait they have.',
    },
    {
      name: 'Fall transition — following the bait shallow',
      tempF: [62, 80],
      trend: 'cooling',
      months: [9, 10],
      where:
        'Bass follow bait into the creeks and pockets and pin it shallow. Creek channels are the route in. Also fish driving bait down steep banks, and schools still out on the main lake. The remaining live grass and the first hard cover beside it.',
      depth: 'Everything from 1 ft to 20 ft on the same day — the bait decides.',
      presentation:
        'Cover water and look for activity: blow-ups, wakes, bait showering, birds. Keep a topwater rigged and ready to drop your rod and pick up — a school surfaces for seconds. It is the wrong time of year to fish slowly.',
      bait: 'Walking bait and popper, square bill in the backs of pockets, chatterbait, under-spin, soft jerkbait in grass, deep crank on the fish pulling to channels, and a spoon on deep bait balls.',
      key:
        'Early September can be the hardest fishing of the year — summer is over but the transition has not started. Once nights cool and the water drops below about 80°F it turns on, and it is all about the bait from there to winter.',
    },
    {
      name: 'Late fall — the feed before winter',
      tempF: [48, 62],
      trend: 'cooling',
      months: [10, 11, 12],
      where:
        'Bait balls, wherever they are: backs of pockets and bays, main-lake points, bluff ends, and the creek channels between. The fish travel with the bait rather than holding a spot.',
      depth: '8–20 ft is the core, shallower when the bait goes shallow.',
      presentation:
        'Reaction. Speed-cranking comes into its own now and stays useful all winter. Everything with flash — the water clears as it cools, and a bait that throws light pulls fish off a real shad ball.',
      bait: 'Speed crank, jerkbait with flash, A-rig (bladed while the water has colour, bare once it clears), under-spin, blade bait, spinnerbait, and a finesse football jig to slow down.',
      key: 'This is the last stretch before they group up for winter, and they are eating to store for it. Big fish are catchable on moving baits in a way they will not be again until spring.',
    },
  ],
  mistakes: [
    'Staying too long somewhere that is not producing. If a few casts and an adjustment raise nothing, move — you are buying information, not spots.',
    'Fishing memory. Where they were on this date last year means nothing if the water is 15° different.',
    'Running the boat into shallow water you intend to fish. Stay back and make long casts, especially in spring, when the fish have not seen a boat for months.',
    'Reeling a crankbait or swimbait straight back. Start, stop, twitch, deflect — the pause is where the bite comes.',
    'Throwing what everyone else throws on a pressured lake. Being the different bait is worth more than being the better one.',
  ],
  source: 'Tactical Bassin (youtube.com/@TacticalBassin) — 152 seasonal and technique videos, distilled by month',
};

/**
 * Bluegill, redear (shellcracker) and the rest of the sunfish, from Richard
 * Gene the Fishing Machine (@RichardGeneTheFishingMachine) — 90 panfish
 * videos, mostly bank and small-boat fishing in the South, which is how most
 * people actually fish for them.
 */
const PANFISH: Playbook = {
  species: 'sunfish',
  match: ['sunfish', 'bluegill', 'shellcracker', 'redear', 'bream', 'panfish'],
  laws: [
    'They bed on the full moon, over and over. From spring through late summer, the days after each full moon put fish back on the beds — it is not one event a year.',
    'A bedding fish is not hungry, it is defending. It hits a bait because the bait is in the bed, so keep it there: the longer it sits, the more certain the bite.',
    'Small beats everything. A one-inch bait on a 1/80 oz head with a size 10–12 hook catches more and bigger panfish than anything larger.',
    'Shellcracker feed DOWN, on snails and mussels. The bait has to be on the bottom for them, which is the single difference between catching them and catching bluegill.',
    'The biggest ones are not caught in spring. Autumn through winter, in deep water, is when the giants come — and almost nobody is out there doing it.',
  ],
  phases: [
    {
      name: 'Winter — deep and worth the trip',
      tempF: [32, 55],
      months: [12, 1, 2],
      where:
        'Deep points where a cove or finger meets the main lake, especially when the lake is drawn down. Rocky bottom, brush, and the deeper holes in creeks. In a pond, anywhere there is a foot or two more water than the rest.',
      depth: '12–24 ft, occasionally more. In shallow ponds, a foot or two under a float.',
      presentation:
        'Drag and pause — move it a couple of inches to draw attention, then leave it sitting. In a pond, a tiny float with no weight at all so the fish feels no resistance when it takes.',
      bait: 'Half a nightcrawler on a light wire hook with a small split shot; a micro jig fished vertically over fish you have marked.',
      key: 'Cold water is when they taste best and when the biggest ones are catchable. Nobody else is doing it.',
    },
    {
      name: 'Pre-spawn — staging off the flats',
      tempF: [55, 68],
      trend: 'warming',
      months: [3, 4],
      where: 'The first drop off the spawning flats, brush and cover on the way in, and the creek mouths feeding those flats.',
      depth: '4–10 ft.',
      presentation: 'Slower than in summer, and on or near the bottom. A float set deep, or a small jig crawled.',
      bait: 'Worm on a small hook, a 1-in soft bait on a tiny jig head, a micro jig.',
      key: 'Watch the water temperature climb toward the low 70s — that is when the first wave moves up to bed.',
    },
    {
      name: 'The bedding waves — spring into late summer',
      tempF: [68, 88],
      months: [5, 6, 7, 8],
      where:
        'Shallow flats, the backs of bays and creek arms, coves and cuts, and along banks — but do not assume the bank. Beds are often out in the middle of a 3–4 ft flat. They show on side imaging as rings or craters, with the fish as bright marks in and around them; polarised glasses find them in clear water.',
      depth: '1–5 ft, and often exactly 3 ft.',
      presentation:
        'Put the bait IN the bed and leave it. If you are not bitten in 10–15 seconds, reel in a few feet, let it sit again, and keep stepping it back until you find the edge of the colony. Long light rod, light line, loop knot for extra action.',
      bait: 'A 1-in soft bait on a 1/80 oz jig head; red worm or cricket under a small float on a #6–#8 Aberdeen hook; a 1/32 oz hair jig. For shellcracker specifically, get it on the bottom.',
      key:
        'It repeats after every full moon from spring through summer, so a bed that is empty this week is worth checking next week. Big bass patrol the colonies — a green-pumpkin stick bait worked on a bluegill bed is one of the better post-spawn bass patterns there is.',
    },
    {
      name: 'Autumn — the big-fish window',
      tempF: [55, 75],
      trend: 'cooling',
      months: [9, 10, 11],
      where:
        'Deep points, the mouths of coves and fingers, rock and brush in deeper water. As the lake is drawn down the bigger fish funnel out of the shallow arms and stack on the first deep structure outside them.',
      depth: '10–20 ft.',
      presentation: 'Cover ground — they scatter in autumn. Drag, pause, and keep contact with the bottom.',
      bait: 'Worm on a light split-shot rig, micro jigs, small soft plastics on a light head.',
      key: 'The best bluegill and shellcracker of the year are caught between now and midwinter, in deep water, by people who are supposed to be crappie fishing.',
    },
  ],
  mistakes: [
    'Fishing too big. Everything about panfish gear should be smaller than feels right — hook, bait, line, float.',
    'Fishing the bank and ignoring the middle of the flat. Colonies bed out in open shallow water constantly.',
    'Pulling the bait out of the bed too soon. Leave it there; the bite is a decision, not an ambush.',
    'Keeping the bait off the bottom when shellcracker are the target — they feed down, and a suspended bait will be ignored all day.',
    'Putting the rods away after the spawn. Autumn and winter produce the biggest fish of the year in deeper water.',
  ],
  source: 'Richard Gene the Fishing Machine (youtube.com/@RichardGeneTheFishingMachine) — 90 panfish videos, distilled by season',
};

const PLAYBOOKS: Playbook[] = [CRAPPIE, BASS, PANFISH];

/** Case- and plural-insensitive: "Black Crappie", "crappie", "White crappie". */
export function playbookFor(species: string): Playbook | null {
  const want = String(species || '').toLowerCase();
  if (!want) return null;
  // Deliberately substring matching on the specific words: "White Bass" and
  // "Striped & Hybrid" must not pick up the largemouth book.
  return PLAYBOOKS.find((p) => p.match.some((m) => want.includes(m))) || null;
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
