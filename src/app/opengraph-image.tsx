import { ImageResponse } from "next/og";

import { bandolierDataUri } from "./_og/bandolier";

export const alt = "Bandolier — Claude agent monitoring & deployment";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
        background: "linear-gradient(to bottom, #2e026d, #15162c)",
        color: "white",
        fontFamily: "sans-serif",
      }}
    >
      <img src={bandolierDataUri} width={180} height={180} alt="" />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{ fontSize: 84, fontWeight: 800, letterSpacing: "-0.03em" }}
        >
          Bandolier
        </div>
        <div style={{ fontSize: 32, color: "rgba(255,255,255,0.55)" }}>
          Claude agent monitoring &amp; deployment
        </div>
      </div>
    </div>,
    { ...size },
  );
}
