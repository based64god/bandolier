// WW2-style bandolier: a diagonal shoulder strap with bullet cartridges.
// The whole shape is drawn in a flat (horizontal strap, upright bullets)
// coordinate system and then rotated -45° so it reads as a diagonal bandolier
// running from the lower-left to the upper-right corner. The strap overflows
// the 32×32 box and is clipped back to a rounded-corner square (rx=7) so it
// reaches the edges while keeping the soft rounded corners of the app icon.
//
// The glyph carries its own brand colors — a black rounded backdrop with a
// gray strap and white bullets (rounded tip, flat back) — rather than
// inheriting the surrounding text color, so it renders identically wherever it
// appears.
export function BandolierIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <clipPath id="bandolier-clip">
          <rect width="32" height="32" rx="7" />
        </clipPath>
      </defs>

      {/* Rounded black backdrop matching the app icon. */}
      <rect width="32" height="32" rx="7" fill="#000000" />

      <g clipPath="url(#bandolier-clip)">
        <g transform="rotate(-45 16 16)">
          {/* Shoulder strap — a continuous gray band spanning corner to corner. */}
          <rect x="-8" y="12" width="48" height="8" fill="#9a9a9a" />

          {/* Cartridges — four evenly spaced bullets crossing the strap, each a
              flat-backed body (rect) over a rounded tip (circle). */}
          <g fill="#ffffff">
            <rect x="2.55" y="9.5" width="4.4" height="12.5" />
            <circle cx="4.75" cy="22" r="2.2" />
            <rect x="10.05" y="9.5" width="4.4" height="12.5" />
            <circle cx="12.25" cy="22" r="2.2" />
            <rect x="17.55" y="9.5" width="4.4" height="12.5" />
            <circle cx="19.75" cy="22" r="2.2" />
            <rect x="25.05" y="9.5" width="4.4" height="12.5" />
            <circle cx="27.25" cy="22" r="2.2" />
          </g>
        </g>
      </g>
    </svg>
  );
}
