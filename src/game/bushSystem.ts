/**
 * Auto-spawning BUSH decor for the RATFIRE grasslands — the FERN only.
 *
 *  - FERN (the uploaded Sketchfab "Green Bush", scene.gltf): the one and
 *    only ground cover of the biome (pita/laurel were removed on request).
 *
 * Each species is loaded once, its meshes are baked into world space and
 * merged PER MATERIAL into a handful of geometries, and the species is
 * then drawn as a small set of InstancedMeshes (one draw call per
 * material) — every bush of a species shares identical per-instance
 * matrices across its material parts. Transparent leaf materials are
 * converted to alpha-cutout (alphaTest) so they render without blend
 * sorting artefacts and cast proper shadows.
 *
 * DENSITY (sprouts per one-BLOCK² cell):
 *  - fern   0.028 — light cover, about a quarter of the original field
 *  - SIZE VARIANTS: each sprout is big (70%), medium (20%) or small (10%)
 *
 * SPAWNING — the whole terrain, forever:
 *  - The world is cut into one-block cells (BLOCK world units). Every
 *    instance of every species owns a fixed cell residue inside a
 *    (2R+1)² window around the player's cell; cells that slide out of
 *    the trailing edge reappear at the leading edge, so walking in any
 *    direction keeps fresh bushes materialising ahead of you — the field
 *    streams forever with ZERO allocation per frame.
 *  - A given patch of land ALWAYS sprouts the same bushes (deterministic
 *    per-cell hashes pick scale, tilt and jitter) — the field is
 *    world-anchored, never random per frame.
 *  - Cells are rejected when too steep (cliff edges) or inside the spawn
 *    keep-clear disc (the lobby showcase stays unobstructed).
 *
 * REALISM DETAILS:
 *  - Per-cell scale/rotation jitter; bushes sink into their block by a
 *    fraction of their own height so the crown roots visually into the
 *    voxel ground (small and tall bushes bury proportionally).
 *  - A gentle vertex wind sway (onBeforeCompile) rocks the leaf cards —
 *    phase is offset per instance so the field ripples instead of
 *    pulsing in unison.
 *  - Materials are converted to MeshLambertMaterial so the foliage
 *    shades exactly like the terrain and character.
 *
 * FERN LIFE UPGRADE (the whole bush field is ferns):
 *  - Layered gust wind: three travelling wave trains at different
 *    wavelengths/speeds roll along a slowly drifting wind direction;
 *    the field visibly ripples in gust fronts instead of pulsing.
 *  - Weather sync: page.tsx feeds the rain intensity — storm wind blows
 *    harder and wet fronds droop (water-weight squash) while swaying less.
 *  - Player physics: fronds bend away analytically (GPU) while the player
 *    is inside their radius; walking through triggers a CPU damped-spring
 *    trample that wobbles back to rest after you pass (real harmonic
 *    oscillator per disturbed fern — underdamped, so it overshoots).
 *  - Visual polish: world-anchored per-instance tint variation, root
 *    ambient occlusion and a cheap sun-backlight translucency glow.
 *  - The handle exposes disturb() / fernFields() / windInfo() so
 *    src/game/fernLife.ts can add rustle audio, footstep leaf puffs and
 *    gust-torn debris particles on top.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface BushSystemOptions {
  /** World units per voxel block edge (100). */
  block: number;
  /** Grid origin offset (64) — matches terrainChunks' grid mapping. */
  gridOffset: number;
  /** Terrain surface height at a world position (top of the block). */
  surfaceYAt(worldX: number, worldZ: number): number;
  /** Deterministic integer block height at grid coordinates. */
  blockHeight(gx: number, gz: number): number;
  /** Mobile LOW tier: fewer bushes, no shadow casting. */
  lowSpec?: boolean;
  /** Keep-clear disc around the player spawn (lobby showcase). */
  clearX?: number;
  clearZ?: number;
  clearRadius?: number;
}

/** Per-frame weather/sun context fed by page.tsx (all optional — defaults
 *  keep the old behaviour for callers that don't pass it). */
export interface BushWeatherContext {
  /** Frame delta seconds — drives spring physics + wind evolution. */
  dt?: number;
  /** Rain intensity 0..1 — storm wind boost + wet-frond droop. */
  rain?: number;
  /** Sun direction (unit, pointing TOWARD the sun) for backlight. */
  sunX?: number;
  sunY?: number;
  sunZ?: number;
  /** Sun colour for the backlight glow tint. */
  sunColor?: { r: number; g: number; b: number };
}

/** CPU mirror of the shader's gust field — consumed by fernLife audio. */
export interface FernWindInfo {
  dirX: number;
  dirZ: number;
  /** Base wind strength 0..~1.7 (already rain-boosted). */
  strength: number;
  /** Gust field 0..1 sampled at the player position. */
  gust: number;
}

