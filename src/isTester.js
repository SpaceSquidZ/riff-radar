// src/isTester.js
//
// Distinguishes YOUR OWN testing sessions from real users, so the Supabase
// funnel isn't polluted by the person who built the thing.
//
// This was a real problem: an earlier funnel analysis showed 86 session_starts
// against only 9 moment_submitted, which looked like catastrophic 90% form
// abandonment. It wasn't. It was almost entirely Jackie reloading the page
// while debugging. Acting on that number as if it were user behavior would
// have sent the whole roadmap chasing a phantom.
//
// HOW TO USE IT:
//   - Test yourself with:  riff-radar-sigma.vercel.app/?tester=1
//   - Send real users the plain URL with no query param.
//   - Every event from a tester session carries is_tester: true, so you can
//     filter them out in SQL with `where (payload->>'is_tester') is null`.
//
// The flag is persisted in localStorage once set, so it survives navigation
// and reloads within the same browser. Clear it with ?tester=0.

const TESTER_KEY = 'riff_radar_is_tester';

function readParam() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('tester')) return null;
    const raw = params.get('tester');
    // ?tester=0 explicitly clears the flag, so you can un-mark a browser.
    return raw === '0' || raw === 'false' ? false : true;
  } catch {
    return null;
  }
}

let cached = null;

export function isTester() {
  if (cached !== null) return cached;

  const fromParam = readParam();

  if (fromParam !== null) {
    try {
      if (fromParam) {
        localStorage.setItem(TESTER_KEY, '1');
      } else {
        localStorage.removeItem(TESTER_KEY);
      }
    } catch {
      // localStorage can throw in private mode. The in-memory cache below
      // still works for this page load, which is good enough.
    }
    cached = fromParam;
    return cached;
  }

  try {
    cached = localStorage.getItem(TESTER_KEY) === '1';
  } catch {
    cached = false;
  }
  return cached;
}