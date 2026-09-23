import type { Track } from "../../shared/protocol.js";

export interface BylineLink {
  text: string;
  href: string;
}
export interface PlayerMetadata {
  title: string;
  artist: string;
  album?: string;
}
const visible = (value: string): string =>
  value
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const isYear = (value: string): boolean => /^(?:19|20)\d{2}$/.test(value);
const isArtistLink = (href: string): boolean =>
  /\/(?:channel\/|browse\/UC)/i.test(href);
const isAlbumLink = (href: string): boolean =>
  /\/browse\/MPRE|[?&]list=OLAK/i.test(href);

/** Prefer identified artist links. The text fallback only uses the first byline field. */
export function parsePlayerMetadata(
  titleText: string,
  bylineText: string,
  links: BylineLink[],
): PlayerMetadata | null {
  const title = visible(titleText);
  const fields = bylineText.split(/[•·]/).map(visible).filter(Boolean);
  const artistLinks = links
    .filter((link) => isArtistLink(link.href))
    .map((link) => visible(link.text))
    .filter(Boolean);
  const uniqueArtists = artistLinks.filter(
    (name, index) => artistLinks.indexOf(name) === index,
  );
  const artist = uniqueArtists.length
    ? uniqueArtists.join(", ")
    : fields[0] || visible(links[0]?.text || "");
  if (!title || !artist) return null;
  const linkedAlbum = links.find((link) => isAlbumLink(link.href));
  const album =
    visible(linkedAlbum?.text || "") ||
    fields
      .slice(1)
      .find((field) => !isYear(field) && !uniqueArtists.includes(field));
  return { title, artist, ...(album ? { album } : {}) };
}

export function readPlayerMetadata(bar: Element | null): PlayerMetadata | null {
  if (!bar) return null;
  const byline = bar.querySelector(".byline");
  const anchors = Array.from(byline?.querySelectorAll("a") || []).map(
    (anchor) => ({
      text: anchor.textContent || "",
      href: anchor.getAttribute("href") || "",
    }),
  );
  return parsePlayerMetadata(
    bar.querySelector(".title")?.textContent || "",
    byline?.textContent || "",
    anchors,
  );
}

export function readTrack(
  bar: Element | null,
  duration: number,
  videoId?: string,
): Track | null {
  const metadata = readPlayerMetadata(bar);
  if (!metadata || !Number.isFinite(duration) || duration <= 0) return null;
  const image = bar?.querySelector(
    "img.image, .thumbnail img, img",
  ) as HTMLImageElement | null;
  const inlineBackground =
    (bar?.querySelector(".image, .thumbnail") as HTMLElement | null)?.style
      .backgroundImage || "";
  const backgroundUrl = /^url\(["']?(.*?)["']?\)$/.exec(inlineBackground)?.[1];
  return {
    ...metadata,
    durationMs: Math.round(duration * 1000),
    artwork: image?.currentSrc || image?.src || backgroundUrl || undefined,
    videoId,
  };
}
