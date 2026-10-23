/* Room for Winify's own dialogs (the playlist picker, Jump to track).
 *
 * Winify's window wraps the player tightly (275 px wide by default), and the
 * dialogs are wider than that. While one is open the window grows to fit it,
 * in place; when it closes the window goes back to the size it was.
 */

let restoreTo = null;               // the size to go back to, while grown
let holders = 0;

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// Make the window at least width x height, and wait until it is. Returns a
// function that gives the room back.
export async function makeRoom(width, height) {
  holders++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0 && restoreTo && window.spotify && window.spotify.fitWindow) {
      window.spotify.fitWindow({ width: restoreTo.width, height: restoreTo.height });
      restoreTo = null;
    }
  };
  if (!(window.spotify && window.spotify.fitWindow)) return release;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w >= width && h >= height) return release;
  if (!restoreTo) restoreTo = { width: w, height: h };
  window.spotify.fitWindow({ width: Math.max(w, width), height: Math.max(h, height) });
  // The display may be too small to grow that far; carry on regardless.
  const until = performance.now() + 1500;
  while ((window.innerWidth < width - 1 || window.innerHeight < height - 1) && performance.now() < until) {
    await nextFrame();
  }
  return release;
}
