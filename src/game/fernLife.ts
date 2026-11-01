/**
 * FERN LIFE FX — reactive audio + footstep effects for the living fern field.
 *
 * A thin layer on top of bushSystem's fern upgrade (see bushSystem.ts):
 * the bushes own the wind shader + trample springs; this module adds the
 * juice around the fern field (the only bush species in the biome):
 *
 *  - FOOTSTEP LEAF PUFFS: walking through a fern kicks up a small burst
 *    of soft leaf particles at its crown (per-instance trigger, rate
 *    limited, GPU point sprites, zero allocation steady-state).
 *  - WIND BED: a procedural filtered-noise loop (no assets) whose gain
 *    and brightness follow the live gust value — calm breeze whispers,
 *    storms howl. Rain adds its own bed; this one carries the wind only.
 *  - RUSTLE ONE-SHOTS: pushing through fronds plays short filtered noise
 *    bursts, volume scaled by the player's speed.
 *
 * Audio architecture mirrors rainSystem: a private AudioContext created
 * lazily inside the first user gesture, wired through its own master
 * gain that subscribes to the global mute bus (muteState.ts), so the HUD
 * sound button silences everything in the same instant. Every audio call
 * is wrapped fail-safe — sound can never break the game loop.
 */

import * as THREE from 'three';
import { onMuteChange } from './muteState';
import type { BushSystemHandle, FernWindInfo } from './bushSystem';

/* ------------------------------ tuning ------------------------------ */

/** A fern counts as touched when the player is within this radius. */
const TOUCH_RADIUS = 140;
/** Player horizontal speed (units/s) above which brushing counts as a
 *  footstep rustle rather than standing still. */
const TOUCH_MIN_SPEED = 40;
/** Minimum seconds between leaf puff bursts (visual). */
const PUFF_INTERVAL = 0.16;
/** Minimum seconds between rustle one-shots (audio). */
const RUSTLE_INTERVAL = 0.24;

const PUFF_COUNT = 72; // particle pool (footstep leaf puffs)
const PUFF_LIFE = 0.75; // seconds
const PUFF_GRAVITY = -170; // units/s²
const PUFF_SIZE = 9; // world-ish size constant (shader attenuated)

const WIND_BED_MAX_GAIN = 0.22;
const RUSTLE_MAX_GAIN = 0.5;

/* ------------------------------ helpers ------------------------------ */

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export interface FernLifeHandle {
  /** Drive particles + audio. Call once per frame after bushes.update. */
  update(
    dt: number,
    playerX: number,
    playerY: number,
    playerZ: number,
    speedXZ: number,
    wind: FernWindInfo,
    rain: number
  ): void;
  /** Debug/verification snapshot (surfaced on window.__fernLife). */
  debug(): {
    puffs: number;
    debris: number;
    rustles: number;
    windGain: number | null;
    ctxState: string;
    muted: boolean;
  };
  dispose(): void;
}