export interface BushSystemHandle {
  /** True once the common fern finished loading and its instances exist. */
  ready(): boolean;
  /** Recycle cells around the player + advance wind time. Call per frame. */
  update(playerX: number, playerZ: number, ctx?: BushWeatherContext): void;
  /** Press ferns near (x,z) — trample springs push them aside; they
   *  spring back with a damped wobble once the pressure moves away. */
  disturb(x: number, z: number, radius: number, power: number): void;
  /** Live wind state (mirrors the shader field) for audio + particles. */
  windInfo(): FernWindInfo;
  /** World positions (x, y, z per bush) of every placed fern-type
   *  instance, one buffer per life species. Unplaced/rejected instances
   *  are parked at y = -1e5. */
  fernFields(): Array<{ data: Float32Array; count: number }>;
  stats(): {
    instances: number;
    placed: number;
    cells: number;
    fernSprings: number;
    species: Array<{ label: string; instances: number; placed: number }>;
  };
  dispose(): void;
}

/* ------------------------------ tuning ------------------------------ */

interface SpeciesSpec {
  label: string;
  url: string;
  /** Sprouts per cell (cell = one BLOCK² of land). */
  density: number;
  /** Crown height in world units before per-cell jitter (character is 190). */
  height: number;
  /** True → the species gets the full FERN LIFE system (heavy gust wind,
   *  pinned-base shader, trample springs, push-apart, FX + audio). */
  life?: boolean;
  /** Per-species hash salt offset — two species on the same cell get
   *  different jitter/rotation/scale so they never stack identically. */
  seed?: number;
  /** Global texture darken multiplier baked into the shader tint
   *  (1 = untouched, 0.84 = the user's fern darkening tune). */
  darken?: number;
}

const SPECIES: SpeciesSpec[] = [
  { label: 'fern', url: '/models/green_bush/scene.gltf', density: 0.028, height: 92, life: true, seed: 0, darken: 0.84 },
];

/** SIZE VARIANTS — the field mixes THREE fern sizes, picked per cell by
 *  a deterministic hash so any patch of land always sprouts the same
 *  small/medium/big blend (user tune: big-dominant field):
 *   - SMALL  (10%): ~0.30..0.48 × species height — ankle-high tufts
 *   - MEDIUM (20%): ~0.62..0.88 × species height — knee-high plants
 *   - BIG    (70%): ~1.00..1.55 × species height — waist-high crowns,
 *     matching the previous single-size field ("like now")
 *  All variants share the same model, wind, trample springs and push
 *  physics — the shader scales its bend amplitude by instance size. */
const SIZE_SMALL_P = 0.1; // share of the field that sprouts small
const SIZE_MEDIUM_P = 0.2; // share medium (the rest is big)
const SIZE_SMALL_MIN = 0.3; // per-class scale jitter (× species height)
const SIZE_SMALL_VAR = 0.18;
const SIZE_MED_MIN = 0.62;
const SIZE_MED_VAR = 0.26;
const SIZE_BIG_MIN = 1.0;
const SIZE_BIG_VAR = 0.55;

/* ------------------- fern life tuning (fern ONLY) ------------------- */

/** Player push-apart: fronds within this radius lean away (world units). */
const FERN_PUSH_RADIUS = 150;
/** Max extra crown displacement from the player push (world units). */
const FERN_PUSH_AMP = 30;
/** Trample spring: damped harmonic oscillator per disturbed fern. */
const SPRING_K = 50; // stiffness (rad/s²) — ~1.1 Hz natural frequency
const SPRING_C = 6.0; // damping — underdamped: wobbles ~3 times before rest
const SPRING_MAX_THETA = 0.5; // rad — never fold the fern flat
const SPRING_REST_EPS = 0.002; // rad + rad/s below which the spring sleeps
/** Fronds release when the player is this much outside the push radius. */
const FERN_RELEASE_FACTOR = 1.2;

/** Wrap window half-width, in cells (4000u desktop / 2600u mobile).
 *  WIDE SPAWN AREA: bushes materialise farther out, so the field reads
 *  lighter per area while the horizon stays populated. */
const RADIUS_DESKTOP = 40;
const RADIUS_LOW = 26;

/** Max block-height range across a cell before it counts as a cliff. */
const SLOPE_MAX_BLOCKS = 2;

/** How deep each bush roots into its block: a fraction of the bush's own
 *  height (so small and tall ferns bury proportionally) with a floor so
 *  even the smallest bush hides its base in the ground. */
const SINK_FRACTION = 0.27;
const SINK_MIN = 10;

/* --------------------------- small helpers --------------------------- */

/** Deterministic 0..1 hash from two integer coords + a seed salt. */
function hash2(x: number, z: number, salt: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) | 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Positive modulo for integers. */
function wrap(v: number, m: number): number {
  return ((v % m) + m) % m;
}

