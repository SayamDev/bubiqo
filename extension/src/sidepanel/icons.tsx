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

/**
 * The header artwork.
 *
 * The product mark, drawn large and faint behind the headline: concentric rings
 * with one point found on them. It is the same idea as the favicon and the same
 * idea as Problem Radar, so the panel looks like one thing rather than a form.
 *
 * It reacts to state — the rings tighten when something needs attention — which
 * is the difference between artwork and wallpaper.
 */
export function HeaderArt({ attention, className }: { attention: number; className?: string }) {
  const found = Math.min(attention, 3);

  return (
    <svg
      className={className}
      viewBox="0 0 240 120"
      preserveAspectRatio="xMaxYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.1">
        <circle cx="186" cy="52" r="16" opacity="0.55" />
        <circle cx="186" cy="52" r="31" opacity="0.38" />
        <circle cx="186" cy="52" r="47" opacity="0.24" />
        <circle cx="186" cy="52" r="65" opacity="0.13" />
        <circle cx="186" cy="52" r="84" opacity="0.07" />
      </g>

      {/* One dot per thing found, out on the sweep. */}
      {found > 0 && <circle cx="217" cy="34" r="4.2" fill="currentColor" opacity="0.85" />}
      {found > 1 && <circle cx="151" cy="79" r="3" fill="currentColor" opacity="0.5" />}
      {found > 2 && <circle cx="199" cy="97" r="2.4" fill="currentColor" opacity="0.35" />}
    </svg>
  );
}

/**
 * The mark on a job brief.
 *
 * Drawn rather than borrowed from an icon set: a case with a honey clasp, so the
 * one piece of artwork on the busiest screen belongs to this product rather than
 * looking like every other dashboard. Two tones, both from the palette.
 */
export function BriefcaseMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="3" y="10" width="26" height="17" rx="5" fill="currentColor" opacity="0.12" />
      <rect x="3.9" y="10.9" width="24.2" height="15.2" rx="4.1" stroke="currentColor" strokeWidth="1.8" />
      <path d="M11.5 10.5V8.8A3.3 3.3 0 0 1 14.8 5.5h2.4a3.3 3.3 0 0 1 3.3 3.3v1.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="13.4" y="16.4" width="5.2" height="4.2" rx="1.6" fill="var(--accent)" />
    </svg>
  );
}

/** A condition that stops you. A circle with a bar, not a scary cross. */
export function BlockMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.2 8h5.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** Refresh: a ring with a gap and an arrowhead, so "again" reads at 16px. */
export function RefreshMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M13.4 2.6v2.8h-2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Share: a node passing to two others. Not the platform-specific arrow-out-of-box. */
export function ShareMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="12.2" cy="3.6" r="2.1" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="3.8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12.2" cy="12.4" r="2.1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.7 7 10.3 4.6M5.7 9l4.6 2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Bin: lid, body, two ribs. Used only where deleting is the point. */
export function TrashMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.8 4.3h10.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.2 4.2V3.1A1.2 1.2 0 0 1 7.4 2h1.2a1.2 1.2 0 0 1 1.2 1.1v1.1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.3 4.3h7.4l-.6 8.2A1.5 1.5 0 0 1 9.6 14H6.4a1.5 1.5 0 0 1-1.5-1.5L4.3 4.3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M6.8 7v4M9.2 7v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * What happened, per kind of Activity event.
 *
 * Activity was a list of grey timestamps with no shape to it. Each kind now has
 * a mark and a colour, so a glance separates "we noticed" from "we did" from
 * "we checked it worked" — which is the whole point of an audit trail.
 */
export function ActivityMark({ kind, className }: { kind: string; className?: string }) {
  if (kind === "executed") {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.6" />
        <path d="m5.4 8.2 1.9 1.9 3.4-3.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "verified") {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.8 13.4 4v4.2c0 3-2.2 5.3-5.4 6-3.2-.7-5.4-3-5.4-6V4L8 1.8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="m5.8 8 1.6 1.6 3-3.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "suggested") {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 2.2a4.2 4.2 0 0 1 2.4 7.6c-.5.4-.8 1-.8 1.6H6.4c0-.7-.3-1.2-.8-1.6A4.2 4.2 0 0 1 8 2.2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M6.6 13.4h2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "undone" || kind === "failed") {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  // detected, and anything new: an eye, because noticing is what it did.
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Settings groups: a dial, a bell, a lock. */
export function DialMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.6v3.4l2.2 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LockMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.2" y="6.8" width="9.6" height="7" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.6 6.7V5.2a2.4 2.4 0 0 1 4.8 0v1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Appearance: a half-filled circle, which is what a theme switch actually is. */
export function PaletteMark({ className }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 2a6 6 0 0 1 0 12V2Z" fill="currentColor" />
    </svg>
  );
}
