/** Runs only for a validated Galaxy command in the YouTube Music page's MAIN world.
 * Calling the site's player keeps its own volume setting in sync across songs.
 * The content script still reads the real media element for confirmation.
 */
export function setYouTubePlayerVolume(volume: number): boolean {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) return false;
  const player = document.querySelector(
    ".html5-video-player, #movie_player",
  ) as (Element & { setVolume?: (value: number) => void }) | null;
  if (typeof player?.setVolume !== "function") return false;
  player.setVolume(Math.round(volume * 100));
  return true;
}
