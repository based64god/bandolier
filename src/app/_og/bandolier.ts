// The bandolier glyph as a standalone SVG string (transparent: a gray shoulder
// strap running corner to corner with four white bullets — flat back, rounded
// tip — crossing it), used as a data-URI <img> source inside next/og
// ImageResponse renders. The strap overflows the 32×32 box and is clipped to
// it by the viewBox so it reaches the corners.
export const bandolierSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <g transform="rotate(-45 16 16)">
    <rect x="-8" y="12" width="48" height="8" fill="#9a9a9a"/>
    <g fill="#ffffff">
      <rect x="2.55" y="9.5" width="4.4" height="12.5"/><circle cx="4.75" cy="22" r="2.2"/>
      <rect x="10.05" y="9.5" width="4.4" height="12.5"/><circle cx="12.25" cy="22" r="2.2"/>
      <rect x="17.55" y="9.5" width="4.4" height="12.5"/><circle cx="19.75" cy="22" r="2.2"/>
      <rect x="25.05" y="9.5" width="4.4" height="12.5"/><circle cx="27.25" cy="22" r="2.2"/>
    </g>
  </g>
</svg>`;

export const bandolierDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(bandolierSvg)}`;
