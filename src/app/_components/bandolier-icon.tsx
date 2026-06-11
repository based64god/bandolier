// WW2-style bandolier: a diagonal shoulder strap with bullet cartridges.
// The whole shape is drawn in a flat (horizontal strap, upright bullets)
// coordinate system and then rotated 45° so it reads as a diagonal bandolier.
export function BandolierIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="-2 -2 28 28"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <g transform="rotate(45 12 12)">
        {/* Shoulder strap */}
        <rect x="-1" y="10" width="26" height="4" rx="2" fillOpacity="0.5" />

        {/* Bullet cartridges — six evenly spaced along the strap.
            Each sits partially above the strap (y 4→11.5) so the case
            overlaps the strap loop and only the bullet tip is exposed. */}
        <rect x="0.5" y="4" width="2.5" height="8.5" rx="1.25" />
        <rect x="4.2" y="4" width="2.5" height="8.5" rx="1.25" />
        <rect x="7.9" y="4" width="2.5" height="8.5" rx="1.25" />
        <rect x="11.6" y="4" width="2.5" height="8.5" rx="1.25" />
        <rect x="15.3" y="4" width="2.5" height="8.5" rx="1.25" />
        <rect x="19" y="4" width="2.5" height="8.5" rx="1.25" />
      </g>
    </svg>
  );
}