export function createBushes(scene: THREE.Scene, options: BushSystemOptions): BushSystemHandle {
  const block = options.block;
  const gridOffset = options.gridOffset;
  const lowSpec = options.lowSpec ?? false;
  const clearX = options.clearX ?? 0;
  const clearZ = options.clearZ ?? 0;
  const clearR2 = (options.clearRadius ?? 0) ** 2;

  const R = lowSpec ? RADIUS_LOW : RADIUS_DESKTOP;
  const W = 2 * R + 1; // window edge, in cells

  /* --- wind-sway uniform shared with every species' shader patch --- */
  const swayUniform = { value: 0 };

  /* --- wind uniforms: live values shared by the fern's shader --- */
  const fernUniforms = {
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindStrength: { value: 0.85 },
    uPlayerPos: { value: new THREE.Vector3(0, 0, 0) },
    uPlayerR: { value: FERN_PUSH_RADIUS },
    uPushAmp: { value: FERN_PUSH_AMP },
    uRainLoad: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.2) },
    uSunColor: { value: new THREE.Color(1, 0.96, 0.86) },
  };

  /** Fern rain load follows the storm slowly (wet foliage soaks over ~2 s). */
  let fernRainLoad = 0;
  /** Evolving wind state (drifting direction + breathing strength).
   *  HEAVY WIND MODE: baseline ~0.85 with deep breathing to ~1.4 —
   *  storms (rain) multiply it up to ~3× for near-gale blasts. */
  let windAngle = -0.7;
  let windStrength = 0.85;
  const windDir = new THREE.Vector2(1, 0);
  /** Player position for the CPU-side release check (springs). */
  let playerXZ = { x: 0, z: 0 };

  /** CPU mirror of the shader's layered gust field, sampled at (x,z).
   *  Keep the constants in sync with the GLSL in applyFernMaterial! */
  function gustAt(x: number, z: number): number {
    const t = swayUniform.value;
    const dx = windDir.x;
    const dz = windDir.y;
    let g = Math.sin((x * dx + z * dz) * 0.0021 - t * 1.5);
    g += 0.55 * Math.sin((x * dx + z * dz) * 0.0047 + 1.7 - t * 2.65);
    g += 0.28 * Math.sin((x * dz - z * dx) * 0.0033 - t * 4.0);
    g /= 1.83;
    const v = 0.55 + 0.45 * g;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /** Evolve the wind: the direction slowly wanders, the strength breathes
   *  and is boosted by rain. Called once per update(). */
  function evolveWind(rain: number): void {
    const t = swayUniform.value;
    windAngle =
      -0.7 +
      0.6 * Math.sin(t * 0.017 + 1.7) +
      0.34 * Math.sin(t * 0.043 + 4.2) +
      0.15 * Math.sin(t * 0.097);
    windDir.set(Math.cos(windAngle), Math.sin(windAngle));
    // HEAVY WIND: strong baseline + deep breathing (0.25 .. ~1.4 calm,
    // rain multiplies up to ~3× — gales flatten the whole field)
    windStrength =
      (0.8 +
        0.35 * Math.sin(t * 0.043 + 2.0) +
        0.2 * Math.sin(t * 0.11 + 0.7)) *
      (1 + rain * 1.15);
    fernUniforms.uWindDir.value.set(windDir.x, windDir.y);
    fernUniforms.uWindStrength.value = windStrength;
  }

  /** FERN-ONLY material: layered gust wind in WORLD space (three travelling
   *  wave trains along a drifting wind vector), analytic player push-apart,
   *  wet-frond rain droop, per-instance world-anchored tint variation, root
   *  ambient occlusion and a cheap sun-backlight translucency glow.
   *  The wind displaces the INSTANCE-transformed vertex so lean directions
   *  stay correct regardless of each fern's random Y rotation. The bend is
   *  weighted quadratically by height so the ROOT STAYS FIXED while only
   *  the upper fronds animate. */
  function applyFernMaterial(
    material: THREE.MeshLambertMaterial,
    darken: number,
    refHeight: number
  ): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uSwayTime = swayUniform;
      for (const [name, u] of Object.entries(fernUniforms)) {
        shader.uniforms[name] = u;
      }
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          #define FERN_DARKEN ${darken.toFixed(4)}
          #define FERN_REF_H ${refHeight.toFixed(1)}
          uniform float uSwayTime;
          uniform vec2 uWindDir;
          uniform float uWindStrength;
          uniform vec3 uPlayerPos;
          uniform float uPlayerR;
          uniform float uPushAmp;
          uniform float uRainLoad;
          uniform vec3 uSunDir;
          varying float vFernAo;
          varying vec3 vFernTint;
          varying float vFernBack;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float fernH = clamp(transformed.y, 0.0, 1.0);
          // water weight: wet fronds droop (vertical squash towards the tip)
          transformed.y *= 1.0 - 0.20 * uRainLoad * fernH;`
        )
        .replace(
          '#include <project_vertex>',
          `vec4 fernPos = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            fernPos = instanceMatrix * fernPos;
          #endif
          vec3 fernW = (modelMatrix * fernPos).xyz;
          #ifdef USE_INSTANCING
            vec2 fernBase = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
            float fernScale = length(vec3(instanceMatrix[0].xyz));
            float fernHw = max(fernW.y - instanceMatrix[3][1], 0.0);
            // PINNED BASE: normalised crown height with a QUADRATIC weight.
            // The bottom of the plant stays planted (weight ≈ 0 near the
            // roots, even accounting for the buried sink) and only the
            // upper fronds animate; the tip keeps full amplitude.
            float fernNorm = clamp(fernHw / max(fernScale, 1.0), 0.0, 1.0);
            float fernWeight = fernNorm * fernNorm;
            // --- layered gust field: three wave trains rolling downwind ---
            // (constants mirror gustAt() on the CPU — keep in sync!)
            float fernG = sin(dot(fernBase, uWindDir) * 0.0021 - uSwayTime * 1.5);
            fernG += 0.55 * sin(dot(fernBase, uWindDir) * 0.0047 + 1.7 - uSwayTime * 2.65);
            fernG += 0.28 * sin(dot(fernBase, vec2(uWindDir.y, -uWindDir.x)) * 0.0033 - uSwayTime * 4.0);
            fernG /= 1.83;
            float fernGust = clamp(0.55 + 0.45 * fernG, 0.0, 1.0);
            float fernBend = uWindStrength * (0.5 + 0.9 * fernGust);
            // per-instance phase so neighbours do not pulse in unison
            float fernPhase = uSwayTime * 1.9 + fernBase.x * 0.043 + fernBase.y * 0.059;
            vec2 fernLean = uWindDir + 0.16 * vec2(sin(fernPhase), cos(fernPhase * 0.83));
            float fernAmp = (0.030 + 0.105 * fernBend) * fernScale * fernWeight;
            // --- player push-apart: fronds bend away from the camera subject ---
            vec2 fernFromP = fernBase - uPlayerPos.xz;
            float fernPd = length(fernFromP);
            float fernPush = clamp(1.0 - fernPd / uPlayerR, 0.0, 1.0);
            fernPush *= fernPush;
            // push strength scales with the fern's own size so the new
            // SMALL variants nudge aside instead of folding flat (big
            // crowns may bend a touch more, capped at ×1.2)
            fernAmp +=
              uPushAmp * fernPush * fernWeight * min(fernScale / FERN_REF_H, 1.2);
            fernAmp *= 1.0 - 0.35 * uRainLoad; // wet fronds sway less
            fernW.x += fernLean.x * fernAmp + 0.4 * sin(fernPhase * 3.7) * fernAmp * 0.15;
            fernW.z += fernLean.y * fernAmp + 0.4 * cos(fernPhase * 3.1) * fernAmp * 0.15;
            fernW.y -= min(fernAmp * fernAmp * 0.010, fernHw * 0.30); // bending dips the tip
            // --- per-instance tint (world-anchored hash, zero attributes) ---
            // per-species global darken of the leaf texture (user tune —
            // the fern uses ×0.84, other species stay at their own value)
            float fernTh1 = fract(sin(dot(fernBase, vec2(12.9898, 78.233))) * 43758.5453);
            float fernTh2 = fract(sin(dot(fernBase, vec2(39.3468, 11.1352))) * 24634.6345);
            vFernTint = mix(vec3(0.84, 1.0, 0.72), vec3(1.05, 1.0, 0.86), fernTh1) * (0.92 + 0.16 * fernTh2) * FERN_DARKEN;
            // root ambient occlusion + backlight translucency varyings
            vFernAo = mix(0.62, 1.0, smoothstep(0.0, 0.42, fernH));
            vec3 fernView = cameraPosition - fernW;
            vFernBack = pow(clamp(dot(normalize(fernView), -uSunDir), 0.0, 1.0), 3.0);
          #else
            vFernTint = vec3(1.0);
            vFernAo = 1.0;
            vFernBack = 0.0;
          #endif
          vec4 mvPosition = viewMatrix * vec4(fernW, 1.0);
          gl_Position = projectionMatrix * mvPosition;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec3 uSunColor;
          varying float vFernAo;
          varying vec3 vFernTint;
          varying float vFernBack;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          diffuseColor.rgb *= vFernTint * vFernAo;`
        )
        .replace(
          '#include <opaque_fragment>',
          `outgoingLight += uSunColor * vFernBack * diffuseColor.rgb * 0.45;
          #include <opaque_fragment>`
        );
    };
  }

  /* ------------------------ one bush species ------------------------ */

  interface Species {
    spec: SpeciesSpec;
    count: number;
    baseX: Int32Array;
    baseZ: Int32Array;
    /** One InstancedMesh per material group of the model. */
    meshes: THREE.InstancedMesh[];
    geos: THREE.BufferGeometry[];
    mats: THREE.MeshLambertMaterial[];
    loaded: boolean;
    placedCount: number;
    dirty: boolean;
    lastCx: number;
    lastCz: number;
    /* --- fern life state (every instance is a fern) --- */
    /** World position (x, y, z) per instance; rejected instances park at
     *  y = -1e5 so effects can ignore them. */
    fernPos: Float32Array | null;
    /** Placement parameters needed to rebuild matrices while springs bend. */
    fernRotY: Float32Array | null;
    fernScale: Float32Array | null;
    /** Damped-spring state: theta (lean angle), omega (angular velocity). */
    fernTheta: Float32Array | null;
    fernOmega: Float32Array | null;
    /** Current press 0..1 while the player stands inside the radius. */
    fernPress: Float32Array | null;
    /** Lean direction per fern (unit vector, xz, away from the player). */
    fernDirX: Float32Array | null;
    fernDirZ: Float32Array | null;
    /** Indices of ferns with a live spring (compact set). */
    fernActive: Int32Array | null;
    fernActiveCount: number;
  }

  function makeSpecies(spec: SpeciesSpec): Species {
    const count = Math.round(W * W * spec.density * 1.1); // +10% reject margin
    const isFern = spec.life === true;

    /* Fixed per-instance cell residues inside the window. World-anchored
     * recycling: a bush's cell never moves with the player — when the
     * window slides past it, the instance teleports to the leading edge. */
    const baseX = new Int32Array(count);
    const baseZ = new Int32Array(count);
    // Dedupe residues: two instances on one cell would overlap EXACTLY
    // (same per-cell hashes) and z-fight, so rehash until unique.
    const used = new Set<number>();
    let filled = 0;
    for (let attempt = 0; filled < count && attempt < count * 40; attempt++) {
      const bx = wrap(Math.floor(hash2(filled, 7, 101 + attempt * 7) * W * 4096), W);
      const bz = wrap(Math.floor(hash2(filled, 13, 211 + attempt * 11) * W * 4096), W);
      const key = bz * W + bx;
      if (used.has(key)) continue;
      used.add(key);
      baseX[filled] = bx;
      baseZ[filled] = bz;
      filled++;
    }

    return {
      spec,
      count,
      baseX,
      baseZ,
      meshes: [],
      geos: [],
      mats: [],
      loaded: false,
      placedCount: 0,
      dirty: true,
      lastCx: Number.NaN,
      lastCz: Number.NaN,
      fernPos: isFern ? new Float32Array(count * 3).fill(-1e5) : null,
      fernRotY: isFern ? new Float32Array(count) : null,
      fernScale: isFern ? new Float32Array(count) : null,
      fernTheta: isFern ? new Float32Array(count) : null,
      fernOmega: isFern ? new Float32Array(count) : null,
      fernPress: isFern ? new Float32Array(count) : null,
      fernDirX: isFern ? new Float32Array(count) : null,
      fernDirZ: isFern ? new Float32Array(count) : null,
      fernActive: isFern ? new Int32Array(count) : null,
      fernActiveCount: 0,
    };
  }

  /** Load the model, merge its meshes per material and build the
   *  InstancedMesh set (identical instance matrices across parts). */
  function attachSpecies(sp: Species, gltf: GLTF): void {
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    // Bake every mesh into world space, grouped by its material.
    const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
    root.traverse((obj) => {
      const meshChild = obj as THREE.Mesh;
      if (!(meshChild as THREE.Mesh).isMesh) return;
      const g = meshChild.geometry.clone();
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') {
          g.deleteAttribute(name);
        }
      }
      g.applyMatrix4(meshChild.matrixWorld);
      const mat = (meshChild as THREE.Mesh).material as THREE.Material;
      const list = groups.get(mat);
      if (list) list.push(g);
      else groups.set(mat, [g]);
    });
    if (groups.size === 0) return;

    // Normalise the WHOLE species with one transform: centre on x/z,
    // stand the base on y=0, scale to unit height — per-instance
    // matrices then set the real size.
    const bb = new THREE.Box3();
    for (const geos of groups.values()) {
      for (const g of geos) {
        g.computeBoundingBox();
        bb.union(g.boundingBox!);
      }
    }
    const cx = (bb.min.x + bb.max.x) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    const unit = 1 / Math.max(1e-6, bb.max.y - bb.min.y);
    for (const geos of groups.values()) {
      for (const g of geos) {
        g.translate(-cx, -bb.min.y, -cz);
        g.scale(unit, unit, unit);
      }
    }

    // One InstancedMesh per material group.
    for (const [stdMat, geos] of groups) {
      const std = stdMat as THREE.MeshStandardMaterial;
      const merged =
        geos.length > 1 ? BufferGeometryUtils.mergeGeometries(geos, false) : geos[0];

      // Lambert foliage: shades exactly like the voxel terrain.
      const material = new THREE.MeshLambertMaterial({
        map: std.map ?? null,
        color: std.map ? 0xffffff : std.color.clone(),
        side: THREE.DoubleSide,
      });
      // Cutout foliage: masked glTF leaves (alphaMode MASK) arrive with
      // transparent=false but a non-zero alphaTest — and BLEND leaves
      // arrive with transparent=true. BOTH must become alpha-cutout
      // cards, otherwise the masked texture's black RGB (where alpha = 0)
      // renders as solid black rectangles over the bush.
      if (std.transparent || std.alphaTest > 0) {
        material.alphaTest = std.alphaTest > 0 ? std.alphaTest : 0.5;
      }
      applyFernMaterial(material, sp.spec.darken ?? 1.0, sp.spec.height);

      const mesh = new THREE.InstancedMesh(merged, material, sp.count);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = false; // instances span the whole view; never cull
      mesh.castShadow = !lowSpec;
      mesh.receiveShadow = true;
      mesh.renderOrder = 1; // above the terrain, under transparent sky layers
      // Cutout shadows: masked cards must alpha-clip in the shadow pass
      // too, or every grass blade casts a solid rectangle on the ground.
      if (material.alphaTest > 0) {
        mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          map: material.map,
          alphaTest: material.alphaTest,
        });
      }
      // park every instance out of sight until the first placement pass
      const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < sp.count; i++) mesh.setMatrixAt(i, zeroMat);
      scene.add(mesh);
      sp.meshes.push(mesh);
      sp.geos.push(merged);
      sp.mats.push(material);
    }

    sp.loaded = true;
    sp.dirty = true; // force a placement pass on the next update
  }

  const speciesList: Species[] = SPECIES.map(makeSpecies);

  /* --------------- fern trample springs (CPU, fern ONLY) --------------- */

  /** Park an unplaced fern so effects + audio ignore it. */
  function parkFern(sp: Species, i: number): void {
    sp.fernPos![i * 3 + 1] = -1e5;
  }

  /** Record a freshly placed fern's base parameters (matrix rebuild needs
   *  them whenever its trample spring is bending it). */
  function recordFern(
    sp: Species,
    i: number,
    x: number,
    y: number,
    z: number,
    rotY: number,
    s: number
  ): void {
    sp.fernPos![i * 3] = x;
    sp.fernPos![i * 3 + 1] = y;
    sp.fernPos![i * 3 + 2] = z;
    sp.fernRotY![i] = rotY;
    sp.fernScale![i] = s;
  }

  /** Placement rewrote every matrix — put all fern springs to sleep. */
  function resetFernSprings(sp: Species): void {
    if (!sp.fernTheta) return;
    sp.fernTheta.fill(0);
    sp.fernOmega!.fill(0);
    sp.fernPress!.fill(0);
    sp.fernActiveCount = 0;
  }

  // scratch objects — zero allocation per frame
  const springT = new THREE.Matrix4();
  const springRw = new THREE.Matrix4();
  const springRy = new THREE.Matrix4();
  const springS = new THREE.Matrix4();
  const springAxis = new THREE.Vector3();

  /** Rebuild fern i's instance matrix with an extra world-space lean of
   *  `theta` radians around the axis perpendicular to its lean direction
   *  (T · Rworld · Ry · S — the lean tips the crown towards fernDir). */
  function applyFernMatrix(sp: Species, i: number, theta: number): void {
    const x = sp.fernPos![i * 3];
    const y = sp.fernPos![i * 3 + 1];
    const z = sp.fernPos![i * 3 + 2];
    springT.makeTranslation(x, y, z);
    if (theta !== 0) {
      // rotating +y around (dz, 0, -dx) tips the crown towards (dx, dz)
      springAxis.set(sp.fernDirZ![i], 0, -sp.fernDirX![i]);
      springRw.makeRotationAxis(springAxis, theta);
      springT.multiply(springRw);
    }
    springRy.makeRotationY(sp.fernRotY![i]);
    springT.multiply(springRy);
    const s = sp.fernScale![i];
    springS.makeScale(s, s, s);
    springT.multiply(springS);
    for (const m of sp.meshes) m.setMatrixAt(i, springT);
  }

  /** Press every fern-type bush within `radius` of (x,z): set its held
   *  pressure and lean-away direction. Springs integrate in
   *  stepFernSprings(). Walks ALL life species. */
  function disturb(x: number, z: number, radius: number, power: number): void {
    const r2 = radius * radius;
    for (const fern of speciesList) {
      if (!fern.loaded || !fern.fernPos) continue;
      for (let i = 0; i < fern.count; i++) {
        if (fern.fernPos[i * 3 + 1] < -1e4) continue; // parked
        const dx = fern.fernPos[i * 3] - x;
        const dz = fern.fernPos[i * 3 + 2] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2) || 1e-4;
        const press = power * (1 - d / radius);
        if (press <= fern.fernPress![i]) continue;
        fern.fernPress![i] = press;
        const inv = 1 / d;
        fern.fernDirX![i] = dx * inv;
        fern.fernDirZ![i] = dz * inv;
        if (
          fern.fernTheta![i] === 0 &&
          fern.fernOmega![i] === 0 &&
          fern.fernActiveCount < fern.count
        ) {
          fern.fernActive![fern.fernActiveCount++] = i;
        }
      }
    }
  }

  /** Integrate the trample springs: a damped harmonic oscillator per active
   *  bush (target = held press while the player is close, 0 once they leave,
   *  underdamped so the fronds wobble back with overshoot). Walks ALL life
   *  species. */
  function stepFernSprings(dt: number): void {
    for (const fern of speciesList) {
      if (!fern.loaded || !fern.fernPos || fern.fernActiveCount === 0) continue;
      const releaseR2 = FERN_PUSH_RADIUS * FERN_RELEASE_FACTOR * (FERN_PUSH_RADIUS * FERN_RELEASE_FACTOR);
      let wrote = false;
      for (let a = fern.fernActiveCount - 1; a >= 0; a--) {
        const i = fern.fernActive[a];
        // pressure release: the player moved on — the fern springs back
        const pdx = fern.fernPos[i * 3] - playerXZ.x;
        const pdz = fern.fernPos[i * 3 + 2] - playerXZ.z;
        if (pdx * pdx + pdz * pdz > releaseR2) fern.fernPress![i] = 0;
        const target = fern.fernPress![i] * SPRING_MAX_THETA * 0.9;
        const theta = fern.fernTheta![i];
        const omega = fern.fernOmega![i];
        const accel = -SPRING_K * (theta - target) - SPRING_C * omega;
        let nTheta = theta + omega * dt;
        let nOmega = omega + accel * dt;
        if (nTheta > SPRING_MAX_THETA) {
          nTheta = SPRING_MAX_THETA;
          nOmega = Math.min(nOmega, 0);
        } else if (nTheta < -SPRING_MAX_THETA) {
          nTheta = -SPRING_MAX_THETA;
          nOmega = Math.max(nOmega, 0);
        }
        fern.fernTheta![i] = nTheta;
        fern.fernOmega![i] = nOmega;
        if (
          target === 0 &&
          Math.abs(nTheta) < SPRING_REST_EPS &&
          Math.abs(nOmega) < SPRING_REST_EPS
        ) {
          // settled — restore the exact base matrix and sleep
          fern.fernTheta![i] = 0;
          fern.fernOmega![i] = 0;
          applyFernMatrix(fern, i, 0);
          wrote = true;
          // swap-remove from the active set
          fern.fernActiveCount--;
          fern.fernActive![a] = fern.fernActive[fern.fernActiveCount];
          continue;
        }
        applyFernMatrix(fern, i, nTheta);
        wrote = true;
      }
      if (wrote) {
        for (const m of fern.meshes) m.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /* ------------------- placement (world-anchored) ------------------- */

  function placeSpecies(sp: Species, pcx: number, pcz: number): void {
    if (!sp.loaded || sp.meshes.length === 0) return;
    sp.placedCount = 0;
    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);

    // pcx/pcz are GRID coordinates (world-block index + gridOffset), the
    // same space terrainChunks' blockHeight() speaks.
    const isFern = sp.fernPos !== null;
    // per-species hash seed: two species on the same cell get different
    // jitter/rotation/scale so they never stack identically
    const seed = sp.spec.seed ?? 0;
    for (let i = 0; i < sp.count; i++) {
      // wrap the fixed residue into the window around the player's cell
      const gx = pcx + wrap(sp.baseX[i] - pcx, W) - R;
      const gz = pcz + wrap(sp.baseZ[i] - pcz, W) - R;

      // world position: block centre + per-cell jitter (kept inside the
      // block so the trunk stands on its own column)
      const wx = (gx - gridOffset) * block + (hash2(gx, gz, 17 + seed) - 0.5) * block * 0.7;
      const wz = (gz - gridOffset) * block + (hash2(gx, gz, 29 + seed) - 0.5) * block * 0.7;

      // keep the lobby spawn showcase clear
      const dx = wx - clearX;
      const dz = wz - clearZ;
      if (dx * dx + dz * dz < clearR2) {
        for (const m of sp.meshes) m.setMatrixAt(i, zeroMat);
        if (isFern) parkFern(sp, i);
        continue;
      }

      // skip cliff cells: the voxel height across this block must stay
      // within a couple of steps
      const h00 = options.blockHeight(gx, gz);
      const h10 = options.blockHeight(gx + 1, gz);
      const h01 = options.blockHeight(gx, gz + 1);
      const h11 = options.blockHeight(gx + 1, gz + 1);
      const hMax = Math.max(h00, h10, h01, h11);
      const hMin = Math.min(h00, h10, h01, h11);
      if (hMax - hMin > SLOPE_MAX_BLOCKS) {
        for (const m of sp.meshes) m.setMatrixAt(i, zeroMat);
        if (isFern) parkFern(sp, i);
        continue;
      }

      // size variant: a per-cell hash picks the class (world-anchored —
      // the same spot always regrows the same size), then a second hash
      // jitters within the class range
      const sizeRoll = hash2(gx, gz, 71 + seed);
      const scaleMult =
        sizeRoll < SIZE_SMALL_P
          ? SIZE_SMALL_MIN + SIZE_SMALL_VAR * hash2(gx, gz, 43 + seed)
          : sizeRoll < SIZE_SMALL_P + SIZE_MEDIUM_P
            ? SIZE_MED_MIN + SIZE_MED_VAR * hash2(gx, gz, 43 + seed)
            : SIZE_BIG_MIN + SIZE_BIG_VAR * hash2(gx, gz, 43 + seed);
      const s = sp.spec.height * scaleMult;
      const sink = Math.max(SINK_MIN, s * SINK_FRACTION);
      const groundY = options.surfaceYAt(wx, wz) - sink;
      const rotY = hash2(gx, gz, 59 + seed) * Math.PI * 2;
      dummy.position.set(wx, groundY, wz);
      dummy.rotation.set(0, rotY, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      for (const m of sp.meshes) m.setMatrixAt(i, dummy.matrix);
      if (isFern) recordFern(sp, i, wx, groundY, wz, rotY, s);
      sp.placedCount++;
    }

    for (const m of sp.meshes) m.instanceMatrix.needsUpdate = true;
    if (isFern) resetFernSprings(sp);
  }

  function updateSpecies(sp: Species, pcx: number, pcz: number): void {
    if (!sp.dirty && pcx === sp.lastCx && pcz === sp.lastCz) return;
    sp.lastCx = pcx;
    sp.lastCz = pcz;
    sp.dirty = false;
    placeSpecies(sp, pcx, pcz);
  }

  const dummy = new THREE.Object3D();

  /* ------------------------ per-frame driver ------------------------ */

  function update(
    playerX: number,
    playerZ: number,
    ctx?: BushWeatherContext
  ): void {
    const dt = ctx?.dt ?? 0.016;
    swayUniform.value += dt; // wind clock
    playerXZ.x = playerX;
    playerXZ.z = playerZ;
    fernUniforms.uPlayerPos.value.set(playerX, 0, playerZ);

    // rain: the wet-frond load soaks/dries slowly, wind gets a storm boost
    const rain = ctx?.rain ?? 0;
    fernRainLoad += (rain - fernRainLoad) * Math.min(1, dt * 0.6);
    fernUniforms.uRainLoad.value = fernRainLoad;

    // sun direction + colour drive the backlight translucency
    if (ctx?.sunX !== undefined) {
      fernUniforms.uSunDir.value.set(ctx.sunX, ctx.sunY ?? 0.5, ctx.sunZ ?? 0);
      if (ctx.sunColor) {
        fernUniforms.uSunColor.value.setRGB(
          ctx.sunColor.r,
          ctx.sunColor.g,
          ctx.sunColor.b
        );
      }
    }
    evolveWind(rain);

    // grid coordinates — same space as terrainChunks.blockHeight()
    const pcx = Math.round(playerX / block) + gridOffset;
    const pcz = Math.round(playerZ / block) + gridOffset;
    for (const sp of speciesList) updateSpecies(sp, pcx, pcz);

    stepFernSprings(dt);
  }

  function windInfo(): FernWindInfo {
    return {
      dirX: windDir.x,
      dirZ: windDir.y,
      strength: windStrength,
      gust: gustAt(playerXZ.x, playerXZ.z),
    };
  }

  function fernFields(): Array<{ data: Float32Array; count: number }> {
    const fields: Array<{ data: Float32Array; count: number }> = [];
    for (const sp of speciesList) {
      if (sp.fernPos) fields.push({ data: sp.fernPos, count: sp.count });
    }
    return fields;
  }

  function stats(): {
    instances: number;
    placed: number;
    cells: number;
    fernSprings: number;
    species: Array<{ label: string; instances: number; placed: number }>;
  } {
    let instances = 0;
    let placed = 0;
    const perSpecies = speciesList.map((sp) => {
      instances += sp.count;
      placed += sp.placedCount;
      return { label: sp.spec.label, instances: sp.count, placed: sp.placedCount };
    });
    return {
      instances,
      placed,
      cells: W * W,
      fernSprings: speciesList.reduce((n, sp) => n + sp.fernActiveCount, 0),
      species: perSpecies,
    };
  }

  function dispose(): void {
    for (const sp of speciesList) {
      for (const m of sp.meshes) {
        scene.remove(m);
        m.dispose();
      }
      for (const g of sp.geos) g.dispose();
      for (const mat of sp.mats) mat.dispose();
      sp.meshes = [];
      sp.geos = [];
      sp.mats = [];
      sp.loaded = false;
    }
  }

  /* ----------------------------- loading ----------------------------- */

  for (let i = 0; i < speciesList.length; i++) {
    const sp = speciesList[i];
    new GLTFLoader().load(
      sp.spec.url,
      (gltf) => attachSpecies(sp, gltf),
      undefined,
      (err: unknown) => {
        // load error: this species just doesn't appear; the game keeps
        // running — but log the REAL reason so broken assets are findable
        const e = err as { message?: string; response?: { status?: number; url?: string } };
        console.warn(
          '[bushes] failed to load',
          sp.spec.url,
          e?.message ?? err,
          e?.response?.status,
          e?.response?.url
        );
      }
    );
  }

  return {
    ready: () => speciesList[0].loaded,
    update,
    disturb,
    windInfo,
    fernFields,
    stats,
    dispose,
  };
}

/** Minimal structural type of the glTF result (avoids importing the
 *  whole GLTF type surface for one field). */
interface GLTF {
  scene: THREE.Group;
}
