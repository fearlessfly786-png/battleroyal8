/**
 * RATFIRE game audio — Web Audio sound manager (minimal build).
 *
 * Kept cues:
 *   rain-loop   "Heavy storm rain loop" (mixkit #2400)      /public/sfx/
 *   jump        user-uploaded ATHLETIC JUMP sfx      /public/sfx/jump.mp3
 * (the pre-existing /sounds/running-forest.wav footstep loop lives in
 * page.tsx as a plain HTMLAudioElement; the mute toggle covers ALL.)
 *
 * Autoplay-policy-proof architecture: the AudioContext is created LAZILY
 * inside the FIRST user gesture (any click / key press). A context born
 * during a gesture starts 'running' in every browser — no resume() gamble.
 * The MP3 file data is prefetched at page mount (fetch needs no gesture),
 * so decoding starts the instant the context exists. A missing file only
 * silences its own cue; audio can never break the game.
 */

import { setGlobalMuted } from './muteState';

export interface GameAudioHandle {
  /** Storm intensity 0..1 — drives the rain loop. */
  setRain(intensity: number): void;
  /** Ensure the context exists + is running (called from user gestures). */
  resume(): void;
  /** One-shot cue: the Space-key jump. */
  jump(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Debug/verification snapshot (surfaced on window.__sfx). */
  debug(): {
    ctxState: string;
    loaded: string[];
    muted: boolean;
    gains: Record<string, number>;
    oneshots: Record<string, number>;
    resumeError: string | null;
    rainTarget: number;
  };
}

const RAIN_FILE = 'rain-loop.mp3';
const RAIN_GAIN = 0.75;
const JUMP_FILE = 'jump.mp3';
const JUMP_GAIN = 0.55;

const MUTE_PREF_KEY = 'ratfire-muted';

let singleton: GameAudioHandle | null = null;
let creating: Promise<GameAudioHandle> | null = null;

/** Lazily create (once) the game audio manager. Safe to call anywhere. */
export function getGameAudio(): Promise<GameAudioHandle> {
  if (singleton) return Promise.resolve(singleton);
  if (!creating) creating = createGameAudio();
  return creating;
}

async function createGameAudio(): Promise<GameAudioHandle> {
  // ---- prefetch the raw file data right away (fetch needs no gesture) ----
  const prefetch = new Map<string, Promise<ArrayBuffer | null>>();
  const files: Array<[string, string]> = [
    ['rain-loop', RAIN_FILE],
    ['jump', JUMP_FILE],
  ];
  for (const [key, file] of files) {
    prefetch.set(
      key,
      fetch(`/sfx/${file}`)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .catch(() => null)
    );
  }

  // ---- live audio graph (built inside the first user gesture) ----
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let rainGain: GainNode | null = null;
  const oneShotBuffers = new Map<string, AudioBuffer>();
  let lastRainTarget = -1;
  let rainTarget = 0;
  const oneshotCounts: Record<string, number> = {};
  let resumeError: string | null = null;
  let initPromise: Promise<void> | null = null;

  let muted = false;
  try {
    muted = localStorage.getItem(MUTE_PREF_KEY) === '1';
  } catch {
    /* private mode etc. */
  }
  // seed the global bus with the persisted preference so every subscriber
  // (current and future) starts in the same state as this master gain
  setGlobalMuted(muted);

  /** Build the AudioContext + graph. MUST first be called from a gesture —
   *  a context born mid-gesture starts 'running' in every browser. */
  function init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        const theCtx = new Ctx(); // born running (gesture-driven)
        ctx = theCtx;

        master = theCtx.createGain();
        master.gain.value = muted ? 0 : 1;
        master.connect(theCtx.destination);

        // decode rain (loop) from the prefetched data
        const rainData = await prefetch.get('rain-loop');
        if (rainData) {
          const buf = await theCtx.decodeAudioData(rainData);
          const src = theCtx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          rainGain = theCtx.createGain();
          rainGain.gain.value = 0;
          src.connect(rainGain).connect(master);
          src.start();
        }

        // decode the jump one-shot
        const jumpData = await prefetch.get('jump');
        if (jumpData) {
          oneShotBuffers.set('jump', await theCtx.decodeAudioData(jumpData));
        }
      } catch (err) {
        resumeError = err instanceof Error ? err.message : String(err);
      }
    })();
    return initPromise;
  }

  /** Ready-check shared by the cue entry points; warms the init if the
   *  graph is still building (the NEXT press then plays). */
  function graphReady(): boolean {
    const buf = oneShotBuffers.get('jump');
    if (!ctx || !buf || !master) {
      void init();
      return false;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    return true;
  }

  // ---- ANY first interaction builds the context (born running) ----
  window.addEventListener('pointerdown', () => void init());
  window.addEventListener('keydown', () => void init());

  singleton = {
    resume() {
      void init();
    },
    setRain(intensity) {
      const target = RAIN_GAIN * Math.min(1, Math.max(0, intensity));
      rainTarget = Number(target.toFixed(3));
      if (!rainGain || !ctx || Math.abs(lastRainTarget - target) < 0.004) {
        return;
      }
      lastRainTarget = target;
      rainGain.gain.setTargetAtTime(target, ctx.currentTime, 0.5);
    },
    jump: () => {
      if (!graphReady()) return;
      const buf = oneShotBuffers.get('jump');
      if (!ctx || !buf || !master) return;
      oneshotCounts.jump = (oneshotCounts.jump ?? 0) + 1;
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.12;
        const gain = ctx.createGain();
        gain.gain.value = JUMP_GAIN;
        src.connect(gain).connect(master);
        src.start(ctx.currentTime);
        src.onended = () => {
          src.disconnect();
          gain.disconnect();
        };
      } catch {
        /* never let audio throw into the game loop */
      }
    },
    setMuted(next) {
      muted = next;
      // one flip silences EVERY producer — including the ones with their
      // own AudioContexts (rain bed) that this master gain can't reach
      setGlobalMuted(next);
      try {
        localStorage.setItem(MUTE_PREF_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      if (master && ctx) {
        master.gain.setTargetAtTime(next ? 0 : 1, ctx.currentTime, 0.05);
      }
    },
    isMuted: () => muted,
    debug() {
      return {
        ctxState: ctx ? ctx.state : 'uncreated',
        loaded: [
          ...(rainGain ? ['rain-loop'] : []),
          ...[...oneShotBuffers.keys()],
        ],
        muted,
        gains:
          rainGain && ctx
            ? { 'rain-loop': Number(rainGain.gain.value.toFixed(3)) }
            : {},
        oneshots: { ...oneshotCounts },
        resumeError,
        rainTarget,
      };
    },
  };

  return singleton;
}
