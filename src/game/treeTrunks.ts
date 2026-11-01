/**
 * Auto-spawning TREE TRUNK decor for the RATFIRE grasslands — the uploaded
 * Sketchfab "Low poly Tree Trunk" (public/models/low_poly_tree_trunk.glb).
 *
 * The trunk field streams over the whole endless terrain with the SAME
 * world-anchored recycling scheme as the fern bushes (see bushSystem.ts):
 *
 *  - The world is cut into one-block cells (BLOCK world units). Every
 *    tree instance owns a fixed cell residue inside a (2R+1)² window
 *    around the player's cell; cells that slide out of the trailing edge
 *    reappear at the leading edge, so walking in any direction keeps
 *    fresh trunks materialising ahead of you — zero allocation per frame.
 *  - A given patch of land ALWAYS grows the same trunks (deterministic
 *    per-cell hashes pick scale, tilt, rotation and jitter) — the field
 *    is world-anchored, never random per frame.
 *  - Cells are rejected when too steep (cliff edges) or inside the spawn
 *    keep-clear disc (the lobby showcase stays unobstructed), and trunks
 *    never spawn near the player while exploring (new instances always
 *    appear at the FAR leading edge of the window), so nothing can pop
 *    up underfoot.
 *
 * RENDERING — identical strategy to the bushes: the glTF is loaded once,
 * its meshes are baked into world space and merged PER MATERIAL, and the
 * species is drawn as InstancedMeshes (one draw call per material) that
 * share identical per-instance matrices across their material parts.
 * Trunks are rigid (no wind shader) and Lambert-shaded so they light
 * exactly like the voxel terrain and the character.
 *
 * SOLID COLLISION — unlike the ferns, trunks block the player: the handle
 * exposes pushOut(x, z, radius) which slides a collider out of every
 * trunk it overlaps. The collider is PIXEL-PERFECT: at load time the
 * model's real ground-level silhouette (root flares, bark bulges) is
 * baked into a star-shaped polygon, and pushOut resolves the mover
 * against that exact outline (circle-vs-polygon nearest-edge push = a
 * natural wall-slide along the TRUE silhouette — no springy fighting
 * with the character controller, no invisible shrunken disc). Big
 * trunks still block wider than saplings: every silhouette scales with
 * its per-instance size.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface TrunkSystemOptions {
  /** World units per voxel block edge (100). */
  block: number;
  /** Grid origin offset (64) — matches terrainChunks' grid mapping. */
  gridOffset: number;
  /** Terrain surface height at a world position (top of the block). */
  surfaceYAt(worldX: number, worldZ: number): number;
  /** Deterministic integer block height at grid coordinates. */
  blockHeight(gx: number, gz: number): number;
  /** Mobile LOW tier: fewer trunks, no shadow casting. */
  lowSpec?: boolean;
  /** Keep-clear disc around the player spawn (lobby showcase). */
  clearX?: number;
  clearZ?: number;
  clearRadius?: number;
}

export interface TrunkSystemHandle {
  /** True once the trunk model finished loading and instances exist. */
  ready(): boolean;
  /** Recycle cells around the player. Call per frame (cheap no-op when
   *  the player hasn't crossed a block boundary). */
  update(playerX: number, playerZ: number): void;
  /** Slide a collider of `radius` out of every placed trunk it overlaps.
   *  Returns the corrected position (same object every call — zero
   *  allocation). Pure radial push-out, so movement slides along trunks. */
  pushOut(x: number, z: number, radius: number): { x: number; z: number };
  /** World position + collision radius (x, z, r per triplet) of every
   *  PLACED trunk — consumed by effects/tooling (mirrors the bush
   *  field's fernFields accessor). Unplaced instances are omitted. */
  treeFields(): Array<{ data: Float32Array; count: number }>;
  stats(): { instances: number; placed: number };
  dispose(): void;
}

/* ------------------------------ tuning ------------------------------ */

/** The uploaded Sketchfab low-poly trunk — a chopped STUMP: brown bark
 *  ("Wood") with a pale cut top ("Wood_light"), root flare and a broken
 *  branch stub. Y-up, but naturally stout (≈ 1.0 wide × 0.56 tall), so
 *  in-game sizes below are STUMP heights and the width follows the
 *  model's own proportions (≈ 1.8 × height at the root flare). */
const TRUNK_URL = '/models/low_poly_tree_trunk.glb';

