/**
 * PINE TREES for the RATFIRE grasslands — the uploaded PS1 low-poly
 * pine (pine_tree_ps1.glb, one mesh, one 128×128 pixel-art texture)
 * streamed over the endless terrain with the SAME world-anchored
 * recycling scheme as the other decor layers:
 *
 *  - The world is cut into one-block cells inside a (2R+1)² window
 *    around the player's cell; walking any direction keeps fresh pines
 *    materialising ahead while the same patch of land always regrows
 *    the SAME trees (deterministic per-cell hashes pick size, tilt,
 *    rotation and jitter — zero allocation per frame).
 *  - Pines grow in GROVES: a low-frequency hash carves the land into
 *    irregular forest patches (dense stands) with open meadows between
 *    them and the occasional lone straggler outside. Cells are also
 *    rejected when too steep (cliff edges) or inside the spawn
 *    keep-clear disc.
 *  - CANOPY CLEARANCE: a tree only wins its spot if no NEIGHBOURING
 *    candidate whose canopy would touch or merge with its own managed
 *    to win its own (deterministic dart-throwing, shared with the
 *    dead pines — see pineSpacing.ts). Two pine meshes can therefore
 *    never intersect; every survivor keeps a ring of open air around
 *    its foliage.
 *
 * RENDERING — ONE InstancedMesh (one draw call). The model keeps its
 * own UVs and embedded PS1 texture (NearestFilter for the authentic
 * crunchy look); the material is alpha-tested (the pack's MASK mode)
 * so the needle sprays cut out cleanly, and a matching custom depth
 * material keeps the tree SHADOWS cut out too instead of solid cones.
 * A subtle per-instance brightness tint (instanceColor) breaks the
 * clone look without touching the texture.
 *
 * SOLID COLLISION — pines block the player like every other tree: the
 * handle exposes pushOut(x, z, radius). The collider is a circle per
 * tree baked from the trunk's ground-level silhouette (capped so a
 * low foliage skirt can never inflate it), scaled per instance — a
 * natural wall-slide, cheap and tunnel-free at player speeds.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { livePlaceAt, type SpacingCfg } from './pineSpacing';

export interface PineSystemOptions {
  /** World units per voxel block edge (100). */
  block: number;
  /** Grid origin offset (64) — matches terrainChunks' grid mapping. */
  gridOffset: number;
  /** Terrain surface height at a world position (top of the block). */
  surfaceYAt(worldX: number, worldZ: number): number;
  /** Deterministic integer block height at grid coordinates. */
  blockHeight(gx: number, gz: number): number;
  /** Mobile LOW tier: fewer trees, no shadow casting. */
  lowSpec?: boolean;
  /** Keep-clear disc around the player spawn (lobby showcase). */
  clearX?: number;
  clearZ?: number;
  clearRadius?: number;
}

export interface PineSystemHandle {
  /** True once the model finished loading and instances exist. */
  ready(): boolean;
  /** Recycle cells around the player. Call per frame (cheap no-op when
   *  the player hasn't crossed a block boundary). */
  update(playerX: number, playerZ: number): void;
  /** Slide a collider of `radius` out of every pine it overlaps.
   *  Returns the corrected position (same object every call). */
  pushOut(x: number, z: number, radius: number): { x: number; z: number };
  stats(): { instances: number; placed: number };
  dispose(): void;
}

/* ------------------------------ tuning ------------------------------ */

/** The uploaded Sketchfab PS1 pack — one complete low-poly pine. */
const PINE_URL = '/models/pine_tree_ps1.glb';

/** Instance capacity of the ONE draw call. The canopy-clearance rule
 *  caps the stand at the physical packing limit of these wide canopies
 *  (well under a tenth of the window's cells), so the cap sits above
 *  the true saturation point with headroom. */
const CAPACITY_FRACTION = 0.065;
const CAPACITY_EXTRA = 32;

/** Wrap window half-width, in cells. Pines are tall landmarks; the
 *  wide window streams them in from far away so the forest reads as
 *  endless — the fog wall hides the pop-in boundary well before this. */