export function createFernLife(
  scene: THREE.Scene,
  bushes: BushSystemHandle,
  lowSpec: boolean
): FernLifeHandle {
  /* ================= footstep leaf puffs (THREE.Points) ================= */

  const puffPos = new Float32Array(PUFF_COUNT * 3);
  const puffVel = new Float32Array(PUFF_COUNT * 3);
  const puffAge = new Float32Array(PUFF_COUNT).fill(-1); // -1 = dead
  const puffAlpha = new Float32Array(PUFF_COUNT);
  const puffSize = new Float32Array(PUFF_COUNT);
  const puffColor = new Float32Array(PUFF_COUNT * 3);

  const puffGeo = new THREE.BufferGeometry();
  puffGeo.setAttribute('position', new THREE.BufferAttribute(puffPos, 3));
  puffGeo.setAttribute('aAlpha', new THREE.BufferAttribute(puffAlpha, 1));
  puffGeo.setAttribute('aSize', new THREE.BufferAttribute(puffSize, 1));
  puffGeo.setAttribute('aColor', new THREE.BufferAttribute(puffColor, 3));

  const PUFF_VERT = /* glsl */ `
    attribute float aAlpha;
    attribute float aSize;
    attribute vec3 aColor;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      vAlpha = aAlpha;
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (420.0 / max(-mv.z, 1.0));
      gl_Position = projectionMatrix * mv;
    }
  `;
  const PUFF_FRAG = /* glsl */ `
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      float d = length(gl_PointCoord - vec2(0.5));
      float mask = smoothstep(0.5, 0.12, d);
      if (mask * vAlpha < 0.01) discard;
      gl_FragColor = vec4(vColor, mask * vAlpha);
    }
  `;
  const puffMat = new THREE.ShaderMaterial({
    vertexShader: PUFF_VERT,
    fragmentShader: PUFF_FRAG,
    transparent: true,
    depthWrite: false,
  });
  const puffPoints = new THREE.Points(puffGeo, puffMat);
  puffPoints.frustumCulled = false;
  puffPoints.renderOrder = 3;
  if (!lowSpec) scene.add(puffPoints);

  let puffCursor = 0;

  function spawnPuff(x: number, y: number, z: number, awayX: number, awayZ: number): void {
    const i = puffCursor;
    puffCursor = (puffCursor + 1) % PUFF_COUNT;
    puffAge[i] = 0;
    puffPos[i * 3] = x + rand(-14, 14);
    puffPos[i * 3 + 1] = y + rand(26, 52);
    puffPos[i * 3 + 2] = z + rand(-14, 14);
    puffVel[i * 3] = awayX * rand(24, 70) + rand(-22, 22);
    puffVel[i * 3 + 1] = rand(46, 105);
    puffVel[i * 3 + 2] = awayZ * rand(24, 70) + rand(-22, 22);
    puffSize[i] = rand(0.55, 1.25) * PUFF_SIZE;
    // soft leaf greens
    puffColor[i * 3] = rand(0.55, 0.72);
    puffColor[i * 3 + 1] = rand(0.78, 0.95);
    puffColor[i * 3 + 2] = rand(0.3, 0.45);
  }

  function updatePuffs(dt: number): void {
    let any = false;
    for (let i = 0; i < PUFF_COUNT; i++) {
      if (puffAge[i] < 0) continue;
      any = true;
      puffAge[i] += dt;
      const t = puffAge[i] / PUFF_LIFE;
      if (t >= 1) {
        puffAge[i] = -1;
        puffAlpha[i] = 0;
        puffPos[i * 3 + 1] = -1e5;
        continue;
      }
      puffVel[i * 3 + 1] += PUFF_GRAVITY * dt;
      puffPos[i * 3] += puffVel[i * 3] * dt;
      puffPos[i * 3 + 1] += puffVel[i * 3 + 1] * dt;
      puffPos[i * 3 + 2] += puffVel[i * 3 + 2] * dt;
      puffAlpha[i] = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
      puffAlpha[i] *= 0.85;
    }
    if (any) {
      (puffGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (puffGeo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
      (puffGeo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
      (puffGeo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /* ==================== reactive audio (procedural) ==================== */

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let windGain: GainNode | null = null;
  let windFilter: BiquadFilterNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let muted = false;
  let started = false;
  let audioInitError: string | null = null;
  const unsubMute = onMuteChange((m) => {
    muted = m;
    if (master && ctx) {
      master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.05);
    }
  });

  /** Build a 2 s white-noise buffer — shared by the wind bed + rustles. */
  function makeNoise(theCtx: AudioContext): AudioBuffer {
    const len = theCtx.sampleRate * 2;
    const buf = theCtx.createBuffer(1, len, theCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Create the AudioContext + wind bed inside the first user gesture
   *  (same autoplay-proof pattern as audio.ts). */
  function initAudio(): void {
    if (started) return;
    started = true;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      const theCtx = new Ctx();
      ctx = theCtx;
      master = theCtx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(theCtx.destination);

      noiseBuffer = makeNoise(theCtx);

      // looping filtered-noise wind bed
      const src = theCtx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      windFilter = theCtx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 420;
      windFilter.Q.value = 0.8;
      windGain = theCtx.createGain();
      windGain.gain.value = 0;
      src.connect(windFilter).connect(windGain).connect(master);
      src.start();
    } catch (err) {
      audioInitError = err instanceof Error ? err.message : String(err);
      ctx = null;
      master = null;
      windGain = null;
    }
  }

  // autoplay policy: build inside the first gesture
  const onGesture = () => initAudio();
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);

  /** One filtered-noise burst — a frond brushing past the camera subject. */
  function playRustle(speed01: number): void {
    if (!ctx || !master || !noiseBuffer || muted) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.playbackRate.value = rand(1.5, 2.3);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rand(1400, 3200);
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      const now = ctx.currentTime;
      const vol = (0.12 + 0.38 * speed01) * RUSTLE_MAX_GAIN;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(vol, now + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      src.connect(bp).connect(g).connect(master);
      src.start(now, rand(0, 1.4));
      src.stop(now + 0.3);
      src.onended = () => {
        src.disconnect();
        bp.disconnect();
        g.disconnect();
      };
    } catch {
      /* never let audio throw into the game loop */
    }
  }

  let lastWindTune = 0;
  function tuneWindBed(wind: FernWindInfo, rain: number, now: number): void {
    if (!ctx || !windGain || !windFilter) return;
    if (now - lastWindTune < 0.15) return;
    lastWindTune = now;
    try {
      const g = Math.min(
        WIND_BED_MAX_GAIN,
        (0.03 + 0.16 * wind.gust + 0.035 * rain) *
          (0.7 + 0.65 * Math.min(2.2, wind.strength))
      );
      windGain.gain.setTargetAtTime(muted ? 0 : g, ctx.currentTime, 0.35);
      const f = 320 + 760 * wind.gust + 180 * rain;
      windFilter.frequency.setTargetAtTime(f, ctx.currentTime, 0.4);
    } catch {
      /* ignore */
    }
  }

  /* ======================= per-frame orchestration ======================= */

  let lastPuffAt = -1;
  let lastRustleAt = -1;
  let clock = 0;
  let wasInside = false;
  let puffCount = 0;
  let rustleCount = 0;

  function update(
    dt: number,
    playerX: number,
    playerY: number,
    playerZ: number,
    speedXZ: number,
    wind: FernWindInfo,
    rain: number
  ): void {
    clock += dt;
    const fields = bushes.fernFields();

    // --- fern proximity (ALL life species): disturb springs + puffs + rustles ---
    let inside = false;
    let bestD2 = Infinity;
    let nearX = 0;
    let nearY = 0;
    let nearZ = 0;
    const r2 = TOUCH_RADIUS * TOUCH_RADIUS;
    for (const field of fields) {
      const fieldData = field.data;
      for (let i = 0; i < field.count; i++) {
        const fy = fieldData[i * 3 + 1];
        if (fy < -1e4) continue;
        if (Math.abs(fy - playerY) > 220) continue; // cliff mismatch
        const dx = fieldData[i * 3] - playerX;
        const dz = fieldData[i * 3 + 2] - playerZ;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2 && d2 < r2) {
          bestD2 = d2;
          inside = true;
          nearX = fieldData[i * 3];
          nearY = fy;
          nearZ = fieldData[i * 3 + 2];
        }
      }
    }

    if (inside) {
      // hold the trample springs pressed while the player stands in fronds
      bushes.disturb(playerX, playerZ, TOUCH_RADIUS, 1);
      const moving = speedXZ > TOUCH_MIN_SPEED;
      if (moving) {
        const inv = 1 / (Math.sqrt(bestD2) || 1);
        const awayX = (nearX - playerX) * inv;
        const awayZ = (nearZ - playerZ) * inv;
        // entering a fern (or brushing a new one while running): puff + rustle
        if (!wasInside && clock - lastPuffAt > PUFF_INTERVAL) {
          lastPuffAt = clock;
          const burst = lowSpec ? 2 : 3;
          for (let p = 0; p < burst; p++) spawnPuff(nearX, nearY, nearZ, awayX, awayZ);
          puffCount += burst;
        }
        if (clock - lastRustleAt > RUSTLE_INTERVAL) {
          lastRustleAt = clock;
          playRustle(Math.min(1, speedXZ / 620));
          rustleCount++;
        }
      }
    }
    wasInside = inside;

    updatePuffs(dt);
    tuneWindBed(wind, rain, clock);
  }

  function debug() {
    return {
      puffs: puffCount,
      rustles: rustleCount,
      windGain: windGain && ctx ? Number(windGain.gain.value.toFixed(3)) : null,
      ctxState: audioInitError ? `error: ${audioInitError}` : ctx ? ctx.state : 'uncreated',
      muted,
    };
  }

  function dispose(): void {
    unsubMute();
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    if (!lowSpec) {
      scene.remove(puffPoints);
    }
    puffGeo.dispose();
    puffMat.dispose();
    try {
      if (ctx) void ctx.close();
    } catch {
      /* ignore */
    }
  }

  return { update, debug, dispose };
}
