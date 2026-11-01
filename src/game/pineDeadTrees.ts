/**
 * DEAD PINES for the RATFIRE grasslands — a rare, weathered variant of
 * the PS1 pine (same pine_tree_ps1.glb silhouette, but stripped of its
 * green atlas and wearing the SAME pixel bark texture as every other
 * piece of dead wood in the game — public/models/trunk_bark.png with
 * box-projected UVs). Streamed over the
 * endless terrain with the SAME world-anchored recycling scheme as the
 * other decor layers, but at a much LOWER density than the live pines:
 * lone skeletons out in the open (they yield to every living canopy),
 * not a forest.
 *
 *  - The world is cut into one-block cells inside a (2R+1)² window
 *    around the player's cell; walking any direction keeps fresh dead
 *    pines materialising ahead while the same patch of land always
 *    regrows the SAME trees (deterministic per-cell hashes pick size,
 *    tilt, rotation and jitter — zero allocation per frame).
 *  - Cells are rejected when too steep (cliff edges) or inside the
 *    spawn keep-clear disc (the lobby showcase stays unobstructed).
 *  - CANOPY CLEARANCE: skeletons yield to every LIVING pine whose
 *    canopy they would touch, and resolve among themselves with the
 *    same deterministic dart-throwing as the living forest (shared
 *    code in pineSpacing.ts) — no two pine meshes, living or dead,
 *    can ever touch or merge.
 *
 * RENDERING — ONE InstancedMesh (one draw call), Lambert-shaded exactly
 * like the voxel terrain, with a subtle per-instance brightness tint
 * (instanceColor) so no two skeletons weather alike.
 *
 * SOLID COLLISION — dead pines block the player like every other tree:
 * the handle exposes pushOut(x, z, radius). The collider is a circle
 * per tree baked from the trunk's ground-level silhouette (capped so a
 * low branch skirt can't inflate it), scaled per instance.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { deadPlaceAt, type SpacingCfg } from './pineSpacing';

export interface PineDeadSystemOptions {
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

export interface PineDeadSystemHandle {
  /** True once the model finished loading and instances exist. */
  ready(): boolean;
  /** Recycle cells around the player. Call per frame (cheap no-op when
   *  the player hasn't crossed a block boundary). */
  update(playerX: number, playerZ: number): void;
  /** Slide a collider of `radius` out of every dead pine it overlaps.
   *  Returns the corrected position (same object every call). */
  pushOut(x: number, z: number, radius: number): { x: number; z: number };
  stats(): { instances: number; placed: number };
  dispose(): void;
}

/* ------------------------------ tuning ------------------------------ */

/** Same pine silhouette as the live groves — but weathered bare. */
const PINE_URL = '/models/pine_tree_ps1.glb';

/** The shared pixel bark of every dead wood in the game (stumps, dead
 *  trees) — keeps the skeleton coherent with the existing scenery. */
const DEAD_BARK_URL = '/models/trunk_bark.png';

/** DEAD candidacy roll per one-BLOCK² cell (cell = 100 world units) —
 *  30× the old scatter: skeletons now compete for every meadow and for
 *  every grove gap the living canopies leave open (the clearance +
 *  yield rules still thin them down to what physically fits). */
const DENSITY = 0.195;
const DENSITY_LOW = 0.135;

/** Instance capacity headroom over the hard candidacy ceiling. */
const CAPACITY_FRACTION = 0.012;
const CAPACITY_EXTRA = 16;

/** Wrap window half-width, in cells (matches the live pines' wide
 *  stream window so dead and living share the same horizon). */
const RADIUS_DESKTOP = 44;
const RADIUS_LOW = 28;

/** Jitter, cliff rejection and the height range (matched 1:1 with the
 *  live pines) live in pineSpacing.ts, shared with the living system
 *  so both always agree on candidacy + spacing. */

/** How deep each pine roots into its block: a fraction of its height
 *  with a floor so even saplings hug the terrain. */
const SINK_FRACTION = 0.045;
const SINK_MIN = 5;

/** Dead wood leans harder than living pines (radians). */
const TILT_MAX = 0.09;

