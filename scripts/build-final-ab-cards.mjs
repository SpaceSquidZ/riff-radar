// One-off for Brief D Part 2 (final, hand-run version). Builds the blind
// shuffled rating file from the 22 real cards collected by hand against the
// deployed preview (two arms, today) plus the 11 cards from the 2026-08-30
// production run (kept as a same-arm variance control, per user decision:
// if the two arm-A groups rate similarly despite differing only in
// max_tokens, the measurement is stable; if not, run-to-run noise is bigger
// than the effect and the fast arm ships regardless).
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CARDS = [
  // --- yesterday_armA: 2026-08-30 production run, thinking on, max_tokens=4096 (pre-Brief-D-Part-2 code) ---
  { group: 'yesterday_armA', script: 'mike', artist: 'Standing on the Corner', track: 'Angel', connection_type: 'same_mechanism (Distant)', reasoning_text: 'Buries its most important sounds under tape hiss and murk, the same way MIKE buries vocals under the loop.' },
  { group: 'yesterday_armA', script: 'mike', artist: 'Slauson Malone', track: 'Smile', connection_type: 'same_move', reasoning_text: 'Buries the vocal under the loop instead of on top of it, the same decision MIKE makes constantly.' },
  { group: 'yesterday_armA', script: 'mike', artist: 'Earl Sweatshirt', track: 'Mtomb', connection_type: 'lineage', reasoning_text: "Earl's hazy, off-kilter loop style on this cut is the clearest lineage point for MIKE's whole sound." },
  { group: 'yesterday_armA', script: 'mike', artist: 'Maxo', track: 'Time', connection_type: 'same_scene', reasoning_text: 'Maxo came up in the same loop-heavy New York circle trading beats with MIKE and Slauson Malone.' },
  { group: 'yesterday_armA', script: 'mike', artist: 'SLAUSON MALONE 1', track: 'New Joy', connection_type: 'same_scene', reasoning_text: 'Another corner of the same Slauson Malone catalog, deeper into fragmented vocal collage.' },
  { group: 'yesterday_armA', script: 'hecker', artist: 'William Basinski', track: 'dlp 1.1', connection_type: 'lineage', reasoning_text: 'Tape loops decaying in real time predate and shape the degraded, crumbling textures Hecker builds from.' },
  { group: 'yesterday_armA', script: 'hecker', artist: 'Grouper', track: "Heavy Water/I'd Rather Be Sleeping", connection_type: 'same_mechanism', reasoning_text: 'Buries the vocal so far under the reverb it becomes texture rather than language, same operation Hecker runs on melody.' },
  { group: 'yesterday_armA', script: 'hecker', artist: 'Fennesz', track: 'Endless Summer', connection_type: 'same_scene', reasoning_text: 'Came out of the same Mego label crowd of processed-guitar electronic artists Hecker orbited early on.' },
  { group: 'yesterday_armA', script: 'hecker', artist: 'Grouper', track: "Heavy Water/I'd Rather Be Sleeping", connection_type: 'same_mechanism', reasoning_text: 'Requested by name, buries the vocal so far under reverb it becomes texture rather than language.' },
  { group: 'yesterday_armA', script: 'hecker', artist: 'Jefre Cantu-Ledesma', track: 'Womb Night', connection_type: 'same_move', reasoning_text: 'Drenches guitar in reverb until pitch and rhythm dissolve into color, the same erasure move Grouper uses on voice.' },
  { group: 'yesterday_armA', script: 'hecker', artist: 'Huerco S.', track: 'A Sea of Love', connection_type: 'same_mechanism (Distant)', reasoning_text: 'Sounds nothing alike but performs the same operation, hiding the emotional center under layers of degraded texture.' },

  // --- today_armA: dpl_6akxYCSGKxUcAiZcAhhJVWXfbjky (thinking on, max_tokens=8000) ---
  { group: 'today_armA', script: 'mike', artist: 'Standing on the Corner', track: 'Angel', connection_type: 'same_mechanism (Distant)', reasoning_text: "Buries the most important vocal line under dense collage, same operation MIKE's production runs constantly." },
  { group: 'today_armA', script: 'mike', artist: 'Billy Woods', track: 'Spider Hole', connection_type: 'same_scene', reasoning_text: 'Same New York underground lattice, denser and older but the same refusal to sound polished.' },
  { group: 'today_armA', script: 'mike', artist: 'SLAUSON MALONE 1', track: 'New Joy', connection_type: 'same_hand', reasoning_text: 'Same artist project under a different name, same collage-built production philosophy.' },
  { group: 'today_armA', script: 'hecker', artist: 'Sigur Rós', track: 'Svefn-g-englar', connection_type: 'same_mechanism', reasoning_text: "Withholds a rhythmic arrival the whole arrangement seems to be promising, just like Hecker's slow builds." },
  { group: 'today_armA', script: 'hecker', artist: 'Grouper', track: "Heavy Water/I'd Rather Be Sleeping", connection_type: 'same_move', reasoning_text: 'Vocal buried so deep in reverb it becomes texture, the same disappearing-melody trick Hecker uses instrumentally.' },
  { group: 'today_armA', script: 'hecker', artist: 'William Basinski', track: 'Disintegration Loops III', connection_type: 'same_mechanism', reasoning_text: "Repeats a decaying loop until it becomes something else entirely, same slow erosion Hecker builds his pieces around." },

  // --- today_armB: dpl_LZxtdsvgiVpjKTHvy9E4fh5ujT71 (thinking disabled, max_tokens=8000) ---
  { group: 'today_armB', script: 'mike', artist: 'ovrkast.', track: 'TBH!', connection_type: 'same_scene', reasoning_text: "ovrkast. shares the same hazy, sample-chopped production ethos that runs through MIKE's whole circle." },
  { group: 'today_armB', script: 'mike', artist: 'SLAUSON MALONE 1', track: 'Smile #2', connection_type: 'same_hand', reasoning_text: "Same artist's own catalogue under his full alias, showing the collage approach at its most extreme." },
  { group: 'today_armB', script: 'mike', artist: 'Ground-Zero', track: 'Consume Mao', connection_type: 'same_mechanism (Distant)', reasoning_text: 'Builds a song from stolen fragments that interrupt each other, same operation Slauson Malone runs on soul samples.' },
  { group: 'today_armB', script: 'mike', artist: 'Klein', track: 'redemption tour', connection_type: 'same_mechanism (Distant)', reasoning_text: "Melody keeps dissolving into static and silence, withholding resolution the same way Slauson Malone's songs do." },
  { group: 'today_armB', script: 'hecker', artist: 'Sigur Rós', track: 'Svefn-g-englar', connection_type: 'same_mechanism', reasoning_text: 'Withholds resolution far past comfort, building pressure through sustain rather than melody.' },
];