/** Pixel wood textures painted onto the stump's two GLB materials (the
 *  model ships flat colours only — no images and no UVs). trunk_bark
 *  wraps the bark sides ("Wood"), trunk_top covers the pale cut
 *  face ("Wood_light"). */
const TRUNK_BARK_URL = '/models/trunk_bark.png';
const TRUNK_TOP_URL = '/models/trunk_top.png';

/** Whole bark-texture repeats around the stump's circumference — kept
 *  integer so the cylindrical seam tiles edge-to-edge cleanly, and ≈
 *  square texels at the unit-height normalisation (circumference ≈ 3.6
 *  vs height 1). */
const BARK_REPEATS = 4;

/** Trees per one-BLOCK² cell (cell = 100 world units). The window holds
 *  (2R+1)² cells, so desktop spawns ~87 stumps around the traveller —
 *  kept light on purpose: scattered clearings, never a wall of wood. */
const DENSITY = 0.012;
const DENSITY_LOW = 0.009; // mobile: slightly sparser

/** SIZE — the SMALL stump class only. The MEDIUM and BIG variants were
 *  removed permanently, and their share of the field (60%) was folded
 *  into the SMALL class, so EVERY trunk now grows as a fresh-cut
 *  sapling stump of the same size range as before (~55..85 world units
 *  tall — the character is 190). A deterministic per-cell hash jitters
 *  within the range (world-anchored: the same spot always regrows the
 *  same size). */
const SIZE_SMALL_MIN = 55;
const SIZE_SMALL_VAR = 30;

/** Wrap window half-width, in cells (matches the bush field so both
 *  decor layers recycle on the same cadence). */
const RADIUS_DESKTOP = 40;
const RADIUS_LOW = 26;

/** Max block-height range across a cell before it counts as a cliff. */
const SLOPE_MAX_BLOCKS = 2;

/** How deep each stump roots into its block: a fraction of its own height
 *  (the flat-cut base sits close to the ground) with a floor so even the
 *  smallest stump hugs the terrain. */
const SINK_FRACTION = 0.08;
const SINK_MIN = 4;

/** Natural lean: stumps are cut flat, so only a tiny tilt (radians). */
const TILT_MAX = 0.04;

/** PIXEL-PERFECT COLLISION SHAPE — the bottom slice of the unit-height
 *  model whose REAL silhouette becomes the collision polygon (the part
 *  the player's body can actually touch: root flare + low bark). The
 *  silhouette is sampled into this many angular bins; at stump scales
 *  the chord error is far below a world unit, so the wall you feel is
 *  exactly the wood you see. */
const FOOTPRINT_BAND = 0.3;
const FOOTPRINT_BINS = 64;

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

/** The trunk GLB ships no UVs at all, so the pixel wood textures are
 *  projected here instead (run AFTER the unit-height normalisation):
 *  bark wraps cylindrically around the Y axis (u = angle × integer
 *  repeats, v = unit height) while the pale cut face is planar-
 *  projected from above across its own x/z bounds. */