/** Fraction of the unit height whose vertices define the collision
 *  radius (the root-flare band), hard-capped so a low branch skirt
 *  can never turn the collider into a wide invisible cylinder. */
const BASE_BAND = 0.08;
const UNIT_RADIUS_CAP = 0.05;

/** One full bark-texture repeat per this many units of the tree's
 *  normalised space — picks the texel size on trunk AND branches. */
const UV_UNITS_PER_REPEAT = 0.75;

/** Fallback weathered-wood tint if the bark texture fails to load. */
const FALLBACK_COLOR = 0x8f7a5e;

/* --------------------------- small helpers --------------------------- */

/** Deterministic 0..1 hash from two integer coords + a seed salt. */
function hash2(x: number, z: number, salt: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) | 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Box-projection UVs for the baked (normalised) pine geometry: every
 *  vertex projects along its DOMINANT normal axis —
 *    |ny| wins → planar from above (u = x, v = z)
 *    |nx| wins → side wall      (u = z, v = y)
 *    else      → side wall      (u = x, v = y)
 *  scaled so one texture repeat spans UV_UNITS_PER_REPEAT units. The
 *  pixel bark then wraps trunk, snags and bare branches at an even
 *  texel density (the GLB's green needle atlas is replaced wholesale). */
function addBoxUVs(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  if (!pos || !nor) return;
  const uv = new Float32Array(pos.count * 2);
  const k = 1 / UV_UNITS_PER_REPEAT;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (ny >= nx && ny >= nz) {
      uv[i * 2] = x * k;
      uv[i * 2 + 1] = z * k;
    } else if (nx >= nz) {
      uv[i * 2] = z * k;
      uv[i * 2 + 1] = y * k;
    } else {
      uv[i * 2] = x * k;
      uv[i * 2 + 1] = y * k;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Max ground-level radius of a NORMALISED pine geometry: the trunk's
 *  root-flare silhouette becomes the per-instance collision disc
 *  (scaled by the instance height at placement time), capped so a
 *  ground-hugging branch skirt can't inflate it. */
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

export function createPineDead(
  scene: THREE.Scene,
  options: PineDeadSystemOptions
): PineDeadSystemHandle {
  const block = options.block;
  const gridOffset = options.gridOffset;
  const lowSpec = options.lowSpec ?? false;
  const clearX = options.clearX ?? 0;
  const clearZ = options.clearZ ?? 0;

  const R = lowSpec ? RADIUS_LOW : RADIUS_DESKTOP;
  const W = 2 * R + 1; // window edge, in cells
  const count = Math.max(8, Math.round(W * W * CAPACITY_FRACTION) + CAPACITY_EXTRA);

  /* Like the living pines, instances are filled from index 0 each pass
   * out of whichever window cells win the canopy-clearance rule. */

  /** Shared candidacy + spacing configuration (mirrors the living). */
  const spacingCfg: SpacingCfg = {
    block,
    gridOffset,
    blockHeight: options.blockHeight,
    clearX,
    clearZ,
    clearRadius: options.clearRadius ?? 0,
    deadDensity: lowSpec ? DENSITY_LOW : DENSITY,
  };

  /* --- per-instance placement state (read back by pushOut) --- */
  /** World position of each dead pine's base; unplaced park at y=-1e5. */
  const treeX = new Float32Array(count);
  const treeY = new Float32Array(count).fill(-1e5);
  const treeZ = new Float32Array(count);
  /** Collision radius per placed pine (unit radius × height). */
  const treeR = new Float32Array(count);
  const placed = new Uint8Array(count);
  let placedCount = 0;

  let loaded = false;
  /** ONE InstancedMesh for the whole skeleton field (capacity `count`;
   *  unplaced instances park at a zero-scale matrix). */
  let mesh: THREE.InstancedMesh | null = null;
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
   *  base on y=0, unit height), strip the green atlas for box-projected
   *  pixel bark and build the single InstancedMesh. */
  function attach(
    gltf: { scene: THREE.Group },
    barkTex: THREE.Texture | null
  ): void {
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    // The pack holds ONE complete tree mesh — bake its full world
    // transform (Sketchfab Z-up→Y-up root + FBX scale), then
    // normalise on its own bounds so per-instance matrices set the
    // real size.
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

      // Weathered pixel bark over the whole skeleton (replaces the
      // GLB's green needle atlas — this pine died standing).
      addBoxUVs(g);

      // Collision radius from the trunk's root flare (capped).
      unitRadius = bakeUnitRadius(g);
      geo = g;
    });
    if (!geo) return;

    // One Lambert material for the skeleton field, shaded exactly like
    // the voxel terrain; DoubleSide because dead wood has open shells.
    const material = new THREE.MeshLambertMaterial({
      map: barkTex,
      color: barkTex ? 0xffffff : FALLBACK_COLOR,
      side: THREE.DoubleSide,
    });

    const im = new THREE.InstancedMesh(geo, material, count);
    im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    im.frustumCulled = false; // instances span the whole view
    im.castShadow = !lowSpec;
    im.receiveShadow = true;
    im.renderOrder = 1; // above the terrain, under transparent sky
    // park every instance out of sight until the first placement pass
    for (let i = 0; i < count; i++) im.setMatrixAt(i, zeroMat);
    scene.add(im);

    mesh = im;
    geos.push(geo);
    mats.push(material);
    if (barkTex) textures.push(barkTex);

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

        // candidacy + clearance/yield rules (shared with the living)
        const spot = deadPlaceAt(gx, gz, spacingCfg);
        if (!spot) continue;
        if (placedCount >= count) break outer;

        const wx = spot.wx;
        const wz = spot.wz;
        const h = spot.h;
        const sink = Math.max(SINK_MIN, h * SINK_FRACTION);
        const groundY = options.surfaceYAt(wx, wz) - sink;
        const rotY = hash2(gx, gz, 3331) * Math.PI * 2;

        // dead pines lean on a random azimuth (±TILT_MAX rad)
        const tiltAmp = (hash2(gx, gz, 3371) - 0.5) * 2 * TILT_MAX;
        const tiltDir = hash2(gx, gz, 3389) * Math.PI * 2;

        dummy.position.set(wx, groundY, wz);
        dummy.rotation.set(
          Math.sin(tiltDir) * tiltAmp,
          rotY,
          Math.cos(tiltDir) * tiltAmp
        );
        dummy.scale.set(h, h, h);
        dummy.updateMatrix();
        mesh.setMatrixAt(placedCount, dummy.matrix);

        // subtle weathering tint per tree — breaks the clone look while
        // leaving the pixel bark's own palette untouched
        const l = 0.82 + 0.26 * hash2(gx, gz, 3413);
        tint.setRGB(l, l * 0.97, l * 0.93);
        mesh.setColorAt(placedCount, tint);

        treeX[placedCount] = wx;
        treeY[placedCount] = groundY;
        treeZ[placedCount] = wz;
        treeR[placedCount] = unitRadius * h;
        placed[placedCount] = 1;
        placedCount++;
      }
    }

    // park every instance beyond the live set
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
    for (const g of geos) g.dispose();
    for (const mat of mats) mat.dispose();
    for (const t of textures) t.dispose();
    geos.length = 0;
    mats.length = 0;
    textures.length = 0;
    loaded = false;
  }

  /* ----------------------------- loading ----------------------------- */

  /** Load the pixel bark; resolves null on failure so the dead pines
   *  fall back to a flat weathered tint instead of losing the model. */
  function loadBark(url: string): Promise<THREE.Texture | null> {
    return new Promise((resolve) => {
      new THREE.TextureLoader().load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = 4;
          textures.push(t);
          resolve(t);
        },
        undefined,
        () => resolve(null)
      );
    });
  }

  new GLTFLoader().load(
    PINE_URL,
    (gltf) => {
      loadBark(DEAD_BARK_URL).then((barkTex) => attach(gltf, barkTex));
    },
    undefined,
    (err: unknown) => {
      // load error: the dead pines just don't appear; the game keeps
      // running — but log the REAL reason so broken assets are findable
      const e = err as { message?: string; response?: { status?: number; url?: string } };
      console.warn(
        '[pineDead] failed to load',
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
