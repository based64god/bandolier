import { renderPwaIcon } from "~/app/_og/pwa-icon";

export const contentType = "image/png";

export function GET() {
  return renderPwaIcon(512);
}
