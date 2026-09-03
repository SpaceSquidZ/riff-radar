# Riff Radar — Decision Log

*Every closed decision, dated, with rationale. Closed means closed: if you want to reopen one, add a new entry superseding it rather than editing history. Doubles as the evidence trail for the case study.*

**Last updated:** 2026-09-01 — ported into the repo from the archival PDF; D-032 through D-039 added; D-031 status note added; D-020 superseded. D-040 through D-043 added; D-036 and D-038 amended; D-037 amended and closed.

> **Transcription note (2026-09-01).** D-001 → D-031 below were transcribed from
> `0720 NEW/Decision log.pdf`, which is an image-only PDF with no text layer. The wording is
> faithful but has not been machine-verified. **Keep the PDF as the archival original until
> this file has been spot-checked**, then retire it. `Case Study/riff_radar_decision_log.md`
> is a separate, older export ending at D-020 and should be retired regardless.

> **Repo note (2026-08-31).** This file is the canonical copy, per the maintenance note at
> the bottom of this document — written when the log was still a PDF outside version control,
> and not actioned until three ID collisions in one month made the cost of that concrete.
> Update it here going forward, not in the PDF or the retired Case Study export.

---

## Legend

**CLOSED** — decided, not to be relitigated · **OPEN** — decided in principle, details pending · **SUPERSEDED** — replaced by a later entry

---

## June 2026 — Foundation

### D-001 · Web app, not iOS or browser extension — **CLOSED**
**Decided:** June 2026
**Rationale:** Solo non-engineer on a three-month timeline. A web app is buildable with AI pair-coding, reaches unlimited users via a shareable URL, allows full analytics and outbound-click tracking, and gives recruiters a one-click artifact. iOS adds Swift, App Store review delay, and TestFlight install friction. A browser extension is desktop-only and "install my extension" is a worse interview ask than "click this link."
**Gave up:** Native feel, iOS-first form factor the original PRD assumed.

### D-002 · No Spotify OAuth in the core loop — **CLOSED**
**Decided:** June 2026
**Rationale:** Verified through live research that as of February 2026 new Spotify apps in Development Mode are capped at five authorized test users, the owner must hold Premium, and Extended Quota Mode requires a registered business plus 250,000 MAU. Building the PRD's synced-progress-bar centerpiece would mean building something five people could use, which kills the real-user-data goal entirely.
**Gave up:** The synced-bookmark mechanic that was the original PRD's centerpiece.
**Note:** This is the decision the whole portfolio narrative rests on.

### D-003 · No-auth search links as the streaming integration — **CLOSED**
**Decided:** June 2026
**Rationale:** Follows from D-002. Search links need no API, no OAuth, no quota, no Premium. Also answers Professor Yu's platform-dependency concern: if both services revoked access tomorrow, only the link-out breaks, and it is trivially swappable.

### D-004 · LLM reasoning replaces audio-feature matching — **CLOSED**
**Decided:** June 2026
**Rationale:** Spotify deprecated Audio Features, Audio Analysis, Recommendations, and Related Artists for all apps registered after November 27, 2024 — precisely the data the original PRD's similarity layer assumed. LLM musical reasoning is now the only viable path for a new entrant.

### D-005 · Vibe-code with Claude, not a no-code builder — **CLOSED**
**Decided:** June 2026
**Rationale:** Full control over the Vercel functions, the Supabase schema, and the exact Claude API call including prompt caching. Stronger portfolio narrative: "I built and own this architecture."
**Gave up:** Faster early momentum from Lovable or Bolt.

### D-006 · iTunes Search API for validation and previews — **CLOSED**
**Decided:** June 2026
**Rationale:** Free, no auth, returns 30-second previews, artwork, and metadata. Replaces the impossible "check Spotify search" hallucination guard with a platform-independent one.

---

## July 2026 — Build decisions

### D-007 · `effort: 'low'` on the Claude API call — **CLOSED**
**Decided:** July 2026
**Rationale:** Token-usage logging revealed Sonnet 5 was spending roughly 80–85% of output tokens on invisible extended thinking. Low effort cut that by about two-thirds with acceptable quality tradeoff.
**Evidence:** ~2,100 → ~930 output tokens per call.

### D-008 · Server-side event writes via service role key — **CLOSED**
**Decided:** July 2026 · **Shipped and verified:** July 22, 2026
**Rationale:** RLS enabled on `events`; `supabaseAdmin` client added. The remaining gap was that `session_start`, `outbound_click`, `preview_played`, `moment_submitted`, and `form_field_completed` still fired from the browser on the anon key, which is publicly visible and let anyone POST fake events into the table the entire portfolio funnel depends on.
**Implementation:** `logEvent()` in `supabaseClient.js` now branches. Server callers (`api/chat.js`) keep writing directly with the service role key. Browser callers POST to a new `/api/events` endpoint, which validates against an event-type allowlist and inserts server-side. `sendBeacon` is used for exit events so `outbound_click` survives navigation. No changes required to `App.jsx` or `MessageContent.jsx` — every call site already funnelled through `emit()`.
**Verified:** DevTools Network shows zero requests to `supabase.co` from the browser, and all `/api/events` POSTs return 202.
**Lesson:** the allowlist initially missed `form_field_completed`, which returns 400 rather than failing silently. Caught by HAR inspection. Any new event type must be added to `ALLOWED_EVENTS` in `api/events.js` or it will be rejected.

