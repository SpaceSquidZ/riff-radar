"""
Generates src/openerPairs.js from the 15 curated pairs.

Run from the repo root:
    pip3 install requests
    python3 scripts/build_opener_pairs.py

Writes src/openerPairs.js, ready to import. Re-run any time a pair changes.

WHY A GENERATOR AND NOT A HAND-WRITTEN FILE
Each of the 30 tracks needs a preview URL, an artwork URL, and an Apple Music
link, none of which are memorable strings. Transcribing 90 URLs by hand invites
an error in every one of them. The pool definition below is the part a human
edits. The URLs are derived.

The July 2026 validation pass confirmed all 30 tracks resolve. That pass did not
capture artwork URLs, which opener cards need. This script adds them and emits
the result as code rather than as a JSON file nothing imports.
"""

import json
import time
import requests
from difflib import SequenceMatcher

FALLBACK_STOREFRONTS = ["US", "HK", "TW", "JP", "KR", "CN"]

# pair_id, (song A, artist A), (song B, artist B), internal thread.
# The thread is NEVER rendered. It exists so the pair coheres, and so Groove can
# answer if someone asks why these two.
PAIRS = [
    ("p01", ("Tonight", "Sibylle Baier"), ("BTSTU", "Jai Paul"),
     "Recordings that escaped. One a home tape lost for thirty years, one a leak."),
    ("p02", ("\u4f86\u4e0d\u53ca", "Sandee Chan"), ("Cherry-Coloured Funk", "Cocteau Twins"),
     "Voice used as texture rather than language."),
    ("p03", ("Caboclo", "Arthur Verocai"), ("Strawberry Letter 23", "Shuggie Otis"),
     "Two records that flopped on release and got dug back up decades later."),
    ("p04", ("Turiya and Ramakrishna", "Alice Coltrane"), ("Blink", "Hiroshi Yoshimura"),
     "Music that behaves like a room instead of a song."),
    ("p05", ("Yekermo Sew", "Mulatu Astatke"), ("Obaa Sima", "Ata Kak"),
     "Records that reached the West late and by accident."),
    ("p06", ("Heavy Water/I'd Rather Be Sleeping", "Grouper"), ("Falling", "Julee Cruise"),
     "Voices kept underwater on purpose."),
    ("p07", ("Mustt Mustt", "Nusrat Fateh Ali Khan"), ("Doomed", "Moses Sumney"),
     "The voice carrying the entire arrangement alone."),
    ("p08", ("The Kiss", "Judee Sill"), ("Anything", "Adrianne Lenker"),
     "One guitar, one voice, forty-seven years apart."),
    ("p09", ("Echo's Answer", "Broadcast"), ("Love Without Sound", "White Noise"),
     "Electronics built to sound like memory rather than the future."),
    ("p10", ("Mystery of Love", "Mr. Fingers"), ("Let It Go", "DJ Rashad"),
     "Chicago dance music made for being alone, two generations apart."),
    ("p11", ("Estranha Forma de Vida", "Amalia Rodrigues"), ("De Cara a la Pared", "Lhasa de Sela"),
     "Loss sung as a form rather than a feeling."),
    ("p12", ("The Downtown Lights", "The Blue Nile"), ("New Grass", "Talk Talk"),
     "Records that took years to make. Production as patience."),
    ("p13", ("Sports Men", "Haruomi Hosono"), ("That's Us/Wild Combination", "Arthur Russell"),
     "Pop music by people who couldn't stop experimenting, both found late."),
    ("p14", ("Amandrai", "Ali Farka Toure"), ("Poor Boy", "John Fahey"),
     "The blues traveling in both directions at once."),
    ("p15", ("Old Justice", "Ka"), ("Home Is Where the Hatred Is", "Gil Scott-Heron"),
     "New York voices talking low over almost nothing."),
]


