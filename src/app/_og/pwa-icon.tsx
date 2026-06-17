import { ImageResponse } from "next/og";

import { bandolierDataUri } from "./bandolier";

// Brand background shared with the favicon (src/app/icon.svg) and apple-icon.
const BACKGROUND = "#15162c";

/**
 * Renders a square PWA icon: the bandolier glyph centered on the brand
 * background. The glyph is kept within ~60% of the canvas so the icon stays
 * inside the maskable safe zone (central 80%) when the OS applies a mask.
 */
export function renderPwaIcon(size: number) {
  const glyph = Math.round(size * 0.6);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: BACKGROUND,
      }}
    >
      <img src={bandolierDataUri} width={glyph} height={glyph} alt="" />
    </div>,
    { width: size, height: size },
  );
}