---

## July 2026 — Post-feedback strategic revision

*All entries below follow the first round of user feedback (Chris, Grace, Heather, Steven) and the strategic reevaluation it triggered.*

### D-009 · Riff Radar will not compete on recommendation accuracy — **CLOSED**
**Decided:** July 2026
**Rationale:** Verified that song-structure data has no commercial API since Spotify's Audio Analysis deprecation, and that BPM/key sources (AcousticBrainz frozen dump, GetSongBPM, Essentia.js on preview audio) are available but weak. More fundamentally: Spotify's recommendation quality comes from collaborative filtering over hundreds of millions of users' co-listening behavior, not from audio features — which is why they deprecated them. That gap is permanent and widening. Three of four reviewers independently asked "why not just use Spotify," and "our algorithm is better" loses that argument every time it is tested.
**Gave up:** The music-theory/structural-matching premise the original PRD implied.
**Supersedes:** The similarity-engine framing in PRD v3.2 §2.6.

### D-010 · Differentiation is persona + legibility, not retrieval — **CLOSED**
**Decided:** July 2026 · **Positioning line finalized:** late July 2026, after several rounds of revision
**Rationale:** What incumbents structurally will not ship: a recommendation that arrives with a reason, from a character with a story explored in return. Spotify has no incentive to explain itself, since an explanation is a falsifiable claim, and its business model rewards passivity.
**Positioning claim (final):** *"Riff Radar is the only music companion where you can explore music recommendations and get to know a persona with a rich backstory, instead of being handed answers by a plain, cold tool."*
**Revision notes:** earlier drafts used "argue with" and "someone," both rejected. "Argue with" framed the relationship as adversarial rather than exploratory. "Someone" left Groove's role unspecified. The final wording makes the mutuality explicit — the user explores recommendations, the user explores Groove, both are named — and states the mechanism ("a persona with a rich backstory") rather than only asserting the difference.
**Sharpened by:** D-021 (the novelty objective is the technical implementation of "explore," on the recommendation side).

### D-011 · Delete the structured moment form — **CLOSED**
**Decided:** July 2026
**Rationale:** The form was designed around what the system needed to ingest, not around what users are trying to do. Single biggest drop-off point across every reviewer. With a conversational agent, the conversation *is* the form.
**Replaced by:** Chat-first landing, Groove opens, single open input, input-track confirmation object, editable user messages.

### D-012 · Cut timestamps — **CLOSED**
**Decided:** July 2026
**Rationale:** Corroborated from four directions. No effect on recommendations. Users do not arrive knowing them. Obtaining one forces an exit-and-return loop. The capture UI was the largest single source of confusion.
**Replaced by:** Conversational structural hint. Groove asks whether it was the chorus or somewhere quieter, which carries real semantic signal (hook vs. release vs. departure) at no user cost.
**Note:** The moment-level premise survives. "3:20" was never the moment; it was clerical work offloaded onto the user.

### D-013 · Remove WaveSurfer — **CLOSED**
**Decided:** July 2026
**Rationale:** Its only function was pinning a timestamp on preview audio. Follows directly from D-012.

### D-014 · Remove YouTube entirely — **CLOSED**
**Decided:** July 2026
**Rationale:** YouTube existed solely to serve the timestamp mechanic. With D-012 that job is gone. Repositioning as a rec-card playback surface was considered and rejected: audio-only embedding violates YouTube's terms, embedding requires a video ID that would need YouTube Data API search (~100 searches/day on default quota), and the 30-second preview already covers evaluation. On the landing page it was a pure distraction surface, an exit ramp offered before any value had been delivered.

### D-015 · Drop the Last.fm-style stats tracker — **CLOSED**
**Decided:** July 2026
**Rationale:** Would require the streaming OAuth access already closed in D-002, and serves a small audience already served. Groove is a better return mechanism than statistics.
**Note:** Distinct from D-016.

### D-016 · Evaluate the Last.fm API as a grounding layer — **CLOSED**
**Decided:** July 2026 · **Spike run:** July 31, 2026
**Rationale:** Free, key-only, **no user authentication required for public reads** — users need no Last.fm account. `artist.getSimilar` returns a 0–1 similarity score derived from listening behavior; `track.getSimilar` is listening-based; top-tags endpoints give crowd vocabulary. This is behavioral signal the product currently has none of, and tags are the vocabulary users actually think in.

**Spike results (30 artists, spanning WIDE/SCENE and western/non-western/CJK):**

- **Scene coverage: 100% usable**, all 20 test artists returned ≥19 similar artists at a usable match score. Deepest cuts (Ata Kak, 0.199 mean match) still cleared the bar, though with visibly thinner data than well-known names.
- **Non-western and CJK coverage: 100% usable.** Best result in the entire test was 雷光夏 (Lei Guangxia), a Taiwanese indie/film-score artist with only 6,038 Last.fm listeners, at 0.845 mean match — real tagging depth on a niche regional scene, not just surface coverage.
- **Latency: median 0.43s, max 1.2s** for a getSimilar + getInfo pair. Against the 4s guardrail, iTunes validation remains the bottleneck, not this.