def similarity(a, b):
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def search(term, country):
    try:
        r = requests.get(
            "https://itunes.apple.com/search",
            params={"term": term, "entity": "song", "country": country, "limit": 5},
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("results", [])
    except requests.RequestException:
        return None


def resolve(song, artist):
    """Everything a card needs, or None if unresolvable in any storefront."""
    for country in FALLBACK_STOREFRONTS:
        results = search(f"{artist} {song}", country)
        time.sleep(0.3)  # polite to an undocumented, unofficially limited API
        if not results:
            continue

        scored = sorted(
            ((similarity(r.get("artistName", ""), artist), r) for r in results),
            key=lambda x: x[0],
            reverse=True,
        )
        score, best = scored[0]

        # Same 0.7 artist-similarity floor the runtime validator uses, plus a
        # hard preview requirement: a card with no audio is the one thing this
        # screen cannot afford.
        if score < 0.7 or not best.get("previewUrl"):
            continue

        art = best.get("artworkUrl100") or ""
        return {
            "track": best.get("trackName") or song,
            "artist": best.get("artistName") or artist,
            "year": (best.get("releaseDate") or "")[:4] or None,
            "genre": best.get("primaryGenreName"),
            "previewUrl": best.get("previewUrl"),
            # iTunes returns 100x100 by default, which is soft on retina. The
            # URL pattern is predictable, so ask for a real size.
            "artworkUrl": art.replace("100x100", "400x400") if art else None,
            "trackViewUrl": best.get("trackViewUrl"),
            "storefront": country,
        }
    return None


HEADER = '''// src/openerPairs.js
//
// GENERATED FILE. Do not edit by hand.
// Regenerate with: python3 scripts/build_opener_pairs.py
//
// The two records Groove has on when someone arrives (D-025). Curated, not
// generated: session-one hallucination does the most damage, and a live API
// call would put several seconds between page load and anything appearing.
//
// Pairs, not a flat list of 30. Random pairing from a flat pool produces
// incoherent combinations, and incoherence on turn one reads as no taste,
// which is the opposite of the required first impression.
//
// `thread` is INTERNAL and never rendered. It exists so the pair coheres, and
// so Groove can answer if someone asks why these two.

export const OPENER_PAIRS = '''

FOOTER = ''';

const SHOWN_KEY = 'rr_opener_pairs_shown';

function readShown() {
  try {
    const raw = localStorage.getItem(SHOWN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Picks a pair this visitor has not seen, at random among the unseen.
 *
 * Resets once the pool is exhausted, so a heavy returner cycles rather than
 * getting stuck on whichever pair happened to be last. Fifteen pairs means
 * fifteen distinct openings before anyone sees a repeat.
 */
export function pickOpenerPair() {
  const shown = readShown();
  let unseen = OPENER_PAIRS.filter((p) => !shown.includes(p.id));

  if (unseen.length === 0) {
    unseen = OPENER_PAIRS;
    try {
      localStorage.setItem(SHOWN_KEY, JSON.stringify([]));
    } catch {
      /* private browsing, ignore */
    }
  }

  const pair = unseen[Math.floor(Math.random() * unseen.length)];

  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify([...readShown(), pair.id]));
  } catch {
    /* private browsing, ignore */
  }

  return pair;
}
'''


def main():
    out_pairs = []
    failures = []

    print(f"Resolving {len(PAIRS)} pairs against iTunes...\n")

    for pair_id, a, b, thread in PAIRS:
        print(f"  {pair_id}", end=" ", flush=True)
        ra = resolve(*a)
        rb = resolve(*b)

        if not ra or not rb:
            failures.append((pair_id, a if not ra else b))
            print("FAIL")
            continue

        out_pairs.append({"id": pair_id, "thread": thread, "tracks": [ra, rb]})
        print("ok")

    with open("src/openerPairs.js", "w", encoding="utf-8") as f:
        f.write(HEADER)
        f.write(json.dumps(out_pairs, indent=2, ensure_ascii=False))
        f.write(FOOTER)

    print(f"\nWrote src/openerPairs.js with {len(out_pairs)} of {len(PAIRS)} pairs.")

    if failures:
        print("\nFAILED, resolve before shipping:")
        for pair_id, (song, artist) in failures:
            print(f"  {pair_id}: {artist} - {song}")
    else:
        print("All pairs resolved.")


if __name__ == "__main__":
    main()