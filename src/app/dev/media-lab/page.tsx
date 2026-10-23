import { notFound } from "next/navigation";
import { MediaLab } from "./MediaLab";

/**
 * Dev-only lab for the media pipeline and the recap (used by e2e/media.spec.ts):
 * runs real browser image/video processing and renders the recap on fake data.
 * Never served in production.
 */
export default function MediaLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <MediaLab />;
}