**Verdict: proceed to integration.** All three kill conditions (scene coverage, non-western coverage, latency) passed cleanly, not marginally.
**Licensing note:** Last.fm's API terms require commercial use to go through partners@last.fm; the free tier is for non-commercial use. Riff Radar is registered under this description: student project, no ads, no paid tiers. If the product is ever monetized, revisit licensing before continuing to use the API — either remove the integration or contact Last.fm for a commercial agreement at that point. Not a concern while the product remains non-commercial.
**Next step:** integration design — candidate pool grounding via `artist.getSimilar`, popularity banding via `artist.getInfo` listener counts, tag injection for reasoning context. Scoped to November per the original v2 roadmap; this decision only resolves feasibility.

### D-017 · Skip BPM/key metadata on rec cards — **CLOSED**
**Decided:** July 2026
**Rationale:** Adds credibility texture, not signal. D-016 is a better use of the same integration effort.
**Integrity constraint:** If it ever ships, it is labeled as track metadata, never presented as the matching basis. Do not market structural matching that is not performed.

### D-018 · Groove premise revised to distance and drift — **CLOSED**
**Decided:** July 2026 *(was OPEN; closed with Lore Bible v2.1)*
**Final premise:** Groove was a salvage scholar who recovered the Voyager golden record, followed it back toward Earth, never arrived, lost his lover on the way, and now drifts, listening to Earth radio on a receiver he built. **The signal takes years to cross, so everything he hears has already happened.** He found a channel that runs the wrong way and takes no time, and cannot explain it.
**Rationale:** (1) Distance gives an in-fiction explanation for the model's knowledge cutoff and occasional weak recommendations. (2) It shifts the central mystery from "what are you" — a yes/no that must be dodged forever, which is exactly why the deflection pools read cold — to "what happened," a story tellable in pieces, warmly. (3) It gives the user a role rather than a customer relationship.
**Constraints held:** Groove stays musically authoritative ("every recording, none of the rooms"). Humanity's fate stays unconfirmed. No hard era-locking.
**Superseded from v1:** Earth-orbit defector, forbidden music, resonant-synchronization danger mechanism, enforcement structures, the living human contact who supplied physical media.
**Note:** A time-machine framing was proposed first and rejected in favour of distance, which achieves the same effect with less machinery. Origin of the distance version: Jackie.

### D-019 · Connection strength replaces raw session count — **OPEN**
**Decided in principle:** July 2026
**Rationale:** A counter that rises because time passed is mechanically inert. Connection strength grows from distinct days visited, tracks discussed, and questions from Groove actually answered, with a per-day cap. The cap plus the distinct-day requirement is the anti-gaming design: it cannot be sprinted in one night, but genuine engagement outpaces repeated bouncing.
**In-fiction:** strength is the channel clearing, and what becomes legible is partly evidence of the lover. The meter and the plot are the same object.
**Status:** Thresholds in `groovePrompt.js` are placeholders and must be tuned against real session-distribution data. Depends on accounts (November).

### D-020 · Ship a dated v1 in August regardless — **SUPERSEDED, see below**
**Decided:** July 2026
**Rationale:** "In progress since June" with nothing shipped is weaker than either a clean launch or a documented iteration. "v1 August → research → v2 November" is the strongest of the three because it demonstrates iteration on evidence rather than a single act of building.
**v2 target:** November 2026.
**Status (2026-08-31):** Superseded — ship date moved to 20 September 2026. See D-020 SUPERSEDED entry at the end of this log for the full rationale.

---

## July 2026 — Recommendation and character architecture

### D-021 · Optimize for the unheard, not the likely-to-be-played — **CLOSED**
**Decided:** July 2026
**Rationale:** Sharpens D-010 from an interaction claim into an objective-function claim. Spotify optimizes for likely-to-be-played, which biases toward the familiar and popular and is reinforced by commercial relationships that make suppressing well-known artists a non-starter. Riff Radar can optimize for **unlikely to have been heard, likely to be loved.** Same behavioral signal underneath, opposite goal. This does not reopen D-009: it is not a claim of better retrieval, it is a different target.
**Implementation:** popularity band on the candidate pool favouring artists well regarded inside a scene and unknown outside it. Co-listening graph via Last.fm (D-016); novelty subtraction via conversation history, Groove's own questions, or an optional public-profile import.
**Metric:** novelty rate, the share of recommendations self-reported new to the user. Nobody else reports this, it maps directly to the value proposition, and Spotify structurally cannot claim it.
**Origin:** Jackie, from the Xiami collaborative-filtering-with-novelty-penalty model.

