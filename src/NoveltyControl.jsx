// src/NoveltyControl.jsx
//
// Brief K1. Feeds risk R1's novelty-rate metric -- one tap, never required,
// never blocking, never a modal.
//
// Shared by RecommendationCard and HuntCard despite HuntCard.jsx's own
// comment arguing against sharing logic between the two: that comment is
// about NOT threading hunt-specific conditionals through the shared card
// body. This control doesn't differ between the two card types at all (the
// brief calls hunt cards eligible, arguably the most interesting ones), so
// duplicating it would just be two copies of the same JSX.
export default function NoveltyControl({ novelty, onReport }) {
  return (
    <div className="rec-novelty-row">
      <span className="rec-novelty-prompt">Heard this before?</span>
      <button
        type="button"
        className={`rec-novelty-btn${novelty === 'new' ? ' rec-novelty-btn-selected' : ''}`}
        onClick={() => onReport('new')}
        aria-pressed={novelty === 'new'}
      >
        New to me
      </button>
      <button
        type="button"
        className={`rec-novelty-btn${novelty === 'known' ? ' rec-novelty-btn-selected' : ''}`}
        onClick={() => onReport('known')}
        aria-pressed={novelty === 'known'}
      >
        Knew it
      </button>
    </div>
  );
}