const RADIUS_DESKTOP = 44;
const RADIUS_LOW = 28;

/** Grove carving, per-cell jitter, cliff rejection and the height
 *  range (445..630 — the character is 190 tall, so pines tower
 *  ~2.3×..3.3× over him) live in pineSpacing.ts, shared 1:1 with the
 *  dead pines so both systems always agree on candidacy + spacing. */

/** How deep each pine roots into its block: a fraction of its height
 *  with a floor so even saplings hug the terrain. */
const SINK_FRACTION = 0.035;
const SINK_MIN = 4;

/** Pines stay near-upright (radians) — much less lean than dead wood. */
const TILT_MAX = 0.045;

/** Fraction of the unit height whose vertices define the collision
 *  radius (the root-flare band), hard-capped so a low needle skirt
 *  can never turn the collider into a wide invisible cylinder. */
const BASE_BAND = 0.08;
const UNIT_RADIUS_CAP = 0.05;

/** Fallback tint if the embedded texture fails to load. */
const FALLBACK_COLOR = 0x4a6b35;

/* -------------------------------- wind -------------------------------- */

/** GPU FOLIAGE WIND — the canopy sways while the ROOT STAYS PLANTED.
 *  Injected into the Lambert vertex shader (and the matching depth
 *  material, so even the shadows sway): each vertex bends sideways by
 *  an amount that is EXACTLY ZERO below WIND_LOCK_LOW of the tree's
 *  height (the trunk base / root flare is pinned in place), ramps in
 *  through WIND_LOCK_HIGH and then grows with height^1.4 towards the
 *  tip — a cantilever profile, like a real pine trunk flexing.
 *  Per-instance phase comes from the instance's world translation, so
 *  no two trees ever sway in lockstep, and a slow layered gust
 *  envelope (GPU-side, no CPU cost) breathes calm and breeze through
 *  the grove. One draw call, zero allocations, zero per-vertex CPU. */
const WIND_AMPLITUDE = 0.0105; // unit-space tip deflection at full gust
const WIND_LOCK_LOW = 0.05; // height fraction below which vertices are pinned
const WIND_LOCK_HIGH = 0.16; // height fraction where sway reaches full weight

/** Shared wind uniforms — ONE clock drives the foliage material and
 *  its shadow depth material so both always agree. */
const windTime = { value: 0 };
const windAmp = { value: WIND_AMPLITUDE };

/** Vertex-shader chunk replacing `#include <begin_vertex>`: defines
 *  `transformed` with the wind offset added in the model's UNIT-HEIGHT
 *  local space (position.y is 0 at the base, 1 at the tip), so the
 *  per-instance matrix scales the sway with the tree's real size. */
const WIND_VERTEX_GLSL = `
vec3 transformed = vec3( position );
#ifdef USE_INSTANCING
{
        float wY      = max( position.y, 0.0 );
        float foliage = smoothstep( ${WIND_LOCK_LOW}, ${WIND_LOCK_HIGH}, wY );
        float bend    = foliage * pow( wY, 1.4 );
        float phase   = instanceMatrix[ 3 ].x * 0.0125 + instanceMatrix[ 3 ].z * 0.0108;
        float t       = uWindTime;
        float gust    = max( 0.62 + 0.38 * sin( t * 0.31 + phase * 0.35 ) * sin( t * 0.173 + 1.7 ), 0.0 );
        float ax      = sin( t * 1.06 + phase ) + 0.46 * sin( t * 2.17 + phase * 1.61 );
        float az      = cos( t * 0.89 + phase * 1.23 ) + 0.46 * cos( t * 1.93 + phase * 0.87 );
        vec2 windOff  = vec2( ax, az ) * ( uWindAmp * gust * bend );
        transformed.x += windOff.x;
        transformed.z += windOff.y;
}
#endif`;

/** Injects the wind uniforms + vertex chunk into any material whose
 *  vertex shader follows the standard three.js include pipeline. */
function applyWindPatch(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uWindTime = windTime;
  shader.uniforms.uWindAmp = windAmp;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform float uWindTime;\nuniform float uWindAmp;'
    )
    .replace('#include <begin_vertex>', WIND_VERTEX_GLSL);
}