### D-022 · Named connection types replace the three fixed axes — **CLOSED**
**Decided:** July 2026
**Rationale:** The v3 structure (structural twin / adjacent genre / surprise) rested on structural matching that D-009 establishes we cannot perform. "Structural twin" was an unbackable claim, "adjacent genre" was too vague for a user to evaluate, and "surprise" invited randomness. Replaced with five types Groove names explicitly: **same hand, lineage, same move, same scene, same mechanism**, each with a guard against degrading into vibes. Same mechanism carries a hard test: the operation must be stateable in one sentence without naming either song.
**DISTANT is a tag, never a type.** A far-away song with no connection underneath is noise, not a recommendation.
**Why better:** every type is something an LLM genuinely knows and a user can verify or dispute. The label becomes the arguable part, which is the positioning made literal.
**Constraint:** the three surfaced recommendations must use three different types.
**Status (2026-08-29):** The "three different types" constraint is no longer absolute — see D-032, which established a fixed yield order for when Groove can't fill three slots.

### D-023 · Six candidates generated, best three surfaced — **CLOSED**
**Decided:** July 2026
**Rationale:** Chris received responses containing only one or two recommendations. Cause: Groove generated three, iTunes validation dropped one, nothing backfilled. Decoupling generation from display means a single validation failure stops mattering — four of six would have to fail before the user notices.
**"Best" is Groove's own ranking**, filtered by set constraints, not a scoring heuristic. A heuristic would be quietly rebuilding a ranking algorithm, which is precisely what D-009 says we are not doing.
**Auditable:** log rank alongside engagement, then test whether rank-1 picks outperform rank-3. If they do not, ordering is noise and gets dropped. Strong candidate for the documented data-driven iteration.
**Cost:** doubles iTunes connection count. **Mitigations:** cache by normalized artist+track in Supabase; fallback-chain only the candidates that fail the primary store; fire validation during Groove's opening paragraph so the wait is hidden.
**Rule:** Groove never states a number. "Pulling a few records" is correct and stays.

### D-024 · "Second listen" connection type deferred to November — **CLOSED**
**Decided:** July 2026
**Rationale:** The sixth type — Groove offering a different reading of what actually moved the user — is the highest-variance item in the set: excellent when it lands, insulting when it misses. It needs rapport, which needs memory, which needs accounts. Ship five types in v1.
**Fences required when it ships:** never in the first exchange of a session; never when the user has shared something personal or emotional about the moment; always hedged to his own perception ("might be my ears"); at most once per session and not every session; the track must stand alone if the premise is rejected; concede immediately if challenged.

