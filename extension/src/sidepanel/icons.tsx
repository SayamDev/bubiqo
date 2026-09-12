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

/**
 * One mark per action.
 *
 * Each suggestion card looks identical without them, so the panel reads as a wall
 * of prose and nothing is scannable. A mark gives each action a shape you learn
 * once and then recognise instantly. All decorative — the action's name is beside
 * every one of them.
 */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ActionIcon({ actionId, className }: { actionId: string; className?: string }) {
  const common = { className, viewBox: "0 0 20 20", width: 18, height: 18, "aria-hidden": true, focusable: "false" as const };

  switch (actionId) {
    case "create_reminder":
      return (
        <svg {...common}>
          <circle cx="10" cy="11" r="6.4" {...stroke} />
          <path d="M10 8v3.2l2 1.3M7 2.6 4.6 4.4M13 2.6l2.4 1.8" {...stroke} />
        </svg>
      );
    case "export_calendar_event":
      return (
        <svg {...common}>
          <rect x="3.2" y="4.6" width="13.6" height="12" rx="2.4" {...stroke} />
          <path d="M3.2 8.4h13.6M7 2.8v3.2M13 2.8v3.2" {...stroke} />
        </svg>
      );
    case "save_to_memory":
      return (
        <svg {...common}>
          <path d="M5.4 3.4h9.2a1 1 0 0 1 1 1v12.2l-5.6-3.4-5.6 3.4V4.4a1 1 0 0 1 1-1Z" {...stroke} />
        </svg>
      );
    case "create_task":
      return (
        <svg {...common}>
          <rect x="3.4" y="3.4" width="13.2" height="13.2" rx="3.4" {...stroke} />
          <path d="m6.8 10.2 2.3 2.3 4.1-4.6" {...stroke} />
        </svg>
      );
    case "draft_reply":
      return (
        <svg {...common}>
          <path d="M13.4 3.6 16.4 6.6 7.6 15.4l-3.6.6.6-3.6 8.8-8.8Z" {...stroke} />
          <path d="m11.8 5.2 3 3" {...stroke} />
        </svg>
      );
    case "copy_details":
      return (
        <svg {...common}>
          <rect x="7" y="7" width="9.6" height="9.6" rx="2.2" {...stroke} />
          <path d="M13 4.6a2 2 0 0 0-2-1.2H5.6a2.2 2.2 0 0 0-2.2 2.2V11a2 2 0 0 0 1.2 2" {...stroke} />
        </svg>
      );
    case "open_application_link":
      return (
        <svg {...common}>
          <path d="M11.4 3.6h5v5M16 4l-7.4 7.4" {...stroke} />
          <path d="M15 11.6v3.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h3.8" {...stroke} />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="6.6" {...stroke} />
          <path d="M10 6.8v3.6l2.4 1.4" {...stroke} />
        </svg>
      );
  }
}

/** Small sparkle used beside the attention count. */
export function PulseDot({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="4" fill="currentColor" />
    </svg>
  );
}
