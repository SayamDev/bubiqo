/**
 * Inline SVG marks.
 *
 * Inline rather than an icon library: three shapes do not justify a dependency,
 * and inline SVG inherits `currentColor`, so each one follows the theme without a
 * second set of tokens.
 *
 * All are decorative — every one sits beside text that already carries the
 * meaning — so they are aria-hidden and contribute nothing to the accessible name.
 */

interface MarkProps {
  readonly className?: string;
}

/**
 * The product mark: a ring with one point on it. A radar sweep that has found
 * exactly one thing, which is what Problem Radar is for.
 */
export function BubbleMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
      <circle cx="19" cy="21" r="11.5" stroke="currentColor" strokeWidth="2.5" opacity="0.45" />
      <circle cx="29" cy="11" r="5.5" fill="currentColor" />
    </svg>
  );
}

/** Quiet page: the same ring, with nothing found on it. */
export function QuietMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
      <circle cx="20" cy="20" r="12" stroke="currentColor" strokeWidth="2.5" opacity="0.35" />
      <circle cx="20" cy="20" r="3" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

/** A shield, for the line about nothing leaving the device. */
export function ShieldIcon({ className }: MarkProps) {
  return (
    <svg className={className} width="13" height="15" viewBox="0 0 13 15" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M6.5 1 1.5 3v4.2c0 3.2 2.1 5.6 5 6.8 2.9-1.2 5-3.6 5-6.8V3L6.5 1Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
