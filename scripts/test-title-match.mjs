// scripts/test-title-match.mjs
//
// Regression fixtures for the TITLE half of wrong-match detection.
// Companion to scripts/test-artist-match.mjs. No test framework needed:
//
//     node scripts/test-title-match.mjs
//
// WHY THIS EXISTS
// Roadmap v2 Wave 1 scopes wrong-match detection as "artist string distance,
// title suffix rejection, artist-entity check, regression fixtures". The artist
// half shipped and has had fixtures since July. The title half was never built
// on the recommendation path, so validateOneTrack accepted any track by the
// right artist — iTunes search is a relevance ranker, and asking it for a song
// that does not exist returns a different one by that artist, complete with a
// preview clip and store link. Roughly eight of those rendered as real cards in
// one live MIKE session on 2026-08-21.
//
// Add a case here every time a wrong title reaches a user.

import { titlesMatch } from '../api/lib/validateTracks.js';

const cases = [
  // --- MUST MATCH: legitimate catalogue decoration -------------------------
  ['Blue in Green', 'Blue in Green', true, 'identical'],
  ['Blue in Green (2023 Remaster)', 'Blue in Green', true, 'remaster suffix'],
  ['Tonight - 2011 Remaster', 'Tonight', true, 'dash remaster suffix'],
  ['Doomed (Extended Version)', 'Doomed', true, 'version suffix'],
  ['Mustt Mustt [Explicit]', 'Mustt Mustt', true, 'explicit bracket tag'],
  ['Chum (feat. Vince Staples)', 'Chum', true, 'feature parenthetical'],
  ["Echo's Answer", 'Echos Answer', true, 'apostrophe dropped by user'],
  [
    'Yèkèrmo Sèw (A Man of Experience and Wisdom)',
    'Yekermo Sew',
    true,
    'translated subtitle plus accents — the real opener-pool case',
  ],
  ['Heavy Water/I\'d Rather Be Sleeping', 'Heavy Water/I\'d Rather Be Sleeping', true, 'slash title'],

  // --- MUST NOT MATCH: the live 2026-08-21 wrong-match set -----------------
  // Each of these shipped as a real card. Same artist, entirely different song.
  ['Quanne Se Fa Notte', 'Vase', false, 'MAVI — wrong song shipped as Vase'],
  ['Gravel Pit', 'Nu Sha', false, 'Wu-Tang Clan — wrong song shipped as Nu Sha'],
  ['Living in the World Today', 'Duels', false, 'GZA — wrong song shipped as Duels'],
  ['Vintage Limo', 'Fire In The Hole', false, 'Roc Marciano'],
  ['Heat', 'Ex Girl to Next Girl', false, 'Mobb Deep'],
  ['Still Not A Player', 'Nutcracker', false, 'Big Punisher'],
  ['Cartel Gathering', 'Ason Jones', false, 'Ghostface Killah'],
  ['The Sun', 'Blue Rain', false, 'Windy & Carl'],
  ['Sybil', 'Idyll', false, 'Sarah Davachi'],
  ['Vow', 'The City', false, 'Julianna Barwick'],
  ['River that flows two ways', 'Instrumental Tourist (excerpt)', false, 'Jefre Cantu-Ledesma'],
  ['What Is There', 'Void', false, 'Chihei Hatakeyama'],

  // --- MUST NOT MATCH: near-miss titles ------------------------------------
  ['Falling Slowly', 'Falling', false, 'longer unrelated title sharing a word'],
  ['The Kiss of Death', 'The Kiss', false, 'substring is not identity'],
  ['', 'Anything', false, 'empty iTunes title'],
  ['Anything', '', false, 'empty requested title'],
];

let pass = 0;
let fail = 0;

for (const [itunesTitle, recTitle, expected, note] of cases) {
  const actual = titlesMatch(itunesTitle, recTitle);
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(
      `FAIL  itunes="${itunesTitle}" rec="${recTitle}"  ` +
        `expected=${expected} got=${actual}  (${note})`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed out of ${cases.length}`);
process.exit(fail > 0 ? 1 : 0);
