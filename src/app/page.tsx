'use client';

/**
 * RATFIRE — minimal build.
 *
 * Only four things live here now:
 *   1. The LOBBY DASHBOARD UI (player header, logo, START, fullscreen/mute,
 *      GitHub export button + dialog).
 *   2. The PLAYER (ratamahatta MD2 character: walk / run / sprint / double
 *      jump / emotes, orbit camera, fall damage + respawn, footstep loop).
 *   3. The GRASSLANDS biome (infinite streamed voxel terrain) under the
 *      DAY/NIGHT SKY: 24h cycle with sun disc, cratered moon disc, star
 *      field and the two-layer procedural FBM cloud deck (see
 *      src/game/skyClouds.ts) that drifts, morphs and storm-darkens —
 *      plus BUSHES (src/game/bushSystem.ts) auto-spawning over the whole
 *      endless terrain: ferns only (at light density), world-anchored
 *      and streaming — with TREE TRUNKS (src/game/treeTrunks.ts, the
 *      uploaded low-poly trunk) scattered sparsely between them and
 *      SOLID: the player slides around trunks instead of clipping
 *      through them.
 *   4. The RAIN + PUDDLE systems (one shower per in-game day; clouds build
 *      before it pours, puddles fill while it pours and dry out
 *      afterwards) + the GitHub EXPORT feature.
 *
 * Everything else (weapons, store, luck royale, mods, vault, pets, drones,
 * jeeps, chests, other biomes, voice link, previews, minimap) was removed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Coins,
  Eye,
  EyeOff,
  Gem,
  LoaderCircle,
  Maximize,
  Minimize,
  Play,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import * as THREE from 'three';
import { MD2Character } from 'three/examples/jsm/misc/MD2Character.js';
import {
  createTerrainChunks,
  type TerrainChunksHandle,
} from '@/game/terrainChunks';
import { createRain, type RainHandle } from '@/game/rainSystem';
import {
  createGroundWater,
  type GroundWaterHandle,
} from '@/game/groundWater';
import { createSkyText, type SkyTextHandle } from '@/game/skyText';
import {
  createSkyClouds,
  type SkyCloudsHandle,
} from '@/game/skyClouds';
import {
  createBushes,
  type BushSystemHandle,
} from '@/game/bushSystem';
import {
  createFernLife,
  type FernLifeHandle,
} from '@/game/fernLife';
import {
  createTrunks,
  type TrunkSystemHandle,
} from '@/game/treeTrunks';
import {
  createPines,
  type PineSystemHandle,
} from '@/game/pineTrees';
import {
  createPineDead,
  type PineDeadSystemHandle,
} from '@/game/pineDeadTrees';
import {
  createWatchTower,
  type WatchTowerHandle,
} from '@/game/watchTower';
import { getGameAudio, type GameAudioHandle } from '@/game/audio';
import TouchControls, {
  type TouchGameApi,
} from '@/components/game/TouchControls';

/** GitHub brand mark (octicon "mark-github" path) for the export button. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Rotating status lines shown while the GitHub export request is in flight. */
const GH_STEPS = [
  'Authenticating…',
  'Creating repository…',
  'Uploading source files…',
  'Creating commit…',
  'Working — large uploads can take a minute…',
];

/** Debug handle exposed on window for tooling/verification (renders nothing). */
interface PlayerDebugInfo {
  loaded: boolean;
  animation: string;
  moving: boolean;
  airborne: boolean;
  x: number;
  y: number;
  z: number;
  charMinY: number;
  charMaxY: number;
  timeOfDay: number;
  sprint: boolean;
  touchMove: boolean;
  phase: GamePhase;
}

/** Mesh augmented by MD2Character at runtime with the active animation action. */
interface ActionMesh extends THREE.Mesh {
  activeAction?: THREE.AnimationAction;
}

// ================================ tuning ==================================

/** World units per voxel block edge + grid origin offset. */
const BLOCK = 100;
const GRID_OFFSET = 64;
/** Player collision radius against solid tree trunks and dead trees. */
const PLAYER_RADIUS = 26;

const CHAR_HEIGHT = 190; // ~1.9 blocks tall
const WALK_SPEED = 360;
const RUN_SPEED = 620; // mobile RUN toggle sprint speed
const BACK_SPEED = 220;
const TURN_SPEED = 2.4; // rad/s
const JUMP_SPEED = 620;
const DOUBLE_JUMP_SPEED = 560; // mid-air second jump is a touch weaker
const MAX_JUMPS = 2; // double jump: one ground jump + one mid-air jump
const GRAVITY = 1800;
const RUN_SOUND_VOLUME = 0.35;

const MAX_HEALTH = 100;
const FALL_DAMAGE_MIN_SPEED = 800; // landing speed (units/s) where damage starts
const FALL_DAMAGE_SCALE = 0.06;
const HEALTH_REGEN_DELAY = 5; // seconds after damage before regen kicks in
const HEALTH_REGEN_RATE = 5; // per second
const RESPAWN_DELAY = 2.4; // seconds between death and respawn

const CAM_DIST = 320;
const CAM_HEIGHT = 170; // default elevation, expressed as pitch via CAM_DEFAULT_PITCH
const CAM_MIN_DIST = 140;
const CAM_MAX_DIST = 900;
const CAM_DEFAULT_PITCH = Math.atan2(CAM_HEIGHT, CAM_DIST);
const CAM_MIN_PITCH = -0.85; // camera drops low, letting you look up at the sky
const CAM_MAX_PITCH = 1.25; // near top-down
const LOOK_HEIGHT = 100;
const CAM_MIN_CLEARANCE = 70;

/** Day/night cycle tuning. */
const CYCLE_SECONDS = 160; // real seconds for a full 24h cycle (~80s day / 80s night)
const DAY_START_HOUR = 9; // hour the game boots at (mid-morning)

/** The single daily rain shower, in in-game hours: clouds build 13.5->14.2,
 *  pour until 16.4, clear by 17.2 — exactly one storm per 24h cycle. */
const RAIN_WINDOW = {
  buildFrom: 13.5,
  fullAt: 14.2,
  clearFrom: 16.4,
  clearBy: 17.2,
};

function rainIntensityFromHour(hour: number): number {
  const w = RAIN_WINDOW;
  if (hour < w.buildFrom || hour > w.clearBy) return 0;
  const rampUp = THREE.MathUtils.smoothstep(hour, w.buildFrom, w.fullAt);
  const rampDown = 1 - THREE.MathUtils.smoothstep(hour, w.clearFrom, w.clearBy);
  return rampUp * rampDown;
}

const SUNRISE_HOUR = 6; // hour 6 = sun on the east horizon
const SKY_DAY = new THREE.Color(0xbfd1e5);
const SKY_NIGHT = new THREE.Color(0x070b18);
const SKY_SUNSET = new THREE.Color(0xf2984f);
const STORM_SKY = new THREE.Color(0x59636e); // wet grey sky while rain pours
const SUNLIGHT_HIGH = new THREE.Color(0xfff3e2);
const SUNLIGHT_LOW = new THREE.Color(0xff9a55);
const MOONLIGHT = new THREE.Color(0xa7b8e0);
const AMBIENT_DAY = new THREE.Color(0xeeeeee);
const AMBIENT_NIGHT = new THREE.Color(0x46527a);
const AMBIENT_DAY_I = 3;
const AMBIENT_NIGHT_I = 1.1;
const SUN_LIGHT_MAX = 12;
const MOON_LIGHT_MAX = 2.4;
const SUN_TINT_NOON = new THREE.Color(0xffffff);
const SUN_TINT_SET = new THREE.Color(0xff8038);
const STAR_COUNT = 1300;
const STAR_BRIGHT_COUNT = 90;
const STAR_RADIUS = 8800; // inside camera.far, beyond the world edge

/** Aerial fog: FogExp2 base density; thickens a little at dawn/dusk. */
const FOG_DENSITY = 0.00011;

/** One-shot animation bindings: key code -> clip name (player emotes). */
const ACTION_KEYS: Record<string, string> = {
  Digit1: 'wave',
  Digit2: 'taunt',
  Digit3: 'salute',
  Digit4: 'point',
  Digit5: 'flip',
  Numpad5: 'flip',
};

/** Body skin (single base costume — the rack stays at one entry). */
const SKINS: Array<{ name: string; color: string; file: string }> = [
  { name: 'Ratamahatta', color: '#b45309', file: 'ratamahatta.png' },
];

/** Player identity shown on the lobby dashboard. */
const PLAYER_NAME = 'RATLORD_99';
const PLAYER_COINS = 160;
const PLAYER_GEMS = 0;

type GamePhase = 'lobby' | 'playing';

/** Lobby showcase camera + turntable tuning. */
const LOBBY_DIST = 430;
const LOBBY_PITCH = 0.1;
const LOBBY_TURN_SPEED = 0.45; // rad/s auto-rotation
const LOBBY_BLEND_TIME = 1.3; // s, camera sweep from lobby into gameplay

// ==================== mobile MAXIMIZE (fullscreen) helpers ====================

interface FsDebug {
  attempts: number;
  entered: boolean;
  lastError: string | null;
}

/** Debug/verification surface on window.__fsDebug. */
function fsDbg(): FsDebug {
  const w = window as unknown as { __fsDebug?: FsDebug };
  if (!w.__fsDebug) {
    w.__fsDebug = { attempts: 0, entered: false, lastError: null };
  }
  return w.__fsDebug;
}

/** True while a fullscreen request is in flight — dedupes concurrent callers. */
let fsPending = false;

/** True when the game already runs without browser chrome (installed mode). */
function runningStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    nav.standalone === true
  );
}

// ==================== quality tier (mobile performance) ====================

/** Same detection philosophy as the touch HUD: mobile user agent, or a
 *  coarse (touch-first) pointer with touch support. `?hi=1` overrides. */
function detectLowSpecDevice(): boolean {
  if (new URLSearchParams(window.location.search).get('hi') === '1') {
    return false;
  }
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const hasTouch =
    'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  const mobileUa =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
      navigator.userAgent
    );
  return mobileUa || (coarse && hasTouch);
}

/** Mobile render-scale cap — above ~1.5 the extra pixels are invisible. */
const LOW_DPR_CAP = 1.5;
/** Desktop still gets the crisp look, just not unbounded DPR. */
const HIGH_DPR_CAP = 2;
/** Mobile frame cap (~30fps): every skipped beat is CPU AND GPU time. */
const LOW_FRAME_INTERVAL_MS = 1000 / 30 - 2;

/**
 * The minimal RATFIRE build (three.js minecraft terrain + ratamahatta MD2
 * character):
 *
 *   W / S or Up / Down ... walk forward / backward  -> run animation
 *   A / D or Left / Right ............ turn         -> idle animation when still
 *   Space ............................ jump — press AGAIN mid-air for a
 *                                      double jump
 *   Shift + W / Up ................... sprint
 *   1 / 2 / 3 / 4 / 5 ................ wave / taunt / salute / point / flip
 *   Esc .............................. back to the lobby
 *
 *   Mouse drag ....................... orbit the camera around the character
 *   Mouse wheel ...................... zoom in / out
 *
 *   Touch (mobile ONLY) .............. virtual joystick walks + turns, RUN
 *                                      toggle, JUMP / ROAR buttons, LOBBY.
 *
 * One rain shower falls per in-game day (13.5h -> 17.2h) and puddles fill
 * while it pours, drying slowly afterwards. The GRASSLANDS sky sign
 * announces the biome on deploy. The GitHub button pushes the whole source
 * to the caller's repository.
 */