function addPartUVs(g: THREE.BufferGeometry, cutFace: boolean): void {
  const pos = g.getAttribute('position');
  if (!pos) return;
  const uv = new Float32Array(pos.count * 2);
  if (cutFace) {
    g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb) return;
    const w = Math.max(1e-6, bb.max.x - bb.min.x);
    const d = Math.max(1e-6, bb.max.z - bb.min.z);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) - bb.min.x) / w;
      uv[i * 2 + 1] = (pos.getZ(i) - bb.min.z) / d;
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      let a = Math.atan2(pos.getZ(i), pos.getX(i));
      if (a < 0) a += Math.PI * 2;
      uv[i * 2] = (a / (Math.PI * 2)) * BARK_REPEATS;
      uv[i * 2 + 1] = pos.getY(i);
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export function createTrunks(scene: THREE.Scene, options: TrunkSystemOptions): TrunkSystemHandle {
  const block = options.block;
  const gridOffset = options.gridOffset;
  const lowSpec = options.lowSpec ?? false;
  const clearX = options.clearX ?? 0;
  const clearZ = options.clearZ ?? 0;
  const clearR2 = (options.clearRadius ?? 0) ** 2;

  const R = lowSpec ? RADIUS_LOW : RADIUS_DESKTOP;
  const W = 2 * R + 1; // window edge, in cells
  const count = Math.round(W * W * (lowSpec ? DENSITY_LOW : DENSITY) * 1.1); // +10% reject margin

  /* --- fixed per-instance cell residues inside the window (unique, so
   *     two trunks never land on the exact same cell and overlap) --- */
  const baseX = new Int32Array(count);
  const baseZ = new Int32Array(count);
  {
    const used = new Set<number>();
    let filled = 0;
    for (let attempt = 0; filled < count && attempt < count * 40; attempt++) {
      const bx = wrap(Math.floor(hash2(filled, 7, 907 + attempt * 7) * W * 4096), W);
      const bz = wrap(Math.floor(hash2(filled, 13, 1013 + attempt * 11) * W * 4096), W);
      const key = bz * W + bx;
      if (used.has(key)) continue;
      used.add(key);
      baseX[filled] = bx;
      baseZ[filled] = bz;
      filled++;
    }
  }

  /* --- per-instance placement state (read back by pushOut) --- */
  /** World position of each trunk's base; unplaced park at y = -1e5. */
  const treeX = new Float32Array(count);
  const treeY = new Float32Array(count).fill(-1e5);
  const treeZ = new Float32Array(count);
  /** Bounding radius per placed trunk (true silhouette × scale) — the
   *  broad-phase circle; the exact shape lives in the polygon below. */
  const treeR = new Float32Array(count);
  /** Per-instance scale + Y-rotation (cos/sin) for the exact narrow
   *  phase: the collider is resolved in the trunk's local space. */
  const treeScale = new Float32Array(count);
  const treeCos = new Float32Array(count);
  const treeSin = new Float32Array(count);
  const placed = new Uint8Array(count);
  let placedCount = 0;

  let loaded = false;
  const meshes: THREE.InstancedMesh[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.MeshLambertMaterial[] = [];
  const textures: THREE.Texture[] = [];

  const dummy = new THREE.Object3D();
  const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
  const slideOut = { x: 0, z: 0 }; // shared pushOut result — zero alloc

  /** Unit-height silhouette bounding radius, set once the model has
   *  loaded; the base of the per-instance broad-phase radius (scaled
   *  per tree at placement). Sane default so early pushOut calls are
   *  harmless before the model arrives. */
  let footprintRadius = 0.5;

  /** The pixel-perfect footprint: the model's real base silhouette as a
   *  star-shaped polygon in unit local space (+ its max radius), shared
   *  by every instance and transformed per trunk during pushOut. */
  const polyX = new Float32Array(FOOTPRINT_BINS);
  const polyZ = new Float32Array(FOOTPRINT_BINS);
  let polyMax = 0.5;

  /** Scratch result of resolveFootprint (zero allocation). */
  let resX = 0;
  let resZ = 0;

  /** Load the model, merge its meshes per material and build the
   *  InstancedMesh set (identical instance matrices across parts). */
  function attach(
    gltf: { scene: THREE.Group },
    barkTex: THREE.Texture | null,
    topTex: THREE.Texture | null
  ): void {
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

    // Normalise the WHOLE model with one transform: centre on x/z, stand
    // the base on y=0, scale to unit height — per-instance matrices then
    // set the real size.
    const bb = new THREE.Box3();
    for (const geosOfMat of groups.values()) {
      for (const g of geosOfMat) {
        g.computeBoundingBox();
        bb.union(g.boundingBox!);
      }
    }
    const cx = (bb.min.x + bb.max.x) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    const unit = 1 / Math.max(1e-6, bb.max.y - bb.min.y);
    for (const geosOfMat of groups.values()) {
      for (const g of geosOfMat) {
        g.translate(-cx, -bb.min.y, -cz);
        g.scale(unit, unit, unit);
      }
    }

    // Whole-model bbox radius — only used as the fallback silhouette if
    // the base band ever came out degenerate.
    const bboxRadius = Math.max(
      Math.abs(bb.min.x - cx),
      Math.abs(bb.max.x - cx),
      Math.abs(bb.min.z - cz),
      Math.abs(bb.max.z - cz)
    );

    // PIXEL-PERFECT FOOTPRINT — bake the model's real base silhouette:
    // the max radius per angular bin over every vertex in the touchable
    // bottom band, empty bins bridged between their nearest filled
    // neighbours. Root flares and bark bumps become exact collision
    // geometry; the high cut-top / branch stub is ignored (nothing the
    // grounded player can touch).
    const binR = new Float32Array(FOOTPRINT_BINS);
    for (const geosOfMat of groups.values()) {
      for (const g of geosOfMat) {
        const pos = g.getAttribute('position');
        if (!pos) continue;
        for (let vi = 0; vi < pos.count; vi++) {
          const vy = pos.getY(vi);
          if (vy < 0 || vy > FOOTPRINT_BAND) continue;
          const vx = pos.getX(vi);
          const vz = pos.getZ(vi);
          const r = Math.sqrt(vx * vx + vz * vz);
          if (r < 1e-5) continue;
          let a = Math.atan2(vz, vx);
          if (a < 0) a += Math.PI * 2;
          const bin = ((a / (Math.PI * 2)) * FOOTPRINT_BINS) | 0;
          if (bin >= 0 && bin < FOOTPRINT_BINS && r > binR[bin]) binR[bin] = r;
        }
      }
    }
    {
      let any = false;
      for (let b = 0; b < FOOTPRINT_BINS; b++) {
        if (binR[b] > 0) {
          any = true;
          break;
        }
      }
      if (!any) {
        binR.fill(bboxRadius);
      } else {
        for (let b = 0; b < FOOTPRINT_BINS; b++) {
          if (binR[b] > 0) continue;
          let prev = (b - 1 + FOOTPRINT_BINS) % FOOTPRINT_BINS;
          let next = (b + 1) % FOOTPRINT_BINS;
          let dPrev = 1;
          let dNext = 1;
          while (binR[prev] === 0 && dPrev <= FOOTPRINT_BINS) {
            prev = (prev - 1 + FOOTPRINT_BINS) % FOOTPRINT_BINS;
            dPrev++;
          }
          while (binR[next] === 0 && dNext <= FOOTPRINT_BINS) {
            next = (next + 1) % FOOTPRINT_BINS;
            dNext++;
          }
          binR[b] = (binR[prev] * dNext + binR[next] * dPrev) / (dPrev + dNext);
        }
      }
    }
    polyMax = 0;
    for (let b = 0; b < FOOTPRINT_BINS; b++) {
      const a = (b / FOOTPRINT_BINS) * Math.PI * 2;
      polyX[b] = Math.cos(a) * binR[b];
      polyZ[b] = Math.sin(a) * binR[b];
      if (binR[b] > polyMax) polyMax = binR[b];
    }
    // Broad-phase radius = the TRUE silhouette bounding radius of the
    // touchable base slice (not the whole-model bbox, so a high branch
    // stub never inflates ground collision).
    footprintRadius = polyMax;

    // UV the baked parts for the pixel wood textures (skipped per group
    // when its texture failed to load — flat colour fallback keeps the
    // attribute sets uniform inside each merge group).
    for (const [stdMat, geosOfMat] of groups) {
      const cutFace = /wood_light/i.test(stdMat.name);
      if (cutFace ? !topTex : !barkTex) continue;
      for (const g of geosOfMat) addPartUVs(g, cutFace);
    }

    // One InstancedMesh per material group.
    for (const [stdMat, geosOfMat] of groups) {
      const std = stdMat as THREE.MeshStandardMaterial;
      const tex = /wood_light/i.test(stdMat.name) ? topTex : barkTex;
      const merged =
        geosOfMat.length > 1
          ? BufferGeometryUtils.mergeGeometries(geosOfMat, false)
          : geosOfMat[0];

      // Lambert wood: shades exactly like the voxel terrain.
      const material = new THREE.MeshLambertMaterial({
        map: tex ?? std.map ?? null,
        color: tex || std.map ? 0xffffff : std.color.clone(),
        side: THREE.DoubleSide, // low-poly trunks often have open shells
      });
      if (std.transparent || std.alphaTest > 0) {
        material.alphaTest = std.alphaTest > 0 ? std.alphaTest : 0.5;
      }

      const mesh = new THREE.InstancedMesh(merged, material, count);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = false; // instances span the whole view; never cull
      mesh.castShadow = !lowSpec;
      mesh.receiveShadow = true;
      mesh.renderOrder = 1; // above the terrain, under transparent sky layers
      // park every instance out of sight until the first placement pass
      for (let i = 0; i < count; i++) mesh.setMatrixAt(i, zeroMat);
      scene.add(mesh);
      meshes.push(mesh);
      geos.push(merged);
      mats.push(material);
    }

    loaded = true;
    lastCx = Number.NaN; // force a placement pass on the next update
    lastCz = Number.NaN;
  }

  /* ------------------- placement (world-anchored) ------------------- */

  function placeAll(pcx: number, pcz: number): void {
    if (!loaded || meshes.length === 0) return;
    placedCount = 0;

    for (let i = 0; i < count; i++) {
      // wrap the fixed residue into the window around the player's cell
      const gx = pcx + wrap(baseX[i] - pcx, W) - R;
      const gz = pcz + wrap(baseZ[i] - pcz, W) - R;

      // world position: block centre + per-cell jitter (kept inside the
      // block so the trunk stands on its own column)
      const wx = (gx - gridOffset) * block + (hash2(gx, gz, 317) - 0.5) * block * 0.72;
      const wz = (gz - gridOffset) * block + (hash2(gx, gz, 523) - 0.5) * block * 0.72;

      // keep the lobby spawn showcase clear
      const dx = wx - clearX;
      const dz = wz - clearZ;
      if (dx * dx + dz * dz < clearR2) {
        park(i);
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
        park(i);
        continue;
      }

      // size: a per-cell hash jitters within the single SMALL range
      // (world-anchored — the same spot always regrows the same size;
      // the MEDIUM and BIG variants were removed permanently)
      const s = SIZE_SMALL_MIN + SIZE_SMALL_VAR * hash2(gx, gz, 733);

      const sink = Math.max(SINK_MIN, s * SINK_FRACTION);
      const groundY = options.surfaceYAt(wx, wz) - sink;
      const rotY = hash2(gx, gz, 811) * Math.PI * 2;

      // natural lean: a tiny tilt on a random azimuth (±TILT_MAX rad)
      const tiltAmp = (hash2(gx, gz, 839) - 0.5) * 2 * TILT_MAX;
      const tiltDir = hash2(gx, gz, 853) * Math.PI * 2;

      dummy.position.set(wx, groundY, wz);
      dummy.rotation.set(
        Math.sin(tiltDir) * tiltAmp,
        rotY,
        Math.cos(tiltDir) * tiltAmp
      );
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      for (const m of meshes) m.setMatrixAt(i, dummy.matrix);

      treeX[i] = wx;
      treeY[i] = groundY;
      treeZ[i] = wz;
      treeR[i] = footprintRadius * s;
      treeScale[i] = s;
      treeCos[i] = Math.cos(rotY);
      treeSin[i] = Math.sin(rotY);
      placed[i] = 1;
      placedCount++;
    }

    for (const m of meshes) m.instanceMatrix.needsUpdate = true;
  }

  /** Park an instance out of sight + out of collision. */
  function park(i: number): void {
    for (const m of meshes) m.setMatrixAt(i, zeroMat);
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

  /** Circle-vs-silhouette resolve in UNIT trunk-local space: pushes the
   *  point so a circle of radius `cr` no longer overlaps the pixel-perfect
   *  footprint polygon. Nearest-boundary push = the mover slides along the
   *  model's TRUE outline (root flares and all). Writes the corrected
   *  point into resX/resZ; returns true when it moved. */
  function resolveFootprint(lx: number, lz: number, cr: number): boolean {
    let x = lx;
    let z = lz;
    let moved = false;
    // two relax passes: the second cleans up corner cases where the
    // first push slid the circle into a neighbouring flare
    for (let iter = 0; iter < 2; iter++) {
      // quick reject: the circle's closest approach can't reach the wood
      const reach = polyMax + cr;
      if (x * x + z * z > reach * reach) break;
      // nearest point on the polygon boundary
      let bestD2 = Infinity;
      let qx = 0;
      let qz = 0;
      for (let i = 0, j = FOOTPRINT_BINS - 1; i < FOOTPRINT_BINS; j = i++) {
        const ax = polyX[j];
        const az = polyZ[j];
        const ex = polyX[i] - ax;
        const ez = polyZ[i] - az;
        const len2 = ex * ex + ez * ez;
        let t = len2 > 1e-12 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const dd2x = x - (ax + ex * t);
        const dd2z = z - (az + ez * t);
        const dd = dd2x * dd2x + dd2z * dd2z;
        if (dd < bestD2) {
          bestD2 = dd;
          qx = ax + ex * t;
          qz = az + ez * t;
        }
      }
      const dist = Math.sqrt(bestD2);
      // exact inside test (even-odd ray cast) — radial guesses misjudge
      // the gaps between root flares
      let inside = false;
      for (let i = 0, j = FOOTPRINT_BINS - 1; i < FOOTPRINT_BINS; j = i++) {
        const zi = polyZ[i];
        const zj = polyZ[j];
        if ((zi > z) !== (zj > z) && x < ((polyX[j] - polyX[i]) * (z - zi)) / (zj - zi) + polyX[i]) {
          inside = !inside;
        }
      }
      if (inside) {
        // buried in the wood: eject through the nearest boundary
        if (dist > 1e-6) {
          x = qx + ((qx - x) / dist) * cr;
          z = qz + ((qz - z) / dist) * cr;
        } else {
          const d = Math.sqrt(x * x + z * z) || 1e-4;
          x = (x / d) * reach;
          z = (z / d) * reach;
        }
        moved = true;
      } else if (dist < cr) {
        // touching the silhouette from outside: push out along the surface
        if (dist > 1e-6) {
          const push = cr - dist;
          x += ((x - qx) / dist) * push;
          z += ((z - qz) / dist) * push;
        } else {
          const d = Math.sqrt(x * x + z * z) || 1e-4;
          x = (x / d) * reach;
          z = (z / d) * reach;
        }
        moved = true;
      } else {
        break; // clear of this trunk's true outline
      }
    }
    resX = x;
    resZ = z;
    return moved;
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
      // broad phase: bounding circle of the trunk's true silhouette
      const minD = radius + treeR[i];
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD) continue;
      // narrow phase: exact circle-vs-silhouette in the trunk's local
      // space (inverse of the instance rotation + scale)
      const s = treeScale[i];
      const c = treeCos[i];
      const sn = treeSin[i];
      const lx = (dx * c - dz * sn) / s;
      const lz = (dx * sn + dz * c) / s;
      if (!resolveFootprint(lx, lz, radius / s)) continue;
      // local push back to world space
      x = (resX * c + resZ * sn) * s + treeX[i];
      z = (-resX * sn + resZ * c) * s + treeZ[i];
    }
    slideOut.x = x;
    slideOut.z = z;
    return slideOut;
  }

  function stats(): { instances: number; placed: number } {
    return { instances: count, placed: placedCount };
  }

  /** Packed [x, z, r] triplets of every placed trunk (rebuilt on call —
   *  this is a debug/tooling accessor, not a per-frame path). */
  function treeFields(): Array<{ data: Float32Array; count: number }> {
    const data = new Float32Array(placedCount * 3);
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (!placed[i]) continue;
      data[n * 3] = treeX[i];
      data[n * 3 + 1] = treeZ[i];
      data[n * 3 + 2] = treeR[i];
      n++;
    }
    return [{ data, count: placedCount }];
  }

  function dispose(): void {
    for (const m of meshes) {
      scene.remove(m);
      m.dispose();
    }
    for (const g of geos) g.dispose();
    for (const mat of mats) mat.dispose();
    for (const t of textures) t.dispose();
    meshes.length = 0;
    geos.length = 0;
    mats.length = 0;
    textures.length = 0;
    loaded = false;
  }

  /* ----------------------------- loading ----------------------------- */

  /** Load one pixel wood texture; resolves null on failure so the trunk
   *  falls back to its flat GLB colour instead of losing the model. */
  function loadWoodTexture(
    url: string,
    repeat: boolean
  ): Promise<THREE.Texture | null> {
    return new Promise((resolve) => {
      new THREE.TextureLoader().load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.wrapS = t.wrapT = repeat
            ? THREE.RepeatWrapping
            : THREE.ClampToEdgeWrapping;
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
    TRUNK_URL,
    (gltf) => {
      Promise.all([
        loadWoodTexture(TRUNK_BARK_URL, true),
        loadWoodTexture(TRUNK_TOP_URL, false),
      ]).then(([barkTex, topTex]) => attach(gltf, barkTex, topTex));
    },
    undefined,
    (err: unknown) => {
      // load error: the trunks just don't appear; the game keeps running
      // — but log the REAL reason so broken assets are findable
      const e = err as { message?: string; response?: { status?: number; url?: string } };
      console.warn(
        '[trunks] failed to load',
        TRUNK_URL,
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
    treeFields,
    stats,
    dispose,
  };
}
