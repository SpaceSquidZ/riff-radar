// scripts/test-artist-match.mjs
//
// Regression fixtures for the wrong-match guard (T1.4).
// No test framework needed:
//
//     node scripts/test-artist-match.mjs
//
// Add a case here every time a wrong match reaches a user. That is how the
// ZAYN failure stops being a thing that can happen twice.

import { artistsMatch } from '../api/lib/validateTracks.js';

const cases = [
  // --- MUST MATCH -----------------------------------------------------------
  ['ZAYN', 'ZAYN', true, 'identical'],
  ['The Beatles', 'Beatles', true, 'leading article dropped'],
  ['Beatles', 'The Beatles', true, 'leading article added'],
  ['Amália Rodrigues', 'Amalia Rodrigues', true, 'accent stripped by user'],
  ['Ali Farka Touré', 'Ali Farka Toure', true, 'accent stripped by user'],
  ['Lhasa De Sela', 'Lhasa de Sela', true, 'case difference'],
  ['The Roots feat. Erykah Badu', 'Erykah Badu', true, 'collab credited to feature'],
  ['Erykah Badu', 'The Roots feat. Erykah Badu', true, 'collab, reversed'],
  ['Mr. Fingers', 'Mr Fingers', true, 'punctuation'],

  // --- MUST NOT MATCH -------------------------------------------------------
  // The case Steven found in casual testing. iTunes returned a real track by a
  // real artist whose name CONTAINS the requested one. Substring matching alone
  // let it through and it rendered as a genuine recommendation.
  ['Zayn Keoh', 'ZAYN', false, 'ZAYN regression — the original wrong match'],

  ['DJ Khaled', 'Ka', false, 'Ka regression — two-letter name swallowed'],
  ['Kanye West', 'Ye', false, 'short alias inside unrelated name'],
  ['Bobby Caldwell', 'Bobby Womack', false, 'shared first name only'],
  ['John Fahey', 'John Coltrane', false, 'shared first name only'],
  ['Elis Regina', 'Elis', false, 'first name is not the artist'],
  ['Grouper', 'Group Home', false, 'similar prefix, different act'],
  ['Talk Talk', 'Talking Heads', false, 'similar but distinct'],
];

let pass = 0;
let fail = 0;

for (const [itunesArtist, recArtist, expected, note] of cases) {
  const actual = artistsMatch(itunesArtist, recArtist);
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(
      `FAIL  itunes="${itunesArtist}" rec="${recArtist}"  ` +
        `expected=${expected} got=${actual}  (${note})`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed out of ${cases.length}`);
process.exit(fail > 0 ? 1 : 0);