export default function MinecraftGamePage() {
  const containerRef = useRef<HTMLDivElement>(null);
  /** Imperative per-frame bridge the game loop reads through. */
  const phaseRef = useRef<GamePhase>('lobby');
  const soundRef = useRef<GameAudioHandle | null>(null);
  /** Imperative bridge the mobile touch HUD drives the game loop through. */
  const touchApiRef = useRef<TouchGameApi | null>(null);
  /** Lobby-callback bridge for the game loop (Esc / touch LOBBY button). */
  const hudBridgeRef = useRef<{ enterLobby?: () => void }>({});
  const [phase, setPhase] = useState<GamePhase>('lobby');
  const [muted, setMuted] = useState(false);

  // GitHub export panel ("push the whole game source to a GitHub repo")
  const [ghOpen, setGhOpen] = useState(false);
  const [ghToken, setGhToken] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [ghShowToken, setGhShowToken] = useState(false);
  const [ghStatus, setGhStatus] = useState<
    'idle' | 'working' | 'success' | 'error'
  >('idle');
  const [ghStep, setGhStep] = useState('');
  const [ghError, setGhError] = useState('');
  const [ghUrl, setGhUrl] = useState('');
  const [ghFiles, setGhFiles] = useState(0);

  /** True while the game fills the whole screen (browser bars hidden). */
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** Touch controls render ONLY on touch devices (or ?touch=1 override). */
  const [isTouch, setIsTouch] = useState(false);
  /** Mirrors isTouch into callbacks that must never re-bind per render. */
  const isTouchRef = useRef(false);
  /** Guards the one-shot automatic fullscreen attempt on first touch. */
  const immersiveTriedRef = useRef(false);

  /** Request fullscreen on the document (mobile browsers hide their whole
   *  top bar + tab UI). Must be called from a user gesture; silently gives
   *  up where unsupported (iOS Safari in-browser) — standalone meta tags
   *  cover that case instead. */
  const enterImmersive = useCallback(() => {
    if (fsPending || document.fullscreenElement || runningStandalone()) return;
    const root = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    const dbg = fsDbg();
    dbg.attempts += 1;
    try {
      const request =
        root.requestFullscreen?.bind(root) ??
        root.webkitRequestFullscreen?.bind(root);
      if (!request) {
        dbg.lastError = 'unsupported';
        return;
      }
      fsPending = true;
      void Promise.resolve(request({ navigationUI: 'hide' }))
        .then(() => {
          dbg.entered = true;
          dbg.lastError = null;
        })
        .catch((err: unknown) => {
          dbg.lastError = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          fsPending = false;
        });
    } catch (err) {
      fsPending = false;
      dbg.lastError = err instanceof Error ? err.message : String(err);
    }
  }, []);

  const exitImmersive = useCallback(() => {
    const doc = document as Document & { webkitExitFullscreen?: () => void };
    if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
    else doc.webkitExitFullscreen?.();
  }, []);

  /** The visible top-right button — toggles fullscreen on any device. */
  const toggleImmersive = useCallback(() => {
    if (document.fullscreenElement) exitImmersive();
    else enterImmersive();
  }, [enterImmersive, exitImmersive]);

  /** One-shot automatic attempt: the FIRST tap on a phone (lobby included)
   *  maximizes the game even before START is pressed. */
  const attemptImmersiveOnce = useCallback(() => {
    if (immersiveTriedRef.current || document.fullscreenElement) return;
    immersiveTriedRef.current = true;
    enterImmersive();
  }, [enterImmersive]);

  /** START: leave the lobby and sweep the camera into third-person gameplay. */
  const enterGame = useCallback(() => {
    phaseRef.current = 'playing';
    setPhase('playing');
    setGhOpen(false);
    // mobile MAXIMIZE: the START tap doubles as the fullscreen gesture —
    // drop the browser top bar/tabs so the game owns the whole screen
    if (isTouchRef.current) enterImmersive();
    // user gesture: wake the (otherwise suspended) AudioContext here
    void getGameAudio().then((sfx) => {
      soundRef.current = sfx;
      sfx.resume();
    });
  }, [enterImmersive]);

  /** Back to the lobby showcase (Esc key). */
  const enterLobby = useCallback(() => {
    phaseRef.current = 'lobby';
    setPhase('lobby');
  }, []);

  /** Mute/unmute every sound (speaker button + the M key). */
  const toggleMute = useCallback(() => {
    void getGameAudio().then((sfx) => {
      soundRef.current = sfx;
      sfx.resume(); // this click is also a valid gesture
      const next = !sfx.isMuted();
      sfx.setMuted(next);
      setMuted(next);
    });
  }, []);

  /** Push the entire game source to the caller's GitHub account. */
  const saveToGithub = useCallback(async () => {
    const tokenValue = ghToken.trim();
    const repoValue = ghRepo.trim();
    if (!tokenValue || !repoValue || ghStatus === 'working') return;
    setGhStatus('working');
    setGhError('');
    setGhUrl('');
    setGhStep(GH_STEPS[0]);
    let stepIndex = 0;
    const stepTimer = window.setInterval(() => {
      stepIndex = Math.min(stepIndex + 1, GH_STEPS.length - 1);
      setGhStep(GH_STEPS[stepIndex]);
    }, 4000);
    try {
      const res = await fetch('/api/github/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenValue, repo: repoValue }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        url?: string;
        files?: number;
      };
      if (!res.ok || !data.ok || !data.url) {
        throw new Error(data.error || `GitHub request failed (${res.status}).`);
      }
      setGhUrl(data.url);
      setGhFiles(data.files ?? 0);
      setGhStatus('success');
    } catch (error) {
      setGhError(
        error instanceof Error ? error.message : 'Unexpected network error.'
      );
      setGhStatus('error');
    } finally {
      window.clearInterval(stepTimer);
    }
  }, [ghToken, ghRepo, ghStatus]);

  // Esc closes the GitHub export panel
  useEffect(() => {
    if (!ghOpen) return;
    function onPanelKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setGhOpen(false);
    }
    window.addEventListener('keydown', onPanelKeyDown);
    return () => window.removeEventListener('keydown', onPanelKeyDown);
  }, [ghOpen]);

  // wire the lobby bridge the game loop communicates through
  useEffect(() => {
    hudBridgeRef.current.enterLobby = enterLobby;
    return () => {
      hudBridgeRef.current.enterLobby = undefined;
    };
  }, [enterLobby]);

  // Enter also deploys from the lobby — but never while typing in a text
  // field (e.g. the GitHub export panel inputs).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code !== 'Enter' || phaseRef.current !== 'lobby') return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      enterGame();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enterGame]);

  // ============ game audio singleton (see src/game/audio.ts) ============
  useEffect(() => {
    let cancelled = false;
    void getGameAudio().then((sfx) => {
      if (cancelled) return;
      soundRef.current = sfx;
      setMuted(sfx.isMuted());
      (window as unknown as { __sfx?: GameAudioHandle }).__sfx = sfx;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ============ touch device detection (mobile controls visibility) ============
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('touch') === '1') {
      setIsTouch(true);
      return;
    }
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const hasTouch =
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      ((navigator as Navigator & { msMaxTouchPoints?: number })
        .msMaxTouchPoints ?? 0) > 0;
    const mobileUa =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
        navigator.userAgent
      );
    setIsTouch(mobileUa || (coarse && hasTouch));
  }, []);

  // Auto-MAXIMIZE on the first touch of a mobile session.
  useEffect(() => {
    if (!isTouch) return;
    isTouchRef.current = true;
    const onFirstTap = () => attemptImmersiveOnce();
    window.addEventListener('pointerdown', onFirstTap, {
      once: true,
      capture: true,
    });
    return () => {
      window.removeEventListener('pointerdown', onFirstTap, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [isTouch, attemptImmersiveOnce]);

  // Mirror the real fullscreen state onto the expand button + __fsDebug.
  useEffect(() => {
    const sync = () => {
      const active = !!document.fullscreenElement;
      setIsFullscreen(active);
      fsDbg().entered = active;
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  // ===================== THE GAME (three.js) =====================
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ================= quality tier (mobile LOW to stop the hang) ==========
    const LOW_SPEC = detectLowSpecDevice();

    // ================= camera / scene =================
    const camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      1,
      20000
    );

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xbfd1e5);
    // atmospheric haze; the colour is re-synced to the sky every frame
    scene.fog = new THREE.FogExp2(0xbfd1e5, FOG_DENSITY);

    // ============ infinite terrain (streamed voxel chunks) =============
    // Deterministic perlin height field, streamed as merged voxel chunks
    // around the player (see src/game/terrainChunks.ts — GRASSLANDS only).
    const terrainSeed = Math.random() * 100;
    const terrain: TerrainChunksHandle = createTerrainChunks(scene, {
      block: BLOCK,
      gridOffset: GRID_OFFSET,
      chunkBlocks: 16,
      viewRadius: LOW_SPEC ? 4 : 6,
      seedZ: terrainSeed,
      lowSpec: LOW_SPEC,
    });
    terrain.ensureAround(0, 0, 3, true); // spawn chunks meshed immediately
    (window as unknown as { __terrain?: object }).__terrain = {
      stats: terrain.stats,
      heightAt: terrain.surfaceYAt,
      pos: () => ({ x: pos.x, y: pos.y, z: pos.z }),
    };

    /** Terrain surface height (top of the block) at a world-space position. */
    function surfaceYAt(worldX: number, worldZ: number): number {
      return terrain.surfaceYAt(worldX, worldZ);
    }

    // ---- flat-spawn finder: the player must always start on level ground.
    // Candidate centres spiral out from (cx, cz); a candidate wins when the
    // terrain across its whole disc varies by no more than `tol` world
    // units. The flattest candidate seen is always remembered, so the
    // search never fails: it just walks farther out when the immediate
    // area is sloped.
    function findFlatSpot(
      cx: number,
      cz: number,
      discRadius: number,
      tol: number,
      searchRadius: number
    ): { x: number; z: number; y: number } {
      const rings: Array<[number, number]> = [
        [0, 1],
        [discRadius * 0.5, 8],
        [discRadius, 12],
      ];
      const spreadAt = (x: number, z: number) => {
        let min = Infinity;
        let max = -Infinity;
        for (const [r, n] of rings) {
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            const h = surfaceYAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
            if (h < min) min = h;
            if (h > max) max = h;
          }
        }
        return max - min;
      };
      let bestX = cx;
      let bestZ = cz;
      let bestSpread = Infinity;
      const step = Math.max(60, discRadius * 0.9);
      search: for (let r = 0; r <= searchRadius; r += step) {
        const n =
          r === 0 ? 1 : Math.max(8, Math.round((Math.PI * 2 * r) / step));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + r * 0.37; // twisted spiral
          const x = cx + Math.cos(a) * r;
          const z = cz + Math.sin(a) * r;
          const spread = spreadAt(x, z);
          if (spread < bestSpread) {
            bestSpread = spread;
            bestX = x;
            bestZ = z;
            if (bestSpread <= tol) break search;
          }
        }
      }
      return { x: bestX, z: bestZ, y: surfaceYAt(bestX, bestZ) };
    }

    // the player's home patch: a level disc big enough for the character
    // and the follow camera. Found once per session.
    const spawnFlat = findFlatSpot(0, 0, 70, 4, 2400);
    terrain.ensureAround(spawnFlat.x, spawnFlat.z, 3, true);

    const timer = new THREE.Timer();
    timer.connect(document);

    let renderer: THREE.WebGLRenderer;

    const ambientLight = new THREE.AmbientLight(0xeeeeee, 3);
    scene.add(ambientLight);

    // Day/night cycle: the sun orbits the world once per CYCLE_SECONDS and
    // the moon rides the opposite side of the sky. ONE directional light
    // plays both roles — warm bright sunlight by day, dim blue moonlight by
    // night, with real shadows in both phases.
    const SUN_DISTANCE = 2600;
    const sunDir = new THREE.Vector3();
    const moonDir = new THREE.Vector3();
    let timeHour = DAY_START_HOUR; // 0..24, advances in the render loop

    function sunAngleFromHour(hour: number): number {
      // 6h = sunrise (east horizon), 12h = zenith, 18h = sunset (west)
      return ((hour - SUNRISE_HOUR) / 24) * Math.PI * 2;
    }

    function updateSunMoonDirections() {
      const a = sunAngleFromHour(timeHour);
      sunDir.set(Math.cos(a), Math.sin(a), 0.35).normalize();
      // Moon rides the opposite arc but keeps the same z-tilt as the sun,
      // so it rises in front of the default camera view instead of behind it.
      moonDir.set(-Math.cos(a), -Math.sin(a), 0.35).normalize();
    }

    updateSunMoonDirections();

    const directionalLight = new THREE.DirectionalLight(0xffffff, 12);
    directionalLight.position.copy(sunDir).multiplyScalar(SUN_DISTANCE);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.set(
      LOW_SPEC ? 1024 : 2048,
      LOW_SPEC ? 1024 : 2048
    );
    directionalLight.shadow.camera.near = 1;
    directionalLight.shadow.camera.far = 8000;
    directionalLight.shadow.camera.left = -900;
    directionalLight.shadow.camera.right = 900;
    directionalLight.shadow.camera.top = 900;
    directionalLight.shadow.camera.bottom = -900;
    directionalLight.shadow.camera.updateProjectionMatrix();
    directionalLight.shadow.bias = -0.0004;
    directionalLight.shadow.normalBias = 3;
    scene.add(directionalLight);
    scene.add(directionalLight.target);

    // ================= sun & moon discs in the sky =================
    // The realistic circular sun keeps its runtime-generated radial-gradient
    // glow; it rides the moving sun direction and dips below the horizon at
    // dusk, warming to deep orange as it sets. A canvas-painted moon (shaded
    // disc + craters + soft halo) rides the opposite direction. Both
    // re-anchor to the camera every frame so they read as infinitely far.
    const SUN_VISUAL_DISTANCE = 15000; // inside camera.far (20000)

    function createSunTexture(): THREE.CanvasTexture {
      const size = 512;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas not supported');

      const gradient = ctx.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2
      );
      gradient.addColorStop(0, 'rgba(255, 255, 248, 1)'); // white-hot center
      gradient.addColorStop(0.1, 'rgba(255, 252, 235, 1)'); // bright core
      gradient.addColorStop(0.18, 'rgba(255, 240, 180, 0.95)'); // disc edge
      gradient.addColorStop(0.3, 'rgba(255, 214, 120, 0.5)'); // inner glow
      gradient.addColorStop(0.55, 'rgba(255, 196, 100, 0.16)'); // halo falloff
      gradient.addColorStop(1, 'rgba(255, 185, 90, 0)'); // fades into sky

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }

    const sunTexture = createSunTexture();
    const sunMaterial = new THREE.MeshBasicMaterial({
      map: sunTexture,
      transparent: true,
      depthWrite: false,
      fog: false, // the sun reads as infinitely far, beyond the haze
    });
    const sunMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(4200, 4200),
      sunMaterial
    );
    sunMesh.position.copy(sunDir).multiplyScalar(SUN_VISUAL_DISTANCE);
    scene.add(sunMesh);

    // --- moon: pale shaded disc with craters, melting into a soft halo ---
    function createMoonTexture(): THREE.CanvasTexture {
      const size = 512;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas not supported');

      const r = size / 2;

      // outer glow halo + limb softening, drawn behind the solid disc
      const halo = ctx.createRadialGradient(r, r, 0, r, r, r);
      halo.addColorStop(0, 'rgba(255, 254, 244, 0.98)');
      halo.addColorStop(0.3, 'rgba(248, 243, 224, 0.95)');
      halo.addColorStop(0.42, 'rgba(232, 226, 203, 0.82)'); // disc edge
      halo.addColorStop(0.5, 'rgba(214, 216, 205, 0.35)'); // limb
      halo.addColorStop(0.6, 'rgba(190, 200, 210, 0.12)'); // inner halo
      halo.addColorStop(1, 'rgba(170, 190, 210, 0)'); // fades to sky
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      // disc interior: offset highlight (lit from the upper left)
      ctx.save();
      ctx.beginPath();
      ctx.arc(r, r, r * 0.42, 0, Math.PI * 2);
      ctx.clip();
      const body = ctx.createRadialGradient(
        r * 0.78,
        r * 0.72,
        r * 0.05,
        r,
        r,
        r * 0.48
      );
      body.addColorStop(0, 'rgba(255, 254, 246, 0.95)');
      body.addColorStop(0.6, 'rgba(242, 237, 216, 0.92)');
      body.addColorStop(1, 'rgba(203, 197, 174, 0.9)');
      ctx.fillStyle = body;
      ctx.fillRect(0, 0, size, size);

      // craters: fixed layout so the moon always looks the same
      const craters: Array<[number, number, number]> = [
        [0.4, 0.36, 0.1],
        [0.62, 0.5, 0.14],
        [0.45, 0.66, 0.09],
        [0.68, 0.7, 0.07],
        [0.3, 0.56, 0.06],
        [0.58, 0.28, 0.05],
        [0.74, 0.42, 0.075],
        [0.38, 0.48, 0.045],
        [0.52, 0.58, 0.035],
      ];
      for (const [cx, cy, cr] of craters) {
        const px = r + (cx - 0.5) * r * 0.72;
        const py = r + (cy - 0.5) * r * 0.72;
        const pr = cr * r;
        const craterGrad = ctx.createRadialGradient(
          px - pr * 0.25,
          py - pr * 0.25,
          pr * 0.1,
          px,
          py,
          pr
        );
        craterGrad.addColorStop(0, 'rgba(168, 162, 138, 0.55)');
        craterGrad.addColorStop(0.7, 'rgba(178, 172, 148, 0.4)');
        craterGrad.addColorStop(1, 'rgba(200, 195, 170, 0)');
        ctx.fillStyle = craterGrad;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }

    const moonTexture = createMoonTexture();
    const moonMaterial = new THREE.MeshBasicMaterial({
      map: moonTexture,
      transparent: true,
      depthWrite: false,
      fog: false, // the moon reads as infinitely far, beyond the haze
    });
    const moonMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 2600),
      moonMaterial
    );
    moonMesh.position.copy(moonDir).multiplyScalar(SUN_VISUAL_DISTANCE);
    scene.add(moonMesh);

    // --- stars: a dim field + sparse bright stars on a camera-following
    //     sphere; additive round sprites that fade in with the night ---
    function createStarSprite(): THREE.CanvasTexture {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas not supported');

      const gradient = ctx.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2
      );
      gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
      gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.85)');
      gradient.addColorStop(0.6, 'rgba(255, 255, 255, 0.22)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }

    const starSprite = createStarSprite();

    /** Uniform random directions on the sphere (y > -0.2), radius STAR_RADIUS. */
    function makeStarPositions(count: number): Float32Array {
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        let x = 0;
        let y = 0;
        let z = 0;
        do {
          x = Math.random() * 2 - 1;
          y = Math.random() * 2 - 1;
          z = Math.random() * 2 - 1;
        } while (x * x + y * y + z * z > 1 || y < -0.2);
        const len = Math.sqrt(x * x + y * y + z * z) || 1;
        arr[i * 3] = (x / len) * STAR_RADIUS;
        arr[i * 3 + 1] = (y / len) * STAR_RADIUS;
        arr[i * 3 + 2] = (z / len) * STAR_RADIUS;
      }
      return arr;
    }

    /** Slightly varied star tints (warm/cool whites) with random brightness. */
    function makeStarColors(count: number): Float32Array {
      const tints = [
        [1, 1, 1],
        [1, 0.94, 0.82],
        [0.82, 0.89, 1],
        [1, 0.85, 0.68],
      ];
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const tint = tints[(Math.random() * tints.length) | 0];
        const b = 0.4 + Math.random() * 0.6;
        arr[i * 3] = tint[0] * b;
        arr[i * 3 + 1] = tint[1] * b;
        arr[i * 3 + 2] = tint[2] * b;
      }
      return arr;
    }

    function createStars(count: number, pointSize: number): THREE.Points {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(makeStarPositions(count), 3)
      );
      geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(makeStarColors(count), 3)
      );
      const material = new THREE.PointsMaterial({
        map: starSprite,
        size: pointSize,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        fog: false, // stars sit beyond the haze; don't wash them out
      });
      const points = new THREE.Points(geometry, material);
      points.frustumCulled = false; // the sphere follows the camera; never cull
      scene.add(points);
      return points;
    }

    const starsField = createStars(STAR_COUNT, 52);
    const starsBright = createStars(STAR_BRIGHT_COUNT, 120);
    starsField.add(starsBright); // share position + slow rotation

    // ================= procedural clouds (slow drift + morph) ============
    // Two world-anchored FBM layers — a low foggy cumulus deck and a high
    // cirrus veil — that drift very slowly and continuously change shape;
    // tinted by the day/night cycle and blended into the sky at the horizon.
    // Mobile LOW tier drops FBM octaves (5/4 -> 3/3): a huge fill-rate save
    // over the huge sky area, with only a subtle softening of the shapes.
    const clouds: SkyCloudsHandle = createSkyClouds(scene, {
      lowQuality: LOW_SPEC,
    });
    (window as unknown as { __clouds?: object }).__clouds = {
      layers: 2,
      setCoverage: (v: number) => clouds.setCoverage(v),
      stats: () => clouds.stats(),
    };

    // Whole-terrain rain: one uniform GPU-animated field whose 12,800-unit
    // seed box wraps around the player (so rain follows you across the
    // endless world at constant density), plus a LIGHT streak bump that
    // follows the player out to a 350-unit radius. page.tsx schedules
    // exactly one shower per in-game day (see rainIntensityFromHour) and
    // updateSky dims the sun/fog/sky while it pours.
    const rain: RainHandle = createRain(
      scene,
      LOW_SPEC ? { farDrops: 56000 } : undefined
    );
    let rainIntensity = 0; // 0..1, the daily storm
    (window as unknown as { __rain?: object }).__rain = {
      intensity: () => rainIntensity,
      window: RAIN_WINDOW,
      counts: rain.counts,
      audioMuted: rain.audioMuted,
      audioGain: rain.audioGain,
    };

    // 3D SKY ZONE SIGN: the biome's name rises into the sky as giant 3D
    // block letters (the voxel-font sign — see src/game/skyText.ts).
    const skyText: SkyTextHandle = createSkyText(scene);
    const GRASS_SIGN = { label: 'GRASSLANDS', color: 0x9fe06a };
    let zoneSignShown = false;

    // Puddles left on the terrain after each shower: as the player explores
    // the endless world, regions are scanned for flat plateau cells and
    // seeded with lobed, feather-edged water puddles that fill while it
    // rains (rippling, sky-mirroring) and dry out slowly afterwards.
    const water: GroundWaterHandle = createGroundWater(scene, {
      block: BLOCK,
      gridOffset: GRID_OFFSET,
      heightAt: terrain.blockHeight,
    });
    (window as unknown as { __water?: object }).__water = {
      stats: water.stats,
      wet: () => water.wet(),
      nearest: (x: number, z: number) => water.nearest(x, z),
    };

    // GREEN BUSH field: the uploaded glTF bush instanced across the whole
    // endless terrain — cells stream in around the player forever (see
    // src/game/bushSystem.ts). Spawn disc stays clear for the showcase.
    const bushes: BushSystemHandle = createBushes(scene, {
      block: BLOCK,
      gridOffset: GRID_OFFSET,
      surfaceYAt: terrain.surfaceYAt,
      blockHeight: terrain.blockHeight,
      lowSpec: LOW_SPEC,
      clearX: spawnFlat.x,
      clearZ: spawnFlat.z,
      clearRadius: 1500,
    });
    (window as unknown as { __bushes?: object }).__bushes = {
      ready: bushes.ready,
      stats: bushes.stats,
      wind: bushes.windInfo,
      field: bushes.fernFields,
    };

    // TREE TRUNK field: the uploaded low-poly trunk instanced across the
    // whole endless terrain — sparse, world-anchored streaming like the
    // bushes (see src/game/treeTrunks.ts). The spawn disc stays clear for
    // the showcase, and trunks are SOLID: pushOut() slides the player
    // around them instead of clipping through.
    const trunks: TrunkSystemHandle = createTrunks(scene, {
      block: BLOCK,
      gridOffset: GRID_OFFSET,
      surfaceYAt: terrain.surfaceYAt,
      blockHeight: terrain.blockHeight,
      lowSpec: LOW_SPEC,
      clearX: spawnFlat.x,
      clearZ: spawnFlat.z,
      clearRadius: 1500,
    });
    (window as unknown as { __trunks?: object }).__trunks = {
      ready: trunks.ready,
      stats: trunks.stats,
      field: trunks.treeFields,
    };

    // PINE groves: the uploaded PS1 low-poly pine (one mesh, one
    // 128×128 pixel texture) clustered into irregular forest patches
    // by a low-frequency grove hash, streamed with the same
    // world-anchored recycling scheme (see src/game/pineTrees.ts) and
    // SOLID: pushOut() slides the player around the trunks instead of
    // clipping through.
    const pines: PineSystemHandle = createPines(scene, {
      block: BLOCK,
      gridOffset: GRID_OFFSET,
      surfaceYAt: terrain.surfaceYAt,
      blockHeight: terrain.blockHeight,
      lowSpec: LOW_SPEC,
      clearX: spawnFlat.x,
      clearZ: spawnFlat.z,
      clearRadius: 1500,
    });
    (window as unknown as { __pines?: object }).__pines = {
      ready: pines.ready,
      stats: pines.stats,
    };

    // DEAD PINE skeletons: the same PS1 pine silhouette but weathered
    // bare (box-projected pixel bark, no green atlas) — scattered at a
    // much LOWER density than the live groves: lone snags in the
    // meadows and between the living stands. Same world-anchored
    // recycling scheme (see src/game/pineDeadTrees.ts) and SOLID:
    // pushOut() slides the player around the trunks.
    const pineDead: PineDeadSystemHandle = createPineDead(scene, {
      block: BLOCK,
      gridOffset: GRID_OFFSET,
      surfaceYAt: terrain.surfaceYAt,
      blockHeight: terrain.blockHeight,
      lowSpec: LOW_SPEC,
      clearX: spawnFlat.x,
      clearZ: spawnFlat.z,
      clearRadius: 1500,
    });
    (window as unknown as { __pineDead?: object }).__pineDead = {
      ready: pineDead.ready,
      stats: pineDead.stats,
    };

    // WATCHTOWER: the Minecraft-style voxel watch tower, cloned block by
    // block from the reference renders and spawned right beside the player
    // (see src/game/watchTower.ts). SOLID per-block collision on walls,
    // legs, railings and roof; the staircase, landing and platform floor
    // are WALKABLE surfaces the player climbs via the ground override.
    const tower: WatchTowerHandle = createWatchTower(scene, {
      surfaceYAt: terrain.surfaceYAt,
      x: spawnFlat.x + 700,
      z: spawnFlat.z - 450,
      lowSpec: LOW_SPEC,
    });
    (window as unknown as { __tower?: object }).__tower = {
      ready: tower.ready,
      debug: tower.debug,
      stats: tower.stats,
      ground: (x: number, z: number, y: number) =>
        tower.groundYAt(x, z, y, false),
    };
    // Dev/verification handle: direct scene access for tooling.
    (window as unknown as { __scene?: THREE.Scene }).__scene = scene;
    (window as unknown as { __cam?: THREE.PerspectiveCamera }).__cam = camera;

    // FERN LIFE FX: reactive particles + audio layered on the fern field
    // (footstep leaf puffs, gust-torn debris, procedural wind bed + rustle
    // one-shots). Sits on top of bushSystem's fern wind/trample upgrade.
    const fernLife: FernLifeHandle = createFernLife(scene, bushes, LOW_SPEC);
    (window as unknown as { __fernLife?: object }).__fernLife = {
      debug: fernLife.debug,
    };

    // ================= MD2 character (ratamahatta) =================
    const character = new MD2Character();

    let loaded = false;
    let currentAnim = 'stand';
    let oneShot: string | null = null;
    /** Mobile virtual joystick vector: x turns, y walks (analog -1..1). */
    const touchMoveVec = { x: 0, y: 0, active: false };
    /** Mobile RUN toggle — sprint speed while the joystick walks forward. */
    let sprintMode = false;
    let airborne = false;
    let vy = 0;
    /** Double-jump bookkeeping: jumps spent since last touching ground. */
    let jumpsUsed = 0;
    /** Vertical offset lifting the model so its feet rest exactly on the ground. */
    let footOffset = 0;

    const pos = new THREE.Vector3(spawnFlat.x, spawnFlat.y, spawnFlat.z);
    const prevFernPos = new THREE.Vector3().copy(pos); // fern FX speed probe
    let yaw = 0;

    // Dev/verification hook: teleport the player (tooling only — gameplay
    // never calls this). Mirrors the other window.__* debug handles.
    (
      window as unknown as {
        __devTp?: (x: number, z: number, yawAngle?: number) => void;
      }
    ).__devTp = (x: number, z: number, yawAngle?: number) => {
      pos.set(x, surfaceYAt(x, z), z);
      if (yawAngle !== undefined) yaw = yawAngle;
      vy = 0;
      airborne = false;
      jumpsUsed = 0;
    };

    function playAnim(name: string, once: boolean, hold = false) {
      currentAnim = name;
      character.setAnimation(name);

      if (once) {
        oneShot = name;
        const meshes: Array<ActionMesh | null> = [
          character.meshBody as ActionMesh | null,
          character.meshWeapon as ActionMesh | null,
        ];
        for (const mesh of meshes) {
          const action = mesh?.activeAction;
          if (action) {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = hold;
            action.setEffectiveTimeScale(1);
          }
        }
      }
    }

    function onAnimFinished() {
      oneShot = null;
    }

    character.onLoadComplete = () => {
      (window as unknown as { __char?: MD2Character }).__char = character;
      const body = character.meshBody;
      if (body) {
        // Normalize the raw Quake-scale model to ~CHAR_HEIGHT world units.
        const bbox = new THREE.Box3().setFromBufferAttribute(
          body.geometry.attributes.position as THREE.BufferAttribute
        );
        const rawHeight = bbox.max.y - bbox.min.y;
        const s = CHAR_HEIGHT / rawHeight;

        body.scale.setScalar(s);
        for (const weapon of character.weapons) weapon.scale.setScalar(s);
        footOffset = -s * bbox.min.y;
        character.root.position.y = pos.y + footOffset;
        character.scale = s;
      }

      character.setAnimation('stand');
      character.setSkin(0);
      character.setWeapon(-1); // unarmed: no weapon meshes are loaded
      character.mixer?.addEventListener('finished', onAnimFinished);
      loaded = true;
    };

    character.loadParts({
      baseUrl: '/models/md2/ratamahatta/',
      body: 'ratamahatta.md2',
      skins: SKINS.map((skin) => skin.file),
      weapons: [],
    });

    scene.add(character.root);

    // ================= vitals =================
    let health = MAX_HEALTH;
    let lastDamageAt = -1e9;
    let elapsed = 0;
    let deathTimer = 0; // > 0 while the death sequence plays
    const spawnPos = new THREE.Vector3(spawnFlat.x, spawnFlat.y, spawnFlat.z);

    function applyDamage(amount: number) {
      if (deathTimer > 0) return;
      health = Math.max(0, health - amount);
      lastDamageAt = elapsed;

      if (health <= 0) {
        deathTimer = RESPAWN_DELAY;
        playAnim('death', true, true); // hold the final death pose
        keys.clear();
      } else if (!airborne) {
        playAnim('pain', true);
      }
    }

    function respawn() {
      pos.copy(spawnPos);
      // respawn teleports across the endless world — mesh the ground under
      // your feet immediately so you never drop through the void
      terrain.ensureAround(spawnPos.x, spawnPos.z, 1, true);
      vy = 0;
      airborne = false;
      jumpsUsed = 0;
      yaw = 0;
      health = MAX_HEALTH;
      deathTimer = 0;
      camYawOffset = 0;
      zoneSignShown = false;
      playAnim('stand', false);
      updateCamera(true, 0); // snap the camera behind the respawned player
    }

    // ============ shared gameplay actions (keyboard + touch HUD) ============
    function actionJump() {
      if (
        phaseRef.current !== 'playing' ||
        !loaded ||
        deathTimer > 0
      ) {
        return;
      }
      if (!airborne) {
        // first jump: launch off the ground
        airborne = true;
        jumpsUsed = 1;
        vy = JUMP_SPEED;
        playAnim('jump', true);
        soundRef.current?.jump();
      } else if (jumpsUsed < MAX_JUMPS) {
        // DOUBLE JUMP: one extra launch while airborne — resets on landing.
        jumpsUsed += 1;
        vy = DOUBLE_JUMP_SPEED;
        playAnim('jump', true);
        soundRef.current?.jump();
      }
    }

    function actionRoar() {
      if (
        phaseRef.current !== 'playing' ||
        !loaded ||
        airborne ||
        deathTimer > 0
      ) {
        return;
      }
      playAnim('flip', true);
    }

    // debug/verification teleport (window.__cheats.tp): moves the player to
    // a world position, meshes the ground under their feet, snaps camera
    (window as unknown as {
      __cheats?: {
        tp(x: number, z: number): void;
        yaw(v: number): void;
        pitch(v: number): void;
        dist(v: number): void;
      };
    }).__cheats = {
      tp: (x: number, z: number) => {
        pos.set(x, surfaceYAt(x, z), z);
        vy = 0;
        airborne = false;
        terrain.ensureAround(x, z, 1, true);
        updateCamera(true, 0);
      },
      yaw: (v: number) => {
        yaw = v;
        camYawOffset = 0; // frame the facing exactly (no orbit residue)
        updateCamera(true, 0);
      },
      pitch: (v: number) => {
        camPitch = Math.min(CAM_MAX_PITCH, Math.max(CAM_MIN_PITCH, v));
        updateCamera(true, 0);
      },
      dist: (v: number) => {
        camDistTarget = Math.min(CAM_MAX_DIST, Math.max(CAM_MIN_DIST, v));
        updateCamera(false, 0);
      },
    };

    // Imperative handle for the mobile touch controls (rendered only on
    // touch devices). Also on window as __touchApi for tooling/verification.
    touchApiRef.current = {
      move: (x, y) => {
        if (phaseRef.current !== 'playing') return;
        touchMoveVec.x = x;
        touchMoveVec.y = y;
        touchMoveVec.active = true;
      },
      moveEnd: () => {
        touchMoveVec.x = 0;
        touchMoveVec.y = 0;
        touchMoveVec.active = false;
      },
      jump: () => actionJump(),
      roar: () => actionRoar(),
      setRun: (on) => {
        sprintMode = on;
      },
      exitToLobby: () => {
        if (phaseRef.current === 'playing' && deathTimer <= 0) {
          hudBridgeRef.current.enterLobby?.();
        }
      },
    };
    (window as unknown as { __touchApi?: TouchGameApi }).__touchApi =
      touchApiRef.current;

    // ================= input =================
    const keys = new Set<string>();

    /** Normalize to a stable code; falls back to event.key when code is empty
     *  (some automation tools and non-standard keyboards send no code). */
    function resolveCode(event: KeyboardEvent): string {
      if (event.code) return event.code;
      const key = event.key.toLowerCase();
      switch (key) {
        case 'w':
          return 'KeyW';
        case 'a':
          return 'KeyA';
        case 's':
          return 'KeyS';
        case 'd':
          return 'KeyD';
        case 'arrowup':
          return 'ArrowUp';
        case 'arrowdown':
          return 'ArrowDown';
        case 'arrowleft':
          return 'ArrowLeft';
        case 'arrowright':
          return 'ArrowRight';
        case ' ':
          return 'Space';
        case 'm':
          return 'KeyM';
        case 'escape':
          return 'Escape';
        default:
          return /^[1-5]$/.test(key) ? 'Digit' + key : '';
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      // typing in a HUD field is NEVER gameplay
      const tgt = event.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === 'INPUT' ||
          tgt.tagName === 'TEXTAREA' ||
          tgt.isContentEditable)
      ) {
        return;
      }
      const code = resolveCode(event);
      if (!code) return;

      if (code === 'Escape') {
        // Esc returns to the lobby (disabled during the death sequence)
        if (
          !event.repeat &&
          phaseRef.current === 'playing' &&
          deathTimer <= 0
        ) {
          hudBridgeRef.current.enterLobby?.();
        }
        return;
      }

      // all gameplay input is ignored while the lobby is showing
      if (phaseRef.current !== 'playing') return;

      if (
        code === 'Space' ||
        code === 'ArrowUp' ||
        code === 'ArrowDown' ||
        code === 'ArrowLeft' ||
        code === 'ArrowRight'
      ) {
        event.preventDefault();
      }

      if (code === 'Space') {
        // the uploaded jump SFX plays with every real jump
        if (!event.repeat) actionJump();
      } else if (code === 'Digit5' || code === 'Numpad5') {
        if (!event.repeat) actionRoar();
      } else if (
        ACTION_KEYS[code] &&
        !event.repeat &&
        loaded &&
        !airborne &&
        deathTimer <= 0
      ) {
        playAnim(ACTION_KEYS[code], true);
      }

      if (code === 'KeyM' && !event.repeat) toggleMute();

      keys.add(code);
    }

    function onKeyUp(event: KeyboardEvent) {
      const code = resolveCode(event);
      if (code) keys.delete(code);
    }

    function onBlur() {
      keys.clear();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    // ================= running sound (GRASS surface) =================
    // Loops while the character actually walks or runs on the grass
    // (moving + grounded); pauses on idle, jumps, one-shot emotes, death
    // and lobby. The mute toggle silences it.
    const runSound = new Audio('/sounds/running-forest.wav');
    runSound.loop = true;
    runSound.volume = RUN_SOUND_VOLUME;
    runSound.preload = 'auto';
    let runSoundActive = false;

    function setRunSound(active: boolean) {
      if (active === runSoundActive) return;
      runSoundActive = active;

      if (active) {
        runSound.currentTime = 0;
        runSound.play().catch(() => {
          // Autoplay is rejected until the first user gesture; clear the flag
          // so the loop retries automatically on later frames.
          runSoundActive = false;
        });
      } else {
        runSound.pause();
      }
    }

    // ================= debug handle (invisible) =================
    const debug: PlayerDebugInfo = {
      loaded: false,
      animation: 'stand',
      moving: false,
      airborne: false,
      x: 0,
      y: 0,
      z: 0,
      charMinY: 0,
      charMaxY: 0,
      timeOfDay: DAY_START_HOUR,
      sprint: false,
      touchMove: false,
      phase: 'lobby',
    };
    (window as unknown as { __player?: PlayerDebugInfo }).__player = debug;
    (window as unknown as { __runSound?: HTMLAudioElement }).__runSound =
      runSound;
    (window as unknown as {
      __dayNight?: {
        hour(): number;
        setHour(hour: number): void;
        sunHeight(): number;
        sunDir(): number[];
        moonDir(): number[];
      };
    }).__dayNight = {
      hour: () => timeHour,
      setHour: (hour: number) => {
        timeHour = ((hour % 24) + 24) % 24;
      },
      sunHeight: () => sunDir.y,
      sunDir: () => {
        updateSunMoonDirections();
        return sunDir.toArray();
      },
      moonDir: () => {
        updateSunMoonDirections();
        return moonDir.toArray();
      },
    };

    // ================= renderer =================
    // THE mobile hang fix: full devicePixelRatio (3x on phones) + MSAA is a
    // brutal fill-rate bill, so LOW_SPEC drops antialias and caps the render
    // scale at 1.5 — desktop keeps the crisp 2x + MSAA look either way.
    renderer = new THREE.WebGLRenderer({
      antialias: !LOW_SPEC,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio,
        LOW_SPEC ? LOW_DPR_CAP : HIGH_DPR_CAP
      )
    );
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);

    // performance surface for tooling / verification (window.__perf)
    (window as unknown as { __perf?: object }).__perf = {
      lowSpec: LOW_SPEC,
      dpr: window.devicePixelRatio,
      pixelRatio: renderer.getPixelRatio(),
      antialias: !LOW_SPEC,
      shadowMapSize: LOW_SPEC ? 1024 : 2048,
      frameCapFps: LOW_SPEC ? 30 : 0,
      farDrops: rain.counts.far,
      triangles: () => renderer.info.render.triangles,
      drawCalls: () => renderer.info.render.calls,
    };

    // place camera behind the character right away
    const camDesired = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();

    // --- mouse-controlled orbit / zoom state ---
    let camYawOffset = 0; // orbit angle around the character (rad)
    let camPitch = LOBBY_PITCH; // starts in the lobby showcase framing
    let camDist = LOBBY_DIST;
    let camDistTarget = LOBBY_DIST;
    let orbitDragging = false;
    let lastPointerX = 0;
    let lastPointerY = 0;

    // --- lobby <-> gameplay camera blending ---
    // 1 = lobby showcase (camera in front of the character), 0 = gameplay
    // rig (camera behind). START tweens this to 0, sweeping the camera
    // around the character instead of hard cutting.
    let lobbyBlend = 1;
    let lastPhase: GamePhase = phaseRef.current;
    let camIgnoreClearance = false;

    /** Active pointers on the canvas — one finger orbits, two fingers
     *  pinch-zoom (the touch counterpart of the mouse wheel). */
    const activePointers = new Map<number, { x: number; y: number }>();
    let pinchLastDist = 0;

    function onPointerDown(event: PointerEvent) {
      activePointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      if (activePointers.size === 1) {
        orbitDragging = true;
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        try {
          renderer.domElement.setPointerCapture(event.pointerId);
        } catch {
          // stale/synthetic pointer ids can't be captured; orbit still works
        }
        renderer.domElement.style.cursor = 'grabbing';
      } else {
        // second finger: orbit hands over to pinch zoom
        orbitDragging = false;
        const points = [...activePointers.values()];
        pinchLastDist = Math.hypot(
          points[0].x - points[1].x,
          points[0].y - points[1].y
        );
      }
    }

    function onPointerMove(event: PointerEvent) {
      if (!activePointers.has(event.pointerId)) return;
      activePointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      // --- pinch zoom (two fingers) ---
      if (activePointers.size >= 2) {
        const points = [...activePointers.values()];
        const dist = Math.hypot(
          points[0].x - points[1].x,
          points[0].y - points[1].y
        );
        if (pinchLastDist > 0 && phaseRef.current === 'playing' && dist > 0) {
          camDistTarget = Math.min(
            CAM_MAX_DIST,
            Math.max(
              CAM_MIN_DIST,
              camDistTarget + (pinchLastDist - dist) * 1.4
            )
          );
        }
        pinchLastDist = dist;
        return;
      }

      // --- single-pointer orbit ---
      if (!orbitDragging) return;

      const dx = event.clientX - lastPointerX;
      const dy = event.clientY - lastPointerY;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;

      // in the lobby the drag spins the character's showcase turntable
      if (phaseRef.current === 'lobby') {
        yaw -= dx * 0.008;
        return;
      }

      camYawOffset -= dx * 0.005;
      camPitch = Math.min(
        CAM_MAX_PITCH,
        Math.max(CAM_MIN_PITCH, camPitch + dy * 0.005)
      );
    }

    function onPointerUp(event: PointerEvent) {
      activePointers.delete(event.pointerId);
      if (activePointers.size < 2) pinchLastDist = 0;

      if (activePointers.size === 1) {
        // one finger remains after a pinch: resume orbiting from its spot
        const [remaining] = [...activePointers.values()];
        orbitDragging = true;
        lastPointerX = remaining.x;
        lastPointerY = remaining.y;
        return;
      }

      if (activePointers.size === 0) {
        orbitDragging = false;
        renderer.domElement.style.cursor = 'grab';
      }
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    }

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      if (phaseRef.current === 'lobby') return; // no zoom in the lobby
      camDistTarget = Math.min(
        CAM_MAX_DIST,
        Math.max(CAM_MIN_DIST, camDistTarget + event.deltaY * 0.5)
      );
    }

    function updateCamera(immediate: boolean, dt: number) {
      // smooth zoom easing
      camDist += (camDistTarget - camDist) * Math.min(1, 10 * dt);

      // Blend the lobby framing (in front of the character, angle + PI) into
      // the gameplay rig (behind, angle + camYawOffset) with smoothstep, so
      // START sweeps the camera around the character instead of cutting.
      const blendT = 1 - lobbyBlend;
      const blendEase = blendT * blendT * (3 - 2 * blendT);
      const angleOffset = Math.PI * (1 - blendEase) + camYawOffset * blendEase;
      const pitch = LOBBY_PITCH + (camPitch - LOBBY_PITCH) * blendEase;
      const dist = LOBBY_DIST + (camDist - LOBBY_DIST) * blendEase;

      const angle = yaw + angleOffset;
      const sinA = Math.sin(angle);
      const cosA = Math.cos(angle);
      const horizontal = dist * Math.cos(pitch);
      const vertical = dist * Math.sin(pitch);

      camDesired.set(
        pos.x - sinA * horizontal,
        pos.y + LOOK_HEIGHT + vertical,
        pos.z - cosA * horizontal
      );

      if (immediate) {
        camera.position.copy(camDesired);
      } else {
        camera.position.lerp(camDesired, 1 - Math.exp(-6 * dt));
      }

      if (!camIgnoreClearance) {
        const minY =
          surfaceYAt(camera.position.x, camera.position.z) +
          CAM_MIN_CLEARANCE;
        if (camera.position.y < minY) camera.position.y = minY;
      }

      lookTarget.set(pos.x, pos.y + LOOK_HEIGHT, pos.z);
      camera.lookAt(lookTarget);
    }

    // ================= day/night sky driver =================
    // One directional light plays both sun and moon: warm bright daylight,
    // crossfaded through dusk into dim blue moonlight (real shadows in both
    // phases). The sky blends night -> day with an orange horizon band at
    // dawn/dusk; the sun/moon discs and star field re-anchor to the camera
    // every frame. Called once per frame AFTER the camera update.
    const skyColor = new THREE.Color();
    const tmpColorA = new THREE.Color();
    const tmpColorB = new THREE.Color();
    scene.background = skyColor; // mutated in place each frame

    function updateSky(dt: number, stormIntensity: number) {
      updateSunMoonDirections();

      const sunUp = THREE.MathUtils.smoothstep(sunDir.y, -0.04, 0.16);
      const moonUp = THREE.MathUtils.smoothstep(moonDir.y, -0.04, 0.16);
      // 1 when the sun sits on the horizon (dawn/dusk), 0 at high day/deep night
      const horizonGlow =
        1 - THREE.MathUtils.smoothstep(Math.abs(sunDir.y), 0.02, 0.3);

      // --- directional light: sun by day, moon by night ---
      const wSun = sunUp * sunUp;
      const wMoon = moonUp;
      const wSum = wSun + wMoon;
      const lightDir = wSun >= wMoon ? sunDir : moonDir;
      directionalLight.position
        .copy(pos)
        .addScaledVector(lightDir, SUN_DISTANCE);
      directionalLight.target.position.copy(pos);
      directionalLight.intensity =
        (wSun * SUN_LIGHT_MAX + wMoon * MOON_LIGHT_MAX) *
        (1 - 0.55 * stormIntensity); // storm clouds blot out the light
      if (wSum > 1e-3) {
        tmpColorA
          .copy(SUNLIGHT_LOW)
          .lerp(SUNLIGHT_HIGH, THREE.MathUtils.clamp(sunDir.y / 0.45, 0, 1))
          .multiplyScalar(wSun);
        tmpColorB.copy(MOONLIGHT).multiplyScalar(wMoon);
        tmpColorA.add(tmpColorB).multiplyScalar(1 / wSum);
        directionalLight.color.copy(tmpColorA);
      }

      // --- ambient: dims and cools off at night ---
      ambientLight.color.copy(AMBIENT_NIGHT).lerp(AMBIENT_DAY, sunUp);
      ambientLight.intensity =
        (AMBIENT_NIGHT_I + (AMBIENT_DAY_I - AMBIENT_NIGHT_I) * sunUp) *
        (1 - 0.28 * stormIntensity);

      // --- sky: night -> day, tinted orange around the horizon crossings ---
      skyColor.copy(SKY_NIGHT).lerp(SKY_DAY, sunUp);
      skyColor.lerp(SKY_SUNSET, horizonGlow * (0.3 + 0.5 * sunUp));
      skyColor.lerp(STORM_SKY, 0.55 * stormIntensity); // wet grey ceiling

      // --- sun disc: follows the real orbit, warming orange as it sets ---
      sunMesh.position
        .copy(camera.position)
        .addScaledVector(sunDir, SUN_VISUAL_DISTANCE);
      sunMesh.lookAt(camera.position);
      sunMaterial.opacity =
        THREE.MathUtils.smoothstep(sunDir.y, -0.09, 0.03) *
        (1 - 0.85 * stormIntensity);
      sunMaterial.color
        .copy(SUN_TINT_SET)
        .lerp(SUN_TINT_NOON, 1 - horizonGlow * 0.85);

      // --- moon disc: rides the opposite side of the sky ---
      moonMesh.position
        .copy(camera.position)
        .addScaledVector(moonDir, SUN_VISUAL_DISTANCE);
      moonMesh.lookAt(camera.position);
      moonMaterial.opacity =
        THREE.MathUtils.smoothstep(moonDir.y, -0.09, 0.03) *
        (1 - 0.85 * stormIntensity);

      // --- stars: fade in at night, drift very slowly ---
      starsField.position.copy(camera.position);
      starsField.rotation.y += dt * 0.005;
      (starsField.material as THREE.PointsMaterial).opacity =
        moonUp * 0.95 * (1 - stormIntensity);
      (starsBright.material as THREE.PointsMaterial).opacity =
        moonUp * 0.95 * (1 - stormIntensity);

      // --- fog: tint with the sky, thickens at dawn/dusk and in rain ---
      const fog = scene.fog as THREE.FogExp2 | null;
      if (fog) {
        fog.color.copy(skyColor);
        fog.density =
          FOG_DENSITY * (1 + 0.45 * horizonGlow + 1.15 * stormIntensity);
      }

      // --- clouds: drift + structure morph + day/night tint ---
      clouds.update({
        dt,
        cameraPos: camera.position,
        skyColor,
        lightDir, // rim shading follows the active sun/moon light
        sunUp,
        horizonGlow,
        lightColor: directionalLight.color,
        storm: stormIntensity, // rain cells darken + thicken the deck
      });
    }

    updateCamera(true, 0);
    updateSky(0, 0);

    renderer.domElement.style.cursor = 'grab';
    // touch screens: the canvas owns its gestures (no browser scroll/pinch
    // interference while dragging the camera)
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    function onWindowResize() {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }

    window.addEventListener('resize', onWindowResize);

    // ================= animation loop =================
    /** Last frame's rAF timestamp — drives the mobile ~30fps frame cap. */
    let lastRenderTime = 0;

    function animate(time?: DOMHighResTimeStamp) {
      // mobile frame cap: the loop still fires at the display rate but we
      // only render every ~33ms — every skipped beat returns CPU AND GPU
      // time to the phone. Skipped frames are NOT simulated: timer deltas
      // simply bridge the gap, so game time (day cycle, physics) stays
      // wall-clock exact. Desktop is untouched (uncapped).
      if (LOW_SPEC && time !== undefined) {
        if (
          lastRenderTime !== 0 &&
          time - lastRenderTime < LOW_FRAME_INTERVAL_MS
        ) {
          return;
        }
        lastRenderTime = time;
      }

      timer.update();
      // real wall seconds (mild cap for tab switches)
      const wallDt = Math.min(timer.getDelta(), 2);
      // physics/animation delta, clamped so a hitch can't teleport anything
      const dt = Math.min(wallDt, 0.1);
      elapsed += dt;

      // --- lobby <-> gameplay phase transitions ---
      if (phaseRef.current !== lastPhase) {
        lastPhase = phaseRef.current;
        keys.clear();
        touchMoveVec.active = false;
        touchMoveVec.x = 0;
        touchMoveVec.y = 0;

        if (phaseRef.current === 'playing') {
          // deploy: gameplay orbit defaults; the camera sweeps via lobbyBlend
          camYawOffset = 0;
          camPitch = CAM_DEFAULT_PITCH;
          camDistTarget = CAM_DIST;
          camIgnoreClearance = false;
        } else {
          // back to the showcase: hard cut to the frontal framing
          camYawOffset = 0;
          camPitch = LOBBY_PITCH;
          camDistTarget = LOBBY_DIST;
          lobbyBlend = 1;
          setRunSound(false);
          oneShot = null;
        }
      }

      const inLobby = phaseRef.current === 'lobby';

      // lobby turntable: idle character slowly rotates for the showcase
      if (inLobby && deathTimer <= 0) yaw += LOBBY_TURN_SPEED * dt;

      // tween the camera from the lobby framing into the gameplay rig
      if (!inLobby && lobbyBlend > 0) {
        lobbyBlend = Math.max(0, lobbyBlend - dt / LOBBY_BLEND_TIME);
      }

      // --- movement input (keyboard + mobile joystick) ---
      const controlsLocked = deathTimer > 0 || inLobby;
      let moveInput = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp')) moveInput += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) moveInput -= 1;
      // virtual joystick: analog forward/back while the keys are idle
      if (touchMoveVec.active && moveInput === 0) {
        moveInput = THREE.MathUtils.clamp(touchMoveVec.y, -1, 1);
      }

      // SPRINT: the mobile RUN toggle, or holding Shift while moving forward
      // on the keyboard — forward speed then jumps from WALK_SPEED to
      // RUN_SPEED (backward and turning keep their own pace).
      const shiftHeld = keys.has('ShiftLeft') || keys.has('ShiftRight');
      const sprinting = sprintMode || (shiftHeld && moveInput > 0);

      let turnInput = controlsLocked
        ? 0
        : (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) -
          (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0);
      if (!controlsLocked && touchMoveVec.active) {
        turnInput += -touchMoveVec.x; // stick right = turn right
      }

      yaw += turnInput * TURN_SPEED * dt;

      const moving = moveInput !== 0 && !controlsLocked;

      if (moving && loaded) {
        const speed =
          moveInput > 0 ? (sprinting ? RUN_SPEED : WALK_SPEED) : BACK_SPEED;
        pos.x += Math.sin(yaw) * speed * dt * moveInput;
        pos.z += Math.cos(yaw) * speed * dt * moveInput;
        // no world-edge clamp — the terrain streams in forever
      }

      // solid tree trunks: slide out of any trunk the step walked into
      // (the field is world-anchored, so trunks never pop up underfoot)
      if (loaded) {
        const slide = trunks.pushOut(pos.x, pos.z, PLAYER_RADIUS);
        pos.x = slide.x;
        pos.z = slide.z;
      }

      // solid pine trunks: slide out of any pine the step walked into
      // (the field is world-anchored, so pines never pop up underfoot)
      if (loaded) {
        const slide = pines.pushOut(pos.x, pos.z, PLAYER_RADIUS);
        pos.x = slide.x;
        pos.z = slide.z;
      }

      // solid dead pines: slide out of any snag the step walked into
      if (loaded) {
        const slide = pineDead.pushOut(pos.x, pos.z, PLAYER_RADIUS);
        pos.x = slide.x;
        pos.z = slide.z;
      }

      // solid watchtower: slide out of any tower block (walls, legs,
      // railings, roof). The stairs / landing / platform are walkable, so
      // only in-face tower geometry pushes — the stairs stay climbable.
      if (loaded) {
        const slide = tower.pushOut(pos.x, pos.z, PLAYER_RADIUS, pos.y);
        pos.x = slide.x;
        pos.z = slide.z;
      }

      // --- health regen (after a damage-free grace period) ---
      if (
        deathTimer <= 0 &&
        health < MAX_HEALTH &&
        elapsed - lastDamageAt > HEALTH_REGEN_DELAY
      ) {
        health = Math.min(MAX_HEALTH, health + HEALTH_REGEN_RATE * dt);
      }

      // stream the endless terrain around the traveller: chunks ahead of
      // the movement are meshed, terrain that fell out of sight behind the
      // player is released (both happen inside this single call)
      terrain.update(pos.x, pos.z);

      // bushes recycle their cells around the traveller (cheap no-op when
      // the player hasn't crossed a block boundary); the ctx feeds the fern
      // life upgrade: wind clock dt, storm rain (frond droop + wind boost)
      // and the sun direction/colour for the backlight translucency
      bushes.update(pos.x, pos.z, {
        dt,
        rain: rainIntensity,
        sunX: sunDir.x,
        sunY: sunDir.y,
        sunZ: sunDir.z,
        sunColor: directionalLight.color,
      });

      // tree trunks recycle their cells around the traveller (a cheap
      // no-op until the player crosses a block boundary)
      trunks.update(pos.x, pos.z);

      // pines recycle on the same cadence too
      pines.update(pos.x, pos.z);

      // dead pines recycle on the same cadence as well
      pineDead.update(pos.x, pos.z);

      // --- ground / gravity ---
      let groundY = surfaceYAt(pos.x, pos.z);
      if (loaded) {
        // the watchtower's stairs / landing / platform floor are walkable
        // surfaces: standing on them overrides the terrain (while ascending
        // mid-jump only surfaces already cleared count, so a rising jump
        // never snaps onto a step it hasn't reached yet)
        const towerGround = tower.groundYAt(
          pos.x,
          pos.z,
          pos.y,
          airborne && vy > 0
        );
        if (towerGround > groundY) groundY = towerGround;
      }
      if (airborne) {
        vy -= GRAVITY * dt;
        pos.y += vy * dt;
        if (pos.y <= groundY) {
          pos.y = groundY;
          const impact = -vy;
          vy = 0;
          airborne = false;
          jumpsUsed = 0; // grounded again — the mid-air double jump refills

          if (impact > FALL_DAMAGE_MIN_SPEED) {
            applyDamage(
              Math.min(
                MAX_HEALTH,
                (impact - FALL_DAMAGE_MIN_SPEED) * FALL_DAMAGE_SCALE
              )
            );
          }
        }
      } else if (groundY < pos.y - 140) {
        // the ground just dropped away (stepped off the tower platform or
        // stairs): become a real fall instead of gliding down
        airborne = true;
        vy = 0;
        jumpsUsed = 0;
      } else {
        pos.y += (groundY - pos.y) * Math.min(1, 12 * dt);
      }

      character.root.position.set(pos.x, pos.y + footOffset, pos.z);

      character.root.rotation.y = yaw;

      // advance the in-game clock (full 24h every CYCLE_SECONDS)
      timeHour = (timeHour + (24 / CYCLE_SECONDS) * dt) % 24;

      // --- animation state machine / death sequence ---
      if (deathTimer > 0) {
        deathTimer -= dt;
        if (deathTimer <= 0) respawn();
      } else {
        const desired = oneShot ?? (airborne ? 'jump' : moving ? 'run' : 'stand');
        if (loaded && desired !== currentAnim) {
          playAnim(desired, false);
        }
      }

      character.update(dt);

      // --- camera + sky (sky re-anchors to the final camera position) ---
      updateCamera(false, dt);

      // one shower per in-game day — the RAIN system (kept feature)
      const stormIntensity = rainIntensityFromHour(timeHour);
      rainIntensity = stormIntensity;
      rain.update(dt, pos, rainIntensity);

      // fern life FX: trample disturbance + leaf puffs + gust debris +
      // reactive wind/rustle audio (reads the live fern wind field)
      const fernSpeedXZ = Math.hypot(
        pos.x - prevFernPos.x,
        pos.z - prevFernPos.z
      ) / Math.max(dt, 1e-4);
      prevFernPos.copy(pos);
      fernLife.update(
        dt,
        pos.x,
        pos.y,
        pos.z,
        fernSpeedXZ,
        bushes.windInfo(),
        rainIntensity
      );

      // the GRASSLANDS sky sign: raises once per deploy
      if (!inLobby && !zoneSignShown && !controlsLocked) {
        zoneSignShown = true;
        skyText.show(GRASS_SIGN.label, GRASS_SIGN.color);
      }
      skyText.update(dt, camera);

      updateSky(dt, stormIntensity);

      // game audio: rain loop follows the storm; the mute toggle also
      // silences the running footsteps (plain HTMLAudioElement)
      const sfx = soundRef.current;
      if (sfx) {
        sfx.setRain(rainIntensity);
        const runVol = sfx.isMuted() ? 0 : RUN_SOUND_VOLUME;
        if (runSound.volume !== runVol) runSound.volume = runVol;
        setRunSound(
          loaded &&
            moving &&
            !airborne &&
            deathTimer <= 0 &&
            !controlsLocked &&
            runVol > 0.001
        );
      }

      // puddles GROW slowly while it pours and dry slowly after (sky colour
      // + sun drive their look; fog colour is re-synced inside updateSky)
      const fog = scene.fog as THREE.FogExp2 | null;
      water.update(
        dt,
        rainIntensity,
        fog ? fog.color : SKY_DAY,
        directionalLight,
        pos.x,
        pos.z
      );

      renderer.render(scene, camera);

      // --- debug info ---
      const charBox = new THREE.Box3().setFromObject(character.root);
      debug.loaded = loaded;
      debug.animation = currentAnim;
      debug.moving = moving;
      debug.airborne = airborne;
      debug.x = pos.x;
      debug.y = pos.y;
      debug.z = pos.z;
      debug.charMinY = Math.round(charBox.min.y);
      debug.charMaxY = Math.round(charBox.max.y);
      debug.timeOfDay = timeHour;
      debug.sprint = sprinting;
      debug.touchMove = touchMoveVec.active;
      debug.phase = phaseRef.current;
    }

    renderer.setAnimationLoop(animate);

    // ================= cleanup =================
    return () => {
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);

      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);

      renderer.setAnimationLoop(null);

      setRunSound(false);
      runSound.pause();
      runSound.src = '';
      delete (window as unknown as { __runSound?: HTMLAudioElement })
        .__runSound;

      touchApiRef.current = null;
      delete (window as unknown as { __touchApi?: TouchGameApi }).__touchApi;

      character.mixer?.stopAllAction();
      const meshes = [character.meshBody, ...character.weapons];
      for (const mesh of meshes) {
        if (!mesh) continue;
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        for (const mat of mats) {
          const lambert = mat as THREE.MeshLambertMaterial;
          lambert.map?.dispose();
          lambert.dispose();
        }
      }
      for (const skin of [...character.skinsBody, ...character.skinsWeapon]) {
        skin.dispose();
      }
      scene.remove(character.root);

      terrain.dispose();
      scene.remove(sunMesh);
      sunMesh.geometry.dispose();
      sunMaterial.map?.dispose();
      sunMaterial.dispose();

      scene.remove(moonMesh);
      moonMesh.geometry.dispose();
      moonMaterial.map?.dispose();
      moonMaterial.dispose();

      scene.remove(starsField);
      starsField.geometry.dispose();
      (starsField.material as THREE.PointsMaterial).dispose();
      starsBright.geometry.dispose();
      (starsBright.material as THREE.PointsMaterial).dispose();
      starSprite.dispose();
      timer.disconnect();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }

      clouds.dispose();
      delete (window as unknown as { __clouds?: object }).__clouds;

      rain.dispose();
      delete (window as unknown as { __rain?: object }).__rain;
      bushes.dispose();
      delete (window as unknown as { __bushes?: object }).__bushes;
      trunks.dispose();
      delete (window as unknown as { __trunks?: object }).__trunks;
      pines.dispose();
      delete (window as unknown as { __pines?: object }).__pines;
      pineDead.dispose();
      delete (window as unknown as { __pineDead?: object }).__pineDead;
      fernLife.dispose();
      delete (window as unknown as { __fernLife?: object }).__fernLife;
      water.dispose();
      delete (window as unknown as { __water?: object }).__water;
      delete (window as unknown as { __cheats?: object }).__cheats;

      skyText.dispose();

      scene.fog = null;

      delete (window as unknown as { __player?: PlayerDebugInfo }).__player;
      delete (window as unknown as { __char?: MD2Character }).__char;
      delete (window as unknown as {
        __dayNight?: {
          hour(): number;
          setHour(hour: number): void;
          sunHeight(): number;
          sunDir(): number[];
          moonDir(): number[];
        };
      }).__dayNight;
    };
  }, []);

  return (
    <main className="fixed inset-0 overflow-hidden bg-[#bfd1e5]">
      <div ref={containerRef} className="absolute inset-0" />

      {/* ================= LOBBY dashboard overlay ================= */}
      {phase === 'lobby' && (
        <div className="pointer-events-none absolute inset-0 z-10 select-none">
          {/* readability scrims over the 3D showcase */}
          <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-zinc-950/70 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-zinc-950/70 to-transparent" />

          {/* LEFT HALF HEADER — one sharp-cornered glass bar welded to the
              top-left corner of the screen: player profile | divider | coin
              balance. */}
          <header
            aria-label="Player header"
            className="pointer-events-auto absolute left-0 top-0 flex w-[calc(100%-8.5rem)] items-center gap-2.5 border border-amber-400/40 bg-zinc-950/70 py-2 pl-3 pr-2 shadow-xl backdrop-blur-md sm:w-[calc(50%-2rem)] sm:gap-3 sm:pl-4 sm:pr-4 [clip-path:polygon(0_0,100%_0,100%_50%,calc(100%_-_28px)_100%,0_100%)]"
          >
            {/* sharp amber underline fading toward the logo half */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-amber-400/80 via-amber-400/25 to-transparent"
            />
            {/* amber accent line riding the chamfered bottom-right cut */}
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-[13px] right-[-10px] h-px w-12 -rotate-45 bg-gradient-to-r from-amber-400/80 to-amber-400/5 sm:bottom-3.5"
            />
            {/* profile */}
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="grid h-9 w-9 shrink-0 place-items-center bg-gradient-to-br from-amber-300 to-orange-600 text-base font-black text-zinc-950 sm:h-10 sm:w-10">
                {PLAYER_NAME.charAt(0)}
              </div>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-xs font-black tracking-wide text-zinc-100 sm:text-sm">
                  {PLAYER_NAME}
                </p>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] font-bold text-zinc-300">
                  <span className="flex items-center gap-1">
                    <Gem className="h-3 w-3 text-emerald-400" aria-hidden />
                    {PLAYER_GEMS}
                  </span>
                </div>
              </div>
            </div>

            {/* divider between profile and currency */}
            <span
              aria-hidden
              className="h-8 w-px shrink-0 bg-gradient-to-b from-transparent via-zinc-500/70 to-transparent"
            />

            {/* coin balance */}
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="grid h-9 w-9 shrink-0 place-items-center border border-amber-400/50 bg-amber-400/15 sm:h-10 sm:w-10"
              >
                <Coins className="h-5 w-5 text-amber-400" />
              </span>
              <div className="leading-none">
                <p className="hidden text-[8px] font-black uppercase tracking-[0.3em] text-zinc-400 sm:block sm:text-[9px]">
                  Coins
                </p>
                <p className="text-sm font-black tabular-nums tracking-wide text-amber-300 sm:mt-1 sm:text-base">
                  {PLAYER_COINS}
                </p>
              </div>
            </div>
          </header>

          {/* top-right: game logo */}
          <div className="absolute right-3 top-2 text-right sm:right-5 sm:top-3">
            <h1 className="text-2xl font-black italic leading-none tracking-tighter text-zinc-50 drop-shadow-[0_2px_0_rgba(0,0,0,0.55)] sm:text-4xl">
              RAT<span className="text-amber-400">FIRE</span>
            </h1>
            <p className="mt-1 hidden text-[9px] font-bold uppercase tracking-[0.35em] text-zinc-300 sm:block">
              Classic · Bermuda
            </p>
          </div>

          {/* bottom-left hint */}
          <p className="absolute bottom-5 left-4 hidden text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-400/90 sm:block">
            Drag to rotate · Enter to deploy
          </p>

          {/* bottom-centre: push the whole game source to GitHub */}
          <button
            type="button"
            onClick={(event) => {
              event.currentTarget.blur();
              setGhOpen(true);
            }}
            aria-label="Save source code to GitHub"
            aria-haspopup="dialog"
            className="pointer-events-auto group absolute bottom-5 left-1/2 z-20 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full border-2 border-zinc-600/60 bg-zinc-950/75 text-zinc-200 shadow-[0_8px_30px_-8px_rgba(0,0,0,0.8)] backdrop-blur-md transition-all duration-200 hover:scale-110 hover:border-amber-400/70 hover:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 active:scale-95 sm:bottom-8 sm:h-16 sm:w-16"
          >
            <GithubMark className="h-6 w-6 transition-transform duration-200 group-hover:rotate-6 sm:h-7 sm:w-7" />
          </button>

          {/* START */}
          <button
            type="button"
            onClick={(event) => {
              event.currentTarget.blur();
              enterGame();
            }}
            aria-label="Start game"
            className="group pointer-events-auto absolute bottom-5 right-4 outline-none sm:bottom-8 sm:right-8"
          >
            <span className="flex -skew-x-12 items-center bg-gradient-to-b from-amber-300 via-amber-400 to-orange-500 py-3 pl-7 pr-5 shadow-[0_10px_40px_-10px_rgba(251,146,60,0.9)] ring-1 ring-amber-200/70 transition-all duration-200 group-hover:scale-105 group-hover:shadow-[0_12px_50px_-8px_rgba(251,146,60,1)] group-focus-visible:ring-2 group-focus-visible:ring-white group-active:scale-95 sm:py-4 sm:pl-11 sm:pr-7">
              <span className="flex skew-x-12 items-center gap-2.5 text-xl font-black italic tracking-[0.12em] text-zinc-950 sm:text-2xl">
                START
                <Play
                  className="h-5 w-5 fill-zinc-950 sm:h-6 sm:w-6"
                  aria-hidden
                />
              </span>
            </span>
          </button>
        </div>
      )}

      {/* ================= GitHub export panel (centre modal) ================= */}
      {ghOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Save source code to GitHub"
          className="absolute inset-0 z-50 flex items-center justify-center p-4"
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close GitHub panel"
            onClick={() => setGhOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-zinc-950/70 backdrop-blur-sm focus-visible:outline-none"
          />
          <section className="relative w-[min(92vw,26rem)] rounded-2xl border border-amber-400/30 bg-zinc-950/95 p-5 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]">
            <div className="flex items-center justify-between border-b border-zinc-700/60 pb-3">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-zinc-100 text-zinc-950">
                  <GithubMark className="h-6 w-6" />
                </span>
                <div>
                  <h2 className="text-sm font-black uppercase tracking-[0.22em] text-zinc-100">
                    Push to GitHub
                  </h2>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    Back up the full game source
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setGhOpen(false)}
                aria-label="Close GitHub panel"
                className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {ghStatus === 'success' ? (
              <div className="mt-4 space-y-4">
                <p className="flex items-center gap-2 text-xs font-bold text-emerald-300">
                  <Check className="h-4 w-4 shrink-0" aria-hidden />
                  Saved {ghFiles} source files to GitHub
                </p>
                <a
                  href={ghUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2.5 text-xs font-bold text-amber-300 underline underline-offset-4 transition-colors hover:bg-amber-400/20"
                >
                  {ghUrl}
                </a>
                <p className="text-[10px] font-semibold uppercase leading-snug tracking-widest text-zinc-500">
                  The repository opens in a new tab — every future save adds a
                  fresh commit.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setGhStatus('idle')}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-xs font-black uppercase tracking-widest text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
                  >
                    Save to another repo
                  </button>
                  <button
                    type="button"
                    onClick={() => setGhOpen(false)}
                    className="flex-1 rounded-lg bg-gradient-to-b from-amber-300 via-amber-400 to-orange-500 px-3 py-2.5 text-xs font-black uppercase tracking-widest text-zinc-950 transition-all hover:brightness-110"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form
                className="mt-4 space-y-3.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveToGithub();
                }}
              >
                <label className="block">
                  <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-zinc-400">
                    GitHub token
                  </span>
                  <div className="relative">
                    <input
                      type={ghShowToken ? 'text' : 'password'}
                      value={ghToken}
                      onChange={(event) => setGhToken(event.target.value)}
                      placeholder="ghp_… or github_pat_…"
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2.5 pl-3 pr-10 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setGhShowToken((value) => !value)}
                      aria-label={ghShowToken ? 'Hide token' : 'Show token'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition-colors hover:text-zinc-200"
                    >
                      {ghShowToken ? (
                        <EyeOff className="h-4 w-4" aria-hidden />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  </div>
                  <span className="mt-1 block text-[10px] leading-snug text-zinc-500">
                    Used only for this request and never stored. Needs a classic
                    token with the &quot;repo&quot; scope — or a fine-grained
                    token with Contents + Administration read &amp; write.{' '}
                    <a
                      href="https://github.com/settings/tokens/new"
                      target="_blank"
                      rel="noreferrer"
                      className="whitespace-nowrap font-bold text-amber-400 underline underline-offset-2 transition-colors hover:text-amber-300"
                    >
                      Create / verify a token on GitHub ↗
                    </a>
                  </span>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-zinc-400">
                    Repository name
                  </span>
                  <input
                    type="text"
                    value={ghRepo}
                    onChange={(event) => setGhRepo(event.target.value)}
                    placeholder="my-ratfire-game"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
                  />
                  <span className="mt-1 block text-[10px] leading-snug text-zinc-500">
                    Created under your account on save — or updated with a new
                    commit if it already exists.
                  </span>
                </label>

                {ghStatus === 'error' && (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-semibold leading-snug text-red-300"
                  >
                    {ghError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={
                    ghStatus === 'working' || !ghToken.trim() || !ghRepo.trim()
                  }
                  className="flex w-full -skew-x-12 items-center justify-center bg-gradient-to-b from-amber-300 via-amber-400 to-orange-500 py-3 ring-1 ring-amber-200/70 transition-all duration-200 enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="flex skew-x-12 items-center gap-2 text-sm font-black uppercase tracking-[0.2em] text-zinc-950">
                    {ghStatus === 'working' ? (
                      <>
                        <LoaderCircle
                          className="h-4 w-4 animate-spin"
                          aria-hidden
                        />
                        {ghStep}
                      </>
                    ) : (
                      'Save'
                    )}
                  </span>
                </button>
              </form>
            )}
          </section>
        </div>
      )}

      {/* ===== right EDGE, vertically centred: MAXIMIZE (fullscreen) + sound
           stacked VERTICALLY (also the M key) ===== */}
      <div
        className="absolute right-3 z-0 flex -translate-y-1/2 flex-col items-center gap-2"
        style={{
          top: 'calc(50% + (env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) / 2)',
        }}
      >
        <button
          type="button"
          onClick={toggleImmersive}
          aria-label={
            isFullscreen
              ? 'Exit fullscreen (show the browser bars)'
              : 'Maximize game — hide the browser bars (fullscreen)'
          }
          aria-pressed={isFullscreen}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-black/35 text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55"
        >
          {isFullscreen ? (
            <Minimize className="h-5 w-5" aria-hidden />
          ) : (
            <Maximize className="h-5 w-5" aria-hidden />
          )}
        </button>
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? 'Unmute game sound' : 'Mute game sound'}
          aria-pressed={muted}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-black/35 text-white/85 backdrop-blur-sm transition-colors hover:bg-black/55"
        >
          {muted ? (
            <VolumeX className="h-5 w-5" aria-hidden />
          ) : (
            <Volume2 className="h-5 w-5" aria-hidden />
          )}
        </button>
      </div>

      {/* ========== mobile touch controls — ONLY on touch devices ========== */}
      {phase === 'playing' && isTouch && (
        <TouchControls apiRef={touchApiRef} />
      )}
    </main>
  );
}
