import type { Track } from "../../shared/protocol.js";

export function showTrackMetadata(
  track: Track,
  fields: {
    title: HTMLElement;
    artist: HTMLElement;
    coverTitle: HTMLElement;
    coverArtist: HTMLElement;
    coverAlbum: HTMLElement;
  },
): void {
  if (fields.title.textContent !== track.title)
    fields.title.textContent = track.title;
  if (fields.artist.textContent !== track.artist)
    fields.artist.textContent = track.artist;
  if (fields.coverTitle.textContent !== track.title)
    fields.coverTitle.textContent = track.title;
  if (fields.coverArtist.textContent !== track.artist)
    fields.coverArtist.textContent = track.artist;
  if (fields.coverAlbum.textContent !== (track.album || ""))
    fields.coverAlbum.textContent = track.album || "";
}

/** Cover loading is independent of track text, including when an image fails. */
export class ArtworkView {
  private side = 0;
  private url = "";
  private version = -1;
  private revision = 0;

  constructor(
    private readonly cover: HTMLImageElement,
    private readonly layers: HTMLElement[],
    private readonly base: string,
  ) {}

  show(url: string, version: number): void {
    if (url === this.url && version === this.version) return;
    this.url = url;
    this.version = version;
    const revision = ++this.revision;
    let safe = "";
    try {
      const parsed = new URL(url, this.base);
      if (
        url &&
        (parsed.protocol === "https:" ||
          parsed.origin === new URL(this.base).origin)
      )
        safe = parsed.href;
    } catch {
      // Missing/invalid artwork simply leaves the dark scene and metadata.
    }
    this.side = 1 - this.side;
    const incoming = this.layers[this.side]!;
    const outgoing = this.layers[1 - this.side]!;
    incoming.style.backgroundImage = safe
      ? "url(" + JSON.stringify(safe) + ")"
      : "none";
    incoming.classList.add("active");
    outgoing.classList.remove("active");
    this.cover.style.display = "none";
    this.cover.onload = () => {
      if (revision === this.revision) this.cover.style.display = "block";
    };
    this.cover.onerror = () => {
      if (revision !== this.revision) return;
      this.cover.style.display = "none";
      incoming.style.backgroundImage = "none";
    };
    if (safe) this.cover.src = safe;
    else this.cover.removeAttribute("src");
  }
}
