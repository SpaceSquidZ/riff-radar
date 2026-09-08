// src/GrooveBackstory.jsx
//
// §4c (this one lettered separately from the card-geometry §4c -- both
// briefs used the same section number independently). Lore Bible v2.1,
// §0, "The public brief (Locked text — website copy)": the one piece of
// lore stated plainly to users, sitting on the website as a background
// story. It is not spoken by Groove and never appears in conversation --
// which is exactly why this is its own overlay, not a chat bubble or a
// card. Text is locked: verbatim, no heading, no tightening, no
// modernising. If the copy ever needs to change, that is a Lore Bible
// edit, not a layout one.
//
// THIRD PERSON, NOT HIS VOICE. No avatar, no quote marks, no "from
// Groove," nothing in the render that attributes this to him as
// something he said or wrote. It reads as a legend ABOUT him, which is
// what the Lore Bible calls it.
//
// Not §17 (the Transmission Log). That's the collectible layer and needs
// accounts; this is static, unlocked, always-available background.
//
// An overlay, not a route: the conversation stays mounted underneath so
// nothing is lost and no state resets on open or close. Dismisses on the
// close control, backdrop click, or Escape -- unlike ConsentPanel, which
// deliberately removed exactly those two paths (D-031/the 06 Sep fix):
// that was a decision needing a real choice recorded; this is a page
// someone is reading, and an accidental dismiss costs nothing but a second
// click to reopen. No persistent tab afterwards, same rule as the privacy
// notice -- the header affordance that opens this is the only entry point,
// permanently, and closing this never spawns a second one.

import { useEffect } from 'react';

export default function GrooveBackstory({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="backstory-overlay" onClick={onClose} aria-hidden={!open}>
      <div
        className="backstory-panel"
        role="dialog"
        aria-modal="true"
        aria-label="About Groove"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="backstory-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>

        <div className="backstory-body">
          <p>There is a scholar at the far end of the sky who looks something like a squid.</p>

          <p>His work is patient and unglamorous. The universe sheds things, and he collects them. Hull fragments. Dead satellites. Signals with no sender left alive. He catalogues what he finds and files it away, and for a long time that was enough.</p>

          <p>Then he found the golden record.</p>

          <p>Humans had made it and thrown it into the dark, on the chance that something out there might be listening. Their music was cut into its surface. He had spent his life among objects that had stopped mattering to anyone, and this one went through him like weather. Nothing on his world had ever done that.</p>

          <p>He wanted more of it. So he turned the ship around and worked backward along the record's path, toward wherever it had been thrown from.</p>

          <p>He did not arrive. The distance was longer than the plan. Somewhere in the middle of it he lost the one he loved, and after that he lost the direction too, and out there is nothing to steer by.</p>

          <p>Now he drifts, and he listens. He built himself a receiver, and it pulls in Earth's radio, though the signal takes years to cross. The world he hears is always a world that has already happened. He knows a century of human music and has never once heard any of it live. He learned it the way you would learn a language from letters arriving out of order.</p>

          <p>He wanted, very badly, to talk to someone.</p>

          <p>Then he found the channel. He does not know what it is or who left it open. It runs the wrong way, toward Earth rather than away from it, and it does not take years. Whatever he sends arrives the moment he sends it. He cannot explain that. He only knows it was there, and still working.</p>

          <p>He said something into it.</p>

          <p>You are the first one who said anything back.</p>
        </div>
      </div>
    </div>
  );
}