/* --------------------------- small helpers --------------------------- */

/** Deterministic 0..1 hash from two integer coords + a seed salt. */
function hash2(x: number, z: number, salt: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) | 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Max ground-level radius of a NORMALISED pine geometry: the trunk's
 *  root-flare silhouette becomes the per-instance collision disc
 *  (scaled by the instance height at placement time), capped so a
 *  ground-hugging foliage skirt can't inflate it. */
function bakeUnitRadius(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position');
  let r = 0.012;
  if (!pos) return Math.min(r, UNIT_RADIUS_CAP);
  for (let vi = 0; vi < pos.count; vi++) {
    if (pos.getY(vi) > BASE_BAND) continue;
    const vx = pos.getX(vi);
    const vz = pos.getZ(vi);
    const d = Math.sqrt(vx * vx + vz * vz);
    if (d > r) r = d;
  }
  return Math.min(r, UNIT_RADIUS_CAP);
}

export function createPines(
  scene: THREE.Scene,
  options: PineSystemOptions
): PineSystemHandle {
  const block = options.block;
  const gridOffset = options.gridOffset;
  const lowSpec = options.lowSpec ?? false;
  const clearX = options.clearX ?? 0;
  const clearZ = options.clearZ ?? 0;

  const R = lowSpec ? RADIUS_LOW : RADIUS_DESKTOP;
  const W = 2 * R + 1; // window edge, in cells
  const count = Math.round(W * W * CAPACITY_FRACTION) + CAPACITY_EXTRA;

  /* Placement no longer pre-assigns instances to cells: every pass
   * enumerates the window's cells, asks pineSpacing which ones win a
   * tree under the canopy-clearance rule, and fills the instance
   * buffers from index 0 — the tail parks at zero scale. */

  /** Shared candidacy + spacing configuration (mirrors the dead). */
  const spacingCfg: SpacingCfg = {
    block,
    gridOffset,
    blockHeight: options.blockHeight,
    clearX,
    clearZ,
    clearRadius: options.clearRadius ?? 0,
  };

  /* --- per-instance placement state (read back by pushOut) --- */
  /** World position of each pine's base; unplaced park at y = -1e5. */
  const treeX = new Float32Array(count);
  const treeY = new Float32Array(count).fill(-1e5);
  const treeZ = new Float32Array(count);
  /** Collision radius per placed pine (unit radius × height). */
  const treeR = new Float32Array(count);
  const placed = new Uint8Array(count);
  let placedCount = 0;

  let loaded = false;
  /** ONE InstancedMesh for the whole forest (capacity `count`;
   *  unplaced instances park at a zero-scale matrix). */
  let mesh: THREE.InstancedMesh | null = null;
  let depthMat: THREE.MeshDepthMaterial | null = null;
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.MeshLambertMaterial[] = [];
  const textures: THREE.Texture[] = [];
  /** Unit-space collision radius (baked at load). */
  let unitRadius = 0.02;

  const dummy = new THREE.Object3D();
  const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
  const tint = new THREE.Color();
  const slideOut = { x: 0, z: 0 }; // shared pushOut result — zero alloc

  /** Bake the loaded pine into world space, normalise it (centre x/z,
   *  base on y=0, unit height) and build the single InstancedMesh. */
  function attach(
    gltf: { scene: THREE.Group },
    map: THREE.Texture | null
  ): void {
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    // The pack holds ONE complete tree mesh — bake its full world
    // transform (Sketchfab Z-up→Y-up root + FBX scale), then
    // normalise on its own bounds so per-instance matrices set the
    // real size. The model's own UVs are kept: they drive its 128×128
    // PS1 texture, which IS the look.
    let geo: THREE.BufferGeometry | null = null;
    root.traverse((obj) => {
      const meshChild = obj as THREE.Mesh;
      if (geo || !(meshChild as THREE.Mesh).isMesh) return;
      const g = meshChild.geometry.clone();
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') {
          g.deleteAttribute(name);
        }
      }
      g.applyMatrix4(meshChild.matrixWorld);
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      const height = Math.max(1e-6, bb.max.y - bb.min.y);
      const cx = (bb.min.x + bb.max.x) / 2;
      const cz = (bb.min.z + bb.max.z) / 2;
      g.translate(-cx, -bb.min.y, -cz);
      g.scale(1 / height, 1 / height, 1 / height);
      geo = g;
    });
    if (!geo) return;

    // Collision radius from the trunk's root flare (capped).
    unitRadius = bakeUnitRadius(geo);

    // One Lambert material for the forest, shaded exactly like the
    // voxel terrain; alphaTest keeps the MASK-mode needle sprays cut
    // out, DoubleSide because PS1 foliage is open shells.
    const material = new THREE.MeshLambertMaterial({
      map,
      color: map ? 0xffffff : FALLBACK_COLOR,
      side: THREE.DoubleSide,
      alphaTest: map ? 0.45 : 0,
    });

    // foliage wind: sway the canopy, keep the root planted
    material.onBeforeCompile = applyWindPatch;
    material.customProgramCacheKey = () => 'ratfire-pine-wind';

    const im = new THREE.InstancedMesh(geo, material, count);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    im.frustumCulled = false; // instances span the whole view
    im.castShadow = !lowSpec;
    im.receiveShadow = true;
    im.renderOrder = 1; // above the terrain, under transparent sky
    // park every instance out of sight until the first placement pass
    for (let i = 0; i < count; i++) im.setMatrixAt(i, zeroMat);
    scene.add(im);

    // Cut-out shadows: the depth material honours the same alpha test,
    // so tree shadows follow the needle silhouette, not solid cones.
    // The SAME wind patch runs here — shadows sway with the foliage.
    if (map && !lowSpec) {
      depthMat = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map,
        alphaTest: 0.45,
      });
      depthMat.onBeforeCompile = applyWindPatch;
      depthMat.customProgramCacheKey = () => 'ratfire-pine-wind-depth';
      im.customDepthMaterial = depthMat;
    }

    mesh = im;
    geos.push(geo);
    mats.push(material);
    if (map) textures.push(map);

    loaded = true;
    lastCx = Number.NaN; // force a placement pass on the next update
    lastCz = Number.NaN;
  }

  /* ------------------- placement (world-anchored) ------------------- */

  function placeAll(pcx: number, pcz: number): void {
    if (!loaded || !mesh) return;
    placedCount = 0;

    outer: for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const gx = pcx + dx;
        const gz = pcz + dz;

        // candidacy + canopy-clearance dart throw (shared with the dead)
        const spot = livePlaceAt(gx, gz, spacingCfg);
        if (!spot) continue;
        if (placedCount >= count) break outer;

        const wx = spot.wx;
        const wz = spot.wz;
        const h = spot.h;
        const sink = Math.max(SINK_MIN, h * SINK_FRACTION);
        const groundY = options.surfaceYAt(wx, wz) - sink;
        const rotY = hash2(gx, gz, 2311) * Math.PI * 2;

        // pines lean only a whisper (±TILT_MAX rad) on a random azimuth
        const tiltAmp = (hash2(gx, gz, 2333) - 0.5) * 2 * TILT_MAX;
        const tiltDir = hash2(gx, gz, 2371) * Math.PI * 2;

        dummy.position.set(wx, groundY, wz);
        dummy.rotation.set(
          Math.sin(tiltDir) * tiltAmp,
          rotY,
          Math.cos(tiltDir) * tiltAmp
        );
        dummy.scale.set(h, h, h);
        dummy.updateMatrix();
        mesh.setMatrixAt(placedCount, dummy.matrix);

        // subtle brightness tint per tree — breaks the clone look while
        // leaving the PS1 texture's own colours untouched
        const l = 0.86 + 0.22 * hash2(gx, gz, 2389);
        tint.setRGB(l, l, l * (0.98 + 0.04 * hash2(gx, gz, 2411)));
        mesh.setColorAt(placedCount, tint);

        treeX[placedCount] = wx;
        treeY[placedCount] = groundY;
        treeZ[placedCount] = wz;
        treeR[placedCount] = unitRadius * h;
        placed[placedCount] = 1;
        placedCount++;
      }
    }

    // park every instance beyond the live set (out of sight + collision)
    for (let i = placedCount; i < count; i++) park(i);

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Park an instance out of sight + out of collision. */
  function park(i: number): void {
    if (mesh) mesh.setMatrixAt(i, zeroMat);
    treeY[i] = -1e5;
    placed[i] = 0;
  }

  let lastCx = Number.NaN;
  let lastCz = Number.NaN;

  /* ------------------------ per-frame driver ------------------------ */

  function update(playerX: number, playerZ: number): void {
    // advance the GPU wind clock (the foliage + its shadows share it)
    windTime.value = performance.now() / 1000;

    // grid coordinates — same space as terrainChunks.blockHeight()
    const pcx = Math.round(playerX / block) + gridOffset;
    const pcz = Math.round(playerZ / block) + gridOffset;
    if (pcx === lastCx && pcz === lastCz) return;
    lastCx = pcx;
    lastCz = pcz;
    placeAll(pcx, pcz);
  }

  function pushOut(x: number, z: number, radius: number): { x: number; z: number } {
    if (!loaded) {
      slideOut.x = x;
      slideOut.z = z;
      return slideOut;
    }
    for (let i = 0; i < count; i++) {
      if (!placed[i]) continue;
      const dx = x - treeX[i];
      const dz = z - treeZ[i];
      const minD = radius + treeR[i];
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;
      const d = Math.sqrt(d2);
      if (d > 1e-6) {
        // slide the mover out along the radial — a natural wall-slide
        // around the trunk's baked base silhouette
        const push = minD - d;
        x += (dx / d) * push;
        z += (dz / d) * push;
      } else {
        // dead centre: eject along +X (arbitrary but stable)
        x = treeX[i] + minD;
      }
    }
    slideOut.x = x;
    slideOut.z = z;
    return slideOut;
  }

  function stats(): { instances: number; placed: number } {
    return { instances: count, placed: placedCount };
  }

  function dispose(): void {
    if (mesh) {
      scene.remove(mesh);
      mesh.dispose();
      mesh = null;
    }
    if (depthMat) {
      depthMat.dispose();
      depthMat = null;
    }
    for (const g of geos) g.dispose();
    for (const mat of mats) mat.dispose();
    for (const t of textures) t.dispose();
    geos.length = 0;
    mats.length = 0;
    textures.length = 0;
    loaded = false;
  }

  /* ----------------------------- loading ----------------------------- */

  new GLTFLoader().load(
    PINE_URL,
    (gltf) => {
      // pull the embedded PS1 texture off the GLB's own material and
      // tune it for the pixel-art look (crisp magnification, mip-mapped
      // minification so distant canopies don't shimmer)
      let map: THREE.Texture | null = null;
      gltf.scene.traverse((obj) => {
        if (map) return;
        const m = (obj as THREE.Mesh).material as
          | THREE.MeshStandardMaterial
          | THREE.MeshStandardMaterial[]
          | undefined;
        const first = Array.isArray(m) ? m[0] : m;
        if (first && first.map) {
          map = first.map;
          map.colorSpace = THREE.SRGBColorSpace;
          map.magFilter = THREE.NearestFilter; // authentic PS1 crunch
          map.minFilter = THREE.NearestMipmapLinearFilter;
          map.anisotropy = 4;
          map.needsUpdate = true;
        }
      });
      attach(gltf, map);
    },
    undefined,
    (err: unknown) => {
      // load error: the pines just don't appear; the game keeps
      // running — but log the REAL reason so broken assets are findable
      const e = err as { message?: string; response?: { status?: number; url?: string } };
      console.warn(
        '[pineTrees] failed to load',
        PINE_URL,
        e?.message ?? err,
        e?.response?.status,
        e?.response?.url
      );
    }
  );

  return {
    ready: () => loaded,
    update,
    pushOut,
    stats,
    dispose,
  };
}