### D-025 · Groove opens first with two records — **CLOSED**
**Decided:** July 2026
**Rationale:** Solves cold start. A blank input demands the user arrive with a reference track, which is homework. Reacting is a lower bar than producing, and reaction is better data than production ("not that one, too slow" tells you more than a song title). Also makes Groove the first thing anyone meets, solving intake friction and character invisibility with one change.
**Two records, not three:** three is the recommendation signature, and reusing it collapses the distinction between "what I have on" and "what I found for you." Two is what someone actually has on; three is a set assembled for you. Two also fits a phone screen before any context exists.
**Curated rotating pool, not generated.** Session-one hallucination does the most damage.
**Pairs, not a flat list of 30.** Random pairing from a flat list produces incoherent combinations, and incoherence on turn one reads as no taste — the opposite of the required first impression.
**Pool:** 15 pairs in `groove_opener_pairs.md`. **All 30 tracks validated against iTunes July 2026** (29/30 passed on first pass; Ka's "Off the Record" was not indexed under that album and was swapped to "Old Justice," same artist/album/era, confirmed by direct query). Faye Wong replaced with Sandee Chan 陳珊妮 — "來不及" (1999), confirmed too well-known for the tier-2 slot; Chan's track validated cleanly against the original 1999 release.

### D-026 · Log entries are catalogue files, not memoir — **CLOSED**
**Decided:** July 2026
**Rationale:** A first-person retelling of the public brief is a paraphrase, not a reward. The Transmission Log must contain **what the legend leaves out.** The brief says he lost someone; a Log entry never repeats that, but catalogues an object of hers with a condition note that gives everything away without naming it.
**Format:** he classifies things for a living, so his private records are files in his professional format applied to things that do not deserve the format. Salvage logs, ship logs, translation working notes, pressing logs, observation files. The deadpan is what makes it land.
**Two acquisition modes:** spoken fragments (he chose to tell you) and recovered entries (arrived on their own as the channel cleared). Roughly 60/40 toward recovered, so the Log feels found rather than dispensed.
**Locked slots read as reception failure, never permission denial.** Static, not padlocks. A padlock says *you have not earned this*; static says *it is out there and has not reached you yet.*
**Retired:** the first-person "Version C" essay. Its voice survives inside the entries, which is where it belonged.

### D-027 · Log ordered by emotional cost, not chronology — **CLOSED**
**Decided:** July 2026
**Rationale:** Losing her happens in the middle of the story and is the most expensive thing he could say, so it arrives near the end of the arc. Order: the work (no cost) → the record (low) → went looking and did not arrive (medium) → everything he hears is already over (medium-high) → he got lonely (high) → he lost someone (highest). The channel sits outside the arc and surfaces whenever the conversation earns it.
**Consequence:** a user who quits at stage 2 met an enthusiast; one who stays to stage 6 met a person. That difference is the product.

### D-028 · Size the Log to the retention curve; never ship the ending — **CLOSED**
**Decided:** July 2026
**Rationale:** CLV is the wrong instrument, since there is no revenue to discount. What matters is the **session-count distribution by percentile**, which is not yet measured. Ship v1 with roughly 8 entries, instrument the distribution, then extend. Writing 20 for an unmeasured curve wastes most of them.
**Curve, not count.** Front-load hard: the first 3 entries land within 2–3 sessions and must be enough to prove a collection exists. Roughly 20 eventual, with the first 3 doing most of the work.
**Two constraints:** never gate on time alone (D-019 handles this — a user who talks for an hour should outpace one who opens the tab and leaves); always show the horizon, since users tolerate an unresolved ending but not suspecting there was never an answer.
**Completion risk:** content-gated retention breaks at completion. Whoever finishes the Log has mechanically finished the product. This is the strongest argument for keeping the true ending deferred indefinitely and treating the Log as a growing archive rather than a fixed set with a final slot.

---

## July 2026 — Wave 2 intake rebuild

### D-029 · The species name exists but does not translate — **CLOSED**
**Decided:** July 2026
**Rationale:** Once Groove refers to users as "humans" precisely rather than generically, he has a word for their kind and apparently none for his own. Leaving it unnamed reads as an authorial oversight; naming it plainly undersells the strangeness and spends something for nothing. Instead the word exists and fails to survive his self-built translator, rendering as literal garbling on screen: *"There's a word for what I am. It comes through as ▮▩▮▩ when I put it through the translator, so I stopped using it."*
**Why this beats a dodge:** it is a real answer to a direct question, which §14 requires, while keeping the actual name in reserve. It is also consistent with the translator already being homemade and imperfect.
**Deferred:** the actual name, and whether it is ever revealed. Same tier as the lover's status.
**Origin:** Jackie proposed the garbling.

### D-030 · The first-contact opener is static, hand-written, and never generated — **CLOSED**
**Decided:** July 2026
**Rationale:** The opener's whole effect depends on Groove noticing his own clumsiness *gracefully*. A generated version that notices it clumsily reads as broken rather than charming, and there is no prompt instruction that reliably prevents that. Model variance on the single highest-stakes screen in the product is not a risk worth taking.
**Second reason:** a generated opener means an API call on every page load. Three to five seconds before anything appears, paid for on every bounce, on the screen where bounce rate is highest.
**Consequence:** Groove's first API call happens when the user actually replies, not on load. The opener renders instantly.
**Copy locked in:** Lore Bible §0b (first contact) and §0c (return visits).
**Note:** the return-visit opener is a separate script. Replaying first contact would have Groove failing to remember the most significant thing that has ever happened to him.

### D-031 · No gate before the conversation; consent moves to a side panel — **CLOSED**
**Decided:** July 2026
**Rationale:** The app currently opens on `LandingScreen`, which carries the data-collection notice and requires a click to pass. That is an extra click before any value has been delivered, on the screen with the highest drop-off — and consent is the least valuable click a user can be asked for. Feedback from Birju: 多了一个点击 = 用户流失.
**Implementation:** the `landing` phase is removed. The app opens directly into the conversation with Groove's opener already flowing. The data-collection notice moves into the left panel as a visible, non-blocking card, collapsible after reading.
**What this does not change:** the notice is still shown before any meaningful interaction, and the "no thanks" path must still actually disable logging rather than merely hiding the card (PRD v4.0 §9).

**STATUS NOTE (added 2026-08-31):** Closed July 2026 as implemented; it was not. Verified against the actual code: the opener was still gated behind consent dismissal (`if (showConsent) return;`, directly contradicting an adjacent comment claiming otherwise), the panel was never built (notice rendered as a fixed bottom bar), and the decline path did not exist at all — `ConsentBanner` had no decline handler and `emit()` never checked any consent flag before logging. A decision marked closed with none of its three requirements in the code is the gap the repo move to a visible Decision Log exists to catch. Long-term, the notice belongs in a settings surface rather than a drawer; deferred until accounts create one.

---

## Still open

| ID | Question | Blocks |
|---|---|---|
| D-019 | Connection-strength formula and per-day cap tuning | Transmission Log pacing |
| D-036 | Withhold WIDE-tier top tracks entirely, or send tracks 5–10 instead of 1–5 | Pool grounding for mainstream artists |
| — | Session-only crate in August, or defer to November? Decision deferred to end of Week 4: build only if intake rebuild finishes on schedule or early. | August scope |
| — | Whether the arc's true ending ever ships | See D-028 completion risk |

---

## August 2026 — Recommendation quality and thinking-arm resolution

### D-032 · What bends, and in what order, when Groove can't fill three slots — **CLOSED**
**Decided:** 2026-08-29
**Decision:** Rules yield in a fixed order. Verification never bends: nothing unvalidated ships, in any pass. Groove always speaks — a turn never renders empty. The three-different-types rule bends first; two cards sharing a type beats one lonely card. The WIDE-tier quota never bends; show two cards rather than three mainstream ones. An artist the listener named by name is not a repeat. And a shortfall is spoken in character, never as a rule or a limit.
**Rationale:** Before this, a shortfall did something different every time — sometimes a lone card, sometimes an empty reply, sometimes Groove naming a database constraint out loud. One turn in seven delivered the intended experience. Making the yield order explicit turns three symptoms into one governed behaviour.
**Gave up:** D-022's "three different connection types" as an absolute. It now bends first, deliberately, because a second card of the same type is worth more to a listener than a single card and an apology.

### D-033 · Shortfall is spoken in character; the app is never named — **CLOSED**
**Decided:** 2026-08-29
**Decision:** When fewer than three cards surface, Groove acknowledges it in his own register. He may never reference the app, a rule, a session, a limit, or a repeat, in any phrasing. If the reply would render empty, he says something short and varied instead of nothing.
**Rationale:** Test 1 produced "the app won't let me repeat an artist once used" after being asked three times for the same artist, and one turn rendered with zero characters. Both break the fiction in the same way — they reveal machinery. D-026 already held the principle for locked slots ("static, not padlocks"); this extends it to every shortfall.
**Gave up:** the ability to explain ourselves. When Groove can't do something the listener asked for, he can't say why. Some users will read that as evasion rather than character.

### D-034 · Validation failure is a generation problem, not a lookup problem — **CLOSED**
**Decided:** 2026-08-30
**Decision:** Treat zero-validation turns as hallucinated track titles and fix them by constraining generation. Close MusicBrainz and Discogs as a validation fallback.
**Rationale:** Roughly 20 of 119 not_found tracks were checked by hand against iTunes, including full-catalogue artist searches returning 195 Danny Brown tracks and 89 Earl Sweatshirt tracks. None of the recommended titles appeared. Turns reaching pool=6/6 still returned validated_ok=0, so the pool was constraining artists and not titles — exactly as lastfm.js's own header comment warned it would.
**Gave up:** three days to cache-poisoning, query-construction and catalogue-coverage theories, each argued confidently from a single example. The measurement that settled it took forty minutes and should have come first.

### D-035 · The candidate pool supplies artist+track pairs, not artist names — **CLOSED**
**Decided:** 2026-08-30
**Decision:** `getCandidatePool` fetches each pool artist's top tracks and the prompt lists them per artist. The pool constrains the candidate set; Groove still supplies the judgment about which pairs are worth recommending and why. Last.fm's ordering is never used for ranking.
**Rationale:** D-016 established the pool to stop Groove pattern-completing artist names in thin scenes. It worked for artists and did nothing for titles. Extending the same principle one level down was the smallest change that could address D-034.
**Gave up:** nothing structural — but the fix only works with D-038. With thinking enabled, Groove took the artists from the pool and invented titles anyway.

### D-036 · Famous artists get no track list from the pool — **OPEN, needs confirmation**
**Decided:** 2026-08-30
**Decision:** Artists above the WIDE threshold (1,000,000 listeners) are sent to the prompt as a name only. Their top tracks are withheld.
**Rationale:** Last.fm's "top tracks" means most-played. For a WIDE-tier artist that is the hit — Radiohead's is "Creep." Handing Groove that list makes the one mainstream slot per turn surface the most obvious possible record, which is precisely what D-021 exists to prevent.
**Gave up:** verification on that one card. Picking from his own knowledge is where Groove invents titles, so this knowingly accepts a little hallucination risk back on one slot per turn in exchange for not recommending the obvious.
**Open question:** as written above, or the middle version — send tracks 5–10 instead of 1–5, still real, still verified, past the hits. That gets grounding and novelty, and costs about a third of a day. Preference stated: the middle version, deferred to v1.1 if the Sep 6 freeze is tight.

**AMENDMENT (2026-09-01) — the approved middle version was tested and failed.** Replaces the decision. WIDE-tier artists (above 1,000,000 listeners) receive their **full verified track list** from the pool. The constraint against recommending the obvious hit moves from the data layer to the prompt.

**Rationale.** The approved middle version — send tracks 5–10 as a percentage band of the top track's playcount — was measured across six artists and failed structurally, twice.

*Non-monotonic curves.* Kendrick Lamar's rank 5 outplays his rank 1; Radiohead and Jaurim both show rank 10 beating rank 5. A percentage band applied to a bumpy curve selects unpredictably rather than selectively.

*Tag fragmentation at track level.* Last.fm splits scrobbles across title spellings the same way it splits them across artist names. プラスティック・ラブ sits at 5.9% of rank 1 and プラスティック・ラヴ at 1.4% — and both are Plastic Love, which is rank 1. A band built to exclude the single obvious hit would have selected that hit three times over, specifically for non-Latin-script catalogues. That is the population D-021 exists to serve, so the failure lands hardest exactly where the feature matters most.

Deduplicating those titles is the D-040 canonicalization problem one level down, and solving it properly means a MusicBrainz *recordings* integration — larger than the artist resolver, for a refinement affecting one slot on famous artists, five days from freeze.

**Gave up (amendment):** a guarantee. A prompt rule can be disobeyed where a data filter cannot. Accepted because this failure is *visible* — Groove names the hit and we can see it — where the band's failure was silent, reporting success while grounding on a mis-tagged duplicate of the hit. Adherence is measured directly: five WIDE-tier seeds, counting how often the surfaced mainstream slot is the artist's rank-1 track.

### D-037 · Playability, not existence, is the shipping constraint — and a track we can't play is a find, not a failure — **CLOSED**
**Decided:** 2026-08-31
**Decision:** Playable tracks fill the three slots first. Where fewer than three are available, at most one unplayable track may fill a slot, presented as something worth going after rather than something we failed to deliver. It carries no preview and no artwork, but it must always carry a real destination.
**Rationale:** Of 100 real, Last.fm-charted tracks from an underground rap pool, only 32% exist on Apple Music. D-006 chose iTunes for the preview and the artwork, so two thirds of genuinely good recommendations currently cannot become a card. Staying silent about them is the worst available failure: a listener expects a music product to know underground music, and silence reads as ignorance rather than caution. D-026 already frames absence as reception failure rather than permission denial — a record that exists but can't be pulled in clean is that principle made literal. And since a track absent from Apple Music is, more often than not, more obscure than one present, the unplayable card is arguably the pick that best serves D-021 rather than the one that fails it.
**Gave up:** AC-9 as written ("a visitor can hear a preview without leaving the page") now holds for most cards rather than all. That criterion must be amended before UAT or the round will record a Blocker against a deliberate design decision.
**Open question:** confirm the one-card cap and the "must land somewhere" requirement, and amend AC-9.

**AMENDMENT (2026-09-01) — hunt-card eligibility is narrower than "unplayable."** Only `not_found` is eligible for a hunt card.

`wrong_title` is **excluded**. It is D-034's hallucination signature, and presenting an invented track as worth the dig converts a hallucination into an errand — it sends a listener out looking for a record that does not exist, which is a worse failure than surfacing nothing. `unconfirmed` is excluded per D-043: a network failure is not evidence that a track is real.

The card promises a record exists and is worth finding. That promise is only honest for a candidate we validated as real and merely absent from Apple Music.

### D-038 · Extended thinking is disabled — **CLOSED**
**Decided:** 2026-08-31
**Decision:** `thinking` is set explicitly to disabled in code, not by environment variable. `max_tokens` raised from 4096 to 8000.
**Rationale:** Thinking was running by default and nobody had chosen it. It consumed 34% of each turn's output tokens and gated all visible text, so a listener watched a blank screen and then received everything at once. Two arms were run on one deployment and 22 cards were rated blind against a decision rule written before any rating: 2.18 / 2.17 / 2.20. Two independent control samples landing 0.01 apart is what makes the comparison trustworthy. Quality unchanged, a third of the wait removed. Separately, the shared 4096 ceiling was the root cause of the blank turns D-033 had to patch around.
**Gave up:** an unknown amount of reasoning quality that 22 cards cannot detect. A small sample can rule out a large regression, not a small one. The decision is reversible in one line if UAT reports the writing has flattened.

**AMENDMENT (2026-09-01) — the blank-turn root cause claim was incomplete.** The entry records the shared 4096 `max_tokens` ceiling as "the root cause of the blank turns D-033 had to patch around." **That is incomplete.** Two blank turns were reproduced at `max_tokens=8000`, using 805 and 821 output tokens with `stop_reason=end_turn` — nowhere near any ceiling.

Tracing at three points (post-API, post-extraction, pre-client) showed the recommendation marker at character zero of the response. No prose was discarded because none was generated. The 4096 ceiling was *a* cause, on the original evidence; it was not the only one. The remaining cause is model behaviour and is addressed in D-041.

Everything else in D-038 stands — the thinking measurement, the blind rating, the decision rule.

### D-039 · max_tokens raised from 4096 to 8000 — **CLOSED**
**Decided:** 2026-08-31
**Decision:** The per-turn output ceiling goes from 4096 to 8000 tokens.
**Rationale:** 4096 was shared between thinking, visible prose and the candidate JSON, and was the direct cause of the blank turns D-033 had to patch around — the model occasionally spent the whole allowance reasoning and had nothing left to emit. The largest output observed across all testing was 2,284 tokens, so 8000 leaves roughly 3.5× headroom.
**Gave up:** a tight circuit breaker. At roughly 10ms per output token the old ceiling capped a runaway turn near 40 seconds; the new one caps it near 80. Chosen deliberately over 16000, which would have removed the brake altogether.

### D-020 SUPERSEDED · Ship date moves to 20 September 2026
**Date of supersede:** 2026-08-31
**Decision:** Ship date moves to 20 September 2026. Third date; Aug 31 → Sep 13 → Sep 20.
**Rationale:** Sep 13 placed user testing in the same week as launch, leaving no window to act on what it found — which makes the round a ceremony rather than a test. Sep 20 buys a real one: feature freeze the 6th, pilot the 7th, four sessions the 8th–9th, triage the 10th, a reserved fix block to the 16th, confirmation pass the 17th.
**Gave up:** a week. Recorded here so the movement reads as a decision rather than drift. This is the last one.

### D-040 · A Last.fm artist is a tag string, not an artist — **CLOSED**
**Decided:** 2026-09-01
**Decision:** When `artist.getSimilar` returns an empty graph, resolve the artist through MusicBrainz and retry by MBID. If MusicBrainz fails, is unreachable, or yields no usable graph, return an empty pool rather than a substitute.
**Rationale:** Last.fm accumulates a co-listening graph per **exact scrobbled tag string**. "Mariya Takeuchi" and 竹内まりや are separate records with disjoint graphs, and `autocorrect=1` does not bridge them — `@attr.artist` came back unchanged, meaning Last.fm does not treat this as an alias relationship at all.

Three string-based approaches were tested and all three failed:

| Approach | Outcome |
|---|---|
| `autocorrect=1` | No correction applied. Graph still empty. |
| `artist.search` + first non-empty graph | Would have selected **Marika Takeuchi**, a Boston contemporary classical pianist, with a full 100-artist graph. |
| containment + largest graph | Selected `"Mariya Takeuchi • From Smart Shuffle"` — 86 listeners, no MBID, 100-artist graph overlapping the real one by 11. |

Two things make this unfixable by string matching. **A tag with 86 listeners returns a response indistinguishable in shape from one with 35,820** — graph size carries no information about legitimacy. And containment was *structurally* incapable of succeeding: the correct record is the bare 竹内まりや, which does not contain the romanized string at any tuning, so it was never in the candidate set.

MusicBrainz returned the correct entity on the first query, with "Mariya Takeuchi" present in its own alias array, and `getSimilar` by MBID matched the ground-truth graph **100 of 100**.

**Also recorded, because it bounds the problem:** nine of ten deliberately-chosen likely-split artists resolved directly with no fallback — Korean, Cyrillic, Chinese, Icelandic diacritics, and both all-caps and all-lowercase stylizations. This is a narrow exception, not a systemic failure of non-Latin catalogues, and the earlier assumption that it was systemic was wrong.
**Gave up:** a hard dependency on a third external API, which was observed to be down during its own construction. Contained by a 2-second `AbortController` timeout, an MBID cache, invocation on the miss path only, and fail-closed behaviour verified against that real outage. An empty pool is a state the system already handles and reports; a wrong pool is silent corruption that would surface weeks later as "the recommendations got strange," with no log line to explain it.

### D-041 · Every turn opens with at least one sentence — **CLOSED**
**Decided:** 2026-09-01
**Decision:** The prompt requires a minimum of one sentence of Groove's own words before any recommendations, with no exception for short or repeated requests. The existing three-sentence maximum is unchanged — this adds a floor, not a new ceiling.
**Rationale:** Blank turns were traced to the model emitting the recommendation marker at character zero, skipping its opening entirely. It happened on terse repeat follow-ups — "more please", "anything else in that vein" — where the model appears to treat itself as having already spoken. The prompt capped prose but never required it. Terse repeat follow-ups are precisely what UAT testers produce, and in the 01 Sep city pop session this made the user retype their message twice in a row.
**Gave up:** nothing measurable. D-033's fallback stays in place as a net for genuinely empty responses, and its firing rate now doubles as the signal that this rule is not holding.

### D-042 · An empty pool is disclosed to the model — **CLOSED**
**Decided:** 2026-09-01
**Decision:** When `pool_size` is 0, the turn context states that no verified track list is available and instructs Groove to prefer fewer, surer picks over filling every slot.
**Rationale:** Groove had no way to distinguish an empty pool from a thin one, and filled the gap by inventing. Of eight measured `wrong_title` cases, **zero** were transliteration near-misses — every one was a plausible-sounding title with no resemblance to anything in the artist's actual catalogue, including "Poison" attributed to both Bebe Winans and Bebe Rexha in the same session. That is D-034's mechanism, and its trigger is an ungrounded turn. Telling the model about its own grounding state is cheaper than any matching-logic change and aims at the cause rather than the symptom.
**Gave up:** card count on ungrounded turns, deliberately. D-037's hunt card absorbs part of the shortfall, and a thin turn that is honest beats a full turn that is invented.

### D-043 · An unconfirmed validation result is unshippable — **CLOSED**
**Decided:** 2026-09-01
**Decision:** `unconfirmed` joins the unshippable validation set. It cannot surface as an ordinary card, and it is not eligible for a hunt card.
**Rationale:** A candidate that hit a transient iTunes network failure was passing the shippability check and surfacing as a normal card with no artwork, no preview and no Apple Music link — visibly broken rather than excluded, falling through the gap between the ordinary path and the hunt path. Found by a test written for D-037 against a pre-existing defect.
**Gave up:** nothing. This was a bug.

---

## Maintenance note

**This log does not update itself.** There is no background process. It gets updated when explicitly requested at the end of a decision-heavy working session. Recommended practice: keep it in the repo alongside the code so it is versioned with what it describes, and re-upload to project knowledge whenever it changes materially.

**Actioned 2026-08-31.** This recommendation sat unactioned for over a month while the log lived only as a PDF outside version control. Three ID collisions in August traced directly to that gap — nobody could grep the log before assigning the next number. It is now in the repo at `docs/decision-log.md`. Update it here.
