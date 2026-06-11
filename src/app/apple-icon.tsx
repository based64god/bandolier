import { ImageResponse } from "next/og";

import { bandolierDataUri } from "./_og/bandolier";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#15162c",
      }}
    >
      <img src={bandolierDataUri} width={132} height={132} alt="" />
    </div>,
    { ...size },
  );
}