if (CARDS.length !== 22) throw new Error(`expected 22 cards, got ${CARDS.length}`);

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  return lines.join('\n') + '\n';
}

const withIds = CARDS.map((c) => ({ ...c, card_id: randomUUID() }));

// Fisher-Yates shuffle
const shuffled = [...withIds];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}

const blindRows = shuffled.map((c) => ({
  card_id: c.card_id,
  artist: c.artist,
  track: c.track,
  connection_type: c.connection_type,
  reasoning_text: c.reasoning_text,
  rating: '',
}));
const mappingRows = withIds.map((c) => ({
  card_id: c.card_id,
  group: c.group,
  script: c.script,
}));

writeFileSync(
  './replay-out/ab_cards_shuffled.csv',
  toCsv(blindRows, ['card_id', 'artist', 'track', 'connection_type', 'reasoning_text', 'rating'])
);
writeFileSync(
  './replay-out/ab_cards_SEALED_MAPPING.csv',
  toCsv(mappingRows, ['card_id', 'group', 'script'])
);

console.log(`Wrote ${blindRows.length} rows to replay-out/ab_cards_shuffled.csv (blind, shuffled, no arm label)`);
console.log(`Wrote ${mappingRows.length} rows to replay-out/ab_cards_SEALED_MAPPING.csv (SEALED)`);
console.log('\nGroup counts (for your own sanity check, not written to the blind file):');
for (const g of ['yesterday_armA', 'today_armA', 'today_armB']) {
  console.log(`  ${g}: ${CARDS.filter((c) => c.group === g).length}`);
}
