/**
 * Global game-mute bus — the single source of truth behind the HUD's sound
 * on/off button (right edge, vertically centred) and the M key.
 *
 * audio.ts owns the main Web Audio graph's master gain, but a few producers
 * run their OWN private AudioContexts (rainSystem's filtered-noise rainfall
 * bed is wired straight to ctx.destination). Subscribing here lets every one
 * of them fall silent in the same instant the button is pressed — one click
 * mutes the ENTIRE game, clicking again restores everything.
 *
 * Flow: button/M key -> audio.ts setMuted() -> setGlobalMuted() -> every
 * subscriber (rain bed, ...). audio.ts also seeds the bus with the persisted
 * localStorage preference at creation so late subscribers start in sync.
 */

let muted = false;
const listeners = new Set<(muted: boolean) => void>();

/** Current global mute state. */
export function getGlobalMuted(): boolean {
  return muted;
}

/** Flip the global mute. audio.ts's setMuted is the ONE writer — everything
 *  else listens. Unknown no-op when the state doesn't change. */
export function setGlobalMuted(next: boolean): void {
  if (next === muted) return;
  muted = next;
  for (const notify of listeners) {
    try {
      notify(muted);
    } catch {
      // a broken listener must never break the mute flow
    }
  }
}

/** Subscribe to mute flips. The callback fires IMMEDIATELY with the current
 *  state (so late subscribers sync up), then on every change. Returns an
 *  unsubscribe function — call it from dispose(). */
export function onMuteChange(callback: (muted: boolean) => void): () => void {
  listeners.add(callback);
  callback(muted);
  return () => {
    listeners.delete(callback);
  };
}
