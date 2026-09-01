// One-off aggregation for Brief D Part 2. Reads every turns-*.csv and
// cards-*.csv in replay-out/, and produces:
//   1. replay-out/ab_cards_shuffled.csv  -- blind, shuffled, no arm label
//   2. replay-out/ab_cards_SEALED_MAPPING.csv -- card_id -> arm, Jackie does not open
//   3. prints per-arm automatic numbers (median ttft/duration, mean validated_ok, blank-turn fallbacks)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const DIR = './replay-out';

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const cols = lines[0].split(',');
  return lines.slice(1).map((line) => {
    // naive CSV split good enough here: no embedded commas in our data except
    // reasoning_text/user_message, which we don't need to re-split for this script
    const vals = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') {
          inQuotes = false;
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        vals.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    vals.push(cur);
    const row = {};
    cols.forEach((c, i) => (row[c] = vals[i]));
    return row;
  });
}

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

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

const files = readdirSync(DIR);
const turnFiles = files.filter((f) => f.startsWith('turns-'));
const cardFiles = files.filter((f) => f.startsWith('cards-'));

let allCards = [];
for (const f of cardFiles) {
  const rows = parseCsv(readFileSync(`${DIR}/${f}`, 'utf8'));
  allCards.push(...rows);
}

// Shuffle (Fisher-Yates)
for (let i = allCards.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [allCards[i], allCards[j]] = [allCards[j], allCards[i]];
}

const blindRows = allCards.map((c) => ({
  card_id: c.card_id,
  artist: c.artist,
  track: c.track,
  connection_type: c.connection_type,
  reasoning_text: c.reasoning_text,
  rating: '',
}));
const mappingRows = allCards.map((c) => ({
  card_id: c.card_id,
  run_label: c.run_label,
  script: c.script,
}));

writeFileSync(
  `${DIR}/ab_cards_shuffled.csv`,
  toCsv(blindRows, ['card_id', 'artist', 'track', 'connection_type', 'reasoning_text', 'rating'])
);
writeFileSync(
  `${DIR}/ab_cards_SEALED_MAPPING.csv`,
  toCsv(mappingRows, ['card_id', 'run_label', 'script'])
);

console.log(`Wrote ${blindRows.length} rows to ${DIR}/ab_cards_shuffled.csv (blind, no arm label)`);
console.log(`Wrote ${mappingRows.length} rows to ${DIR}/ab_cards_SEALED_MAPPING.csv (SEALED -- Jackie does not open)`);

// --- automatic numbers per arm ---
const byArm = {};
for (const f of turnFiles) {
  const rows = parseCsv(readFileSync(`${DIR}/${f}`, 'utf8'));
  for (const r of rows) {
    const arm = r.run_label;
    byArm[arm] = byArm[arm] || { ttft: [], duration: [], validatedOk: [], blankFallbacks: 0, turns: 0 };
    if (r.ttft_ms) byArm[arm].ttft.push(Number(r.ttft_ms));
    if (r.duration_ms) byArm[arm].duration.push(Number(r.duration_ms));
    byArm[arm].validatedOk.push(Number(r.validated_ok) || 0);
    if (r.blank_turn_fallback_fired === 'true') byArm[arm].blankFallbacks += 1;
    byArm[arm].turns += 1;
  }
}

console.log('\n--- Automatic numbers per arm ---');
for (const [arm, d] of Object.entries(byArm)) {
  console.log(`\n${arm}: (${d.turns} turns)`);
  console.log(`  median ttft_ms:     ${median(d.ttft)}`);
  console.log(`  median duration_ms: ${median(d.duration)}`);
  console.log(`  mean validated_ok:  ${mean(d.validatedOk)?.toFixed(3)}`);
  console.log(`  blank-turn fallbacks fired: ${d.blankFallbacks}`);
}
