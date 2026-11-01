/**
 * Infinite chunked voxel terrain for RATFIRE.
 *
 * The original map was a single 128x128 merged voxel mesh; this module turns
 * the exact same generator into an endless streaming world:
 *
 *  - DETERMINISTIC HEIGHT FIELD: `blockHeight(gx, gz)` reproduces the original
 *    4-octave ImprovedNoise sum per block (quality 2/8/32/128, `*0.15 | 0`)
 *    using a per-session seed. The grid origin keeps its +64 offset, so the
 *    spawn area is IDENTICAL to the old fixed map — the world simply no
 *    longer ends at the old borders.
 *  - CHUNKS: the plane is cut into CHUNK_BLOCKS x CHUNK_BLOCKS block chunks,
 *    each merged into its own mesh (one draw call, frustum-culled). Side
 *    faces are generated from the global height function, so chunk seams are
 *    invisible and the streaming frontier never shows holes.
 *  - STREAMING: `update(playerX, playerZ)` keeps every chunk within
 *    `viewRadius` (Chebyshev distance) of the player loaded, builds missing
 *    ones nearest-first with a per-frame budget (no hitching), and disposes
 *    chunks that fall more than one ring behind — the terrain behind you is
 *    freed as new terrain materialises ahead of you.
 *  - COLLISION: `surfaceYAt(worldX, worldZ)` answers from the deterministic
 *    height function, so walking, gravity, fall damage and the camera work
 *    at any distance from the origin, even over not-yet-meshed ground.
 *  - FLATTEN PADS: decor systems (dungeon caves) can register rectangular
 *    pads that level the terrain inside them to one height — the chunk
 *    meshes overlapping a pad are rebuilt silently so the ground under a
 *    placed prop is perfectly plane.
 */

import * as THREE from 'three';
import { ImprovedNoise } from 'three/examples/jsm/math/ImprovedNoise.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface TerrainChunksOptions {
  /** World units per voxel block edge (100). */
  block: number;
  /** Grid origin offset (64) — keeps spawn-area terrain identical to the
   *  original fixed 128x128 map (world x = (gx - gridOffset) * block). */
  gridOffset: number;
  /** Blocks per chunk side. */
  chunkBlocks?: number;
  /** Loaded-chunk radius around the player, in chunks (Chebyshev distance). */
  viewRadius?: number;
  /** ImprovedNoise z coordinate — the per-session terrain seed. */
  seedZ: number;
  /** Mobile LOW tier: smaller radius + build budget. */
  lowSpec?: boolean;
  /** Optional decor hook: fired right after a chunk mesh is built (used by
   *  the dungeon cave system to stream map props with the terrain). */
  onChunkBuilt?(cx: number, cz: number): void;
  /** Optional decor hook: fired when a chunk mesh is unloaded. */
  onChunkUnloaded?(cx: number, cz: number): void;
}

/** A flat pad of terrain: every block inside the inclusive grid bounds is
 *  levelled to `height` (the dungeon caves use this to give each ruin a
 *  plane, straight patch of ground that smoothly touches its bottom). */
export interface FlattenRect {
  id: string;
  /** Inclusive grid-block bounds of the pad. */
  gx0: number;
  gx1: number;
  gz0: number;
  gz1: number;
  /** Integer blockHeight-grid value the whole pad is levelled to. */
  height: number;
}

export interface TerrainChunksHandle {
  /** Stream around the player: build ahead, unload behind. Call per frame. */
  update(playerX: number, playerZ: number): void;
  /** Immediately (sync=true) or prioritised (sync=false) load the chunks
   *  within `radius` chunks of the point — used for spawn + respawn. */
  ensureAround(playerX: number, playerZ: number, radius: number, sync: boolean): void;
  /** Deterministic integer block height at grid coordinates. */
  blockHeight(gx: number, gz: number): number;
  /** Terrain surface height (top of the block) at a world-space position. */
  surfaceYAt(worldX: number, worldZ: number): number;
  /** Loaded chunk count + build-queue length (debug handle). */
  stats(): { chunks: number; pending: number };
  /** Level a pad of terrain flat and silently rebuild the loaded chunk
   *  meshes that overlap it (decor hooks stay silent — pad edits are NOT
   *  streaming events and must not re-trigger prop placement). */
  addFlattenRect(rect: FlattenRect): void;
  /** Remove a pad and silently rebuild its chunks back to natural terrain. */
  removeFlattenRect(id: string): void;
  dispose(): void;
}

/** Height-cache cap: beyond this many memoised blocks the cache resets
 *  (a cache miss is only four ImprovedNoise calls, so this is invisible). */
const HEIGHT_CACHE_CAP = 250_000;

export function createTerrainChunks(
  scene: THREE.Scene,
  options: TerrainChunksOptions
): TerrainChunksHandle {
  const block = options.block;
  const gridOffset = options.gridOffset;
  const chunkBlocks = options.chunkBlocks ?? 16;
  const viewRadius = Math.max(2, options.viewRadius ?? 6);
  const buildBudget = options.lowSpec ? 1 : 2; // chunk meshes built per frame

  // ---------------- deterministic height field ----------------
  const perlin = new ImprovedNoise();
  const seedZ = options.seedZ;
  const heightCache = new Map<string, number>();

  /** The pure perlin base (original demo octave stack) — the city
   *  plateau levels itself to this at its centre. */
  function baseHeight(gx: number, gz: number): number {
    let h = 0;
    let quality = 2;
    for (let o = 0; o < 4; o++) {
      h += perlin.noise(gx / quality, gz / quality, seedZ) * quality;
      quality *= 4;
    }
    return (h * 0.15) | 0;
  }

  /** The FULL natural height — GRASSLANDS ONLY: the pure 4-octave perlin
   *  base. (All other-biome swells were removed with the biomes.) */
  function naturalHeight(gx: number, gz: number): number {
    return baseHeight(gx, gz);
  }

  function blockHeight(gx: number, gz: number): number {
    // flatten pads are answered BEFORE the cache: padded blocks never enter
    // the cache, so adding/removing a pad can never leave stale entries
    for (const rect of flattenRects.values()) {
      if (gx >= rect.gx0 && gx <= rect.gx1 && gz >= rect.gz0 && gz <= rect.gz1) {
        return rect.height;
      }
    }

    const key = gx + ',' + gz;
    const cached = heightCache.get(key);
    if (cached !== undefined) return cached;

    // natural terrain (base perlin + every biome swell)
    const height = naturalHeight(gx, gz);

    if (heightCache.size > HEIGHT_CACHE_CAP) heightCache.clear();
    heightCache.set(key, height);
    return height;
  }

  /** Terrain surface height (top of the block) at a world-space position. */
  function surfaceYAt(worldX: number, worldZ: number): number {
    const gx = Math.round(worldX / block) + gridOffset;
    const gz = Math.round(worldZ / block) + gridOffset;
    return blockHeight(gx, gz) * block + block / 2;
  }

  // ---------------- shared voxel face prototypes ----------------
  // Same geometry + UV tweaks as the original demo (atlas-mapped textures).
  const matrix = new THREE.Matrix4();
  // second matrix for the stacked wall-fill faces below (the shared
  // `matrix` must stay untouched while one block's faces are emitted)
  const wallMatrix = new THREE.Matrix4();

  const pxGeometry = new THREE.PlaneGeometry(block, block);
  pxGeometry.attributes.uv.array[1] = 0.5;
  pxGeometry.attributes.uv.array[3] = 0.5;
  pxGeometry.rotateY(Math.PI / 2);
  pxGeometry.translate(block / 2, 0, 0);

  const nxGeometry = new THREE.PlaneGeometry(block, block);
  nxGeometry.attributes.uv.array[1] = 0.5;
  nxGeometry.attributes.uv.array[3] = 0.5;
  nxGeometry.rotateY(-Math.PI / 2);
  nxGeometry.translate(-block / 2, 0, 0);

  const pyGeometry = new THREE.PlaneGeometry(block, block);
  pyGeometry.attributes.uv.array[5] = 0.5;
  pyGeometry.attributes.uv.array[7] = 0.5;
  pyGeometry.rotateX(-Math.PI / 2);
  pyGeometry.translate(0, block / 2, 0);

  const pzGeometry = new THREE.PlaneGeometry(block, block);
  pzGeometry.attributes.uv.array[1] = 0.5;
  pzGeometry.attributes.uv.array[3] = 0.5;
  pzGeometry.translate(0, 0, block / 2);

  const nzGeometry = new THREE.PlaneGeometry(block, block);
  nzGeometry.attributes.uv.array[1] = 0.5;
  nzGeometry.attributes.uv.array[3] = 0.5;
  nzGeometry.rotateY(Math.PI);
  nzGeometry.translate(0, 0, -block / 2);

  const texture = new THREE.TextureLoader().load(
    '/textures/minecraft/atlas.png'
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;

  const material = new THREE.MeshLambertMaterial({
    map: texture,
    side: THREE.DoubleSide,
  });

  // ---------------- chunk store ----------------
  interface Chunk {
    cx: number;
    cz: number;
    /** 1 merged mesh (the grass world). */
    meshes: THREE.Mesh[];
  }
  const chunks = new Map<string, Chunk>();

  function chunkKey(cx: number, cz: number): string {
    return cx + ',' + cz;
  }

  /** Builds one chunk mesh (merged voxel faces) and adds it to the scene. */
  function buildChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (chunks.has(key)) return;

    const baseX = cx * chunkBlocks;
    const baseZ = cz * chunkBlocks;
    // GRASSLANDS ONLY: every block lands in the single grass bucket — one
    // merged mesh per chunk (one draw call).
    const grassParts: THREE.BufferGeometry[] = [];

    for ( let lz = 0; lz < chunkBlocks; lz++ ) {
      for ( let lx = 0; lx < chunkBlocks; lx++ ) {
        const gx = baseX + lx;
        const gz = baseZ + lz;
        const h = blockHeight(gx, gz);

        matrix.makeTranslation(
          (gx - gridOffset) * block,
          h * block,
          (gz - gridOffset) * block
        );

        // neighbour heights come from the global function, so faces at
        // chunk borders match the adjacent chunk exactly (no seams; the
        // wall-fill below is symmetric in the global height field, so
        // 2+ steps are sealed identically from either side of a border)
        const px = blockHeight(gx + 1, gz);
        const nx = blockHeight(gx - 1, gz);
        const pz = blockHeight(gx, gz + 1);
        const nz = blockHeight(gx, gz - 1);

        const bucket = grassParts;

        bucket.push(pyGeometry.clone().applyMatrix4(matrix));

        // SIDE FACES + WALL FILL. The original demo draws one 1-block side
        // face per side, which seals the 1-step cases perfectly — but where
        // the height jumps by 2+ between neighbouring columns the wall
        // between the two tops is 2+ blocks tall while only its topmost
        // face existed, leaving a 1-block-tall SEE-THROUGH SLIT mid-wall
        // (the "missing blocks" the dune country showed: the swell
        // regularly terraces by 2-3 blocks). The LOWER column now stacks
        // extra faces up towards its higher neighbour (levels h+1..hn-1),
        // the higher column still draws its own face (level hn) — every
        // wall is then tiled exactly once: no holes, no z-fighting.
        if (px !== h && px !== h + 1) {
          bucket.push(pxGeometry.clone().applyMatrix4(matrix));
          for (let k = h + 1; k < px; k++) {
            wallMatrix.makeTranslation(
              (gx - gridOffset) * block,
              k * block,
              (gz - gridOffset) * block
            );
            bucket.push(pxGeometry.clone().applyMatrix4(wallMatrix));
          }
        }
        if (nx !== h && nx !== h + 1) {
          bucket.push(nxGeometry.clone().applyMatrix4(matrix));
          for (let k = h + 1; k < nx; k++) {
            wallMatrix.makeTranslation(
              (gx - gridOffset) * block,
              k * block,
              (gz - gridOffset) * block
            );
            bucket.push(nxGeometry.clone().applyMatrix4(wallMatrix));
          }
        }
        if (pz !== h && pz !== h + 1) {
          bucket.push(pzGeometry.clone().applyMatrix4(matrix));
          for (let k = h + 1; k < pz; k++) {
            wallMatrix.makeTranslation(
              (gx - gridOffset) * block,
              k * block,
              (gz - gridOffset) * block
            );
            bucket.push(pzGeometry.clone().applyMatrix4(wallMatrix));
          }
        }
        if (nz !== h && nz !== h + 1) {
          bucket.push(nzGeometry.clone().applyMatrix4(matrix));
          for (let k = h + 1; k < nz; k++) {
            wallMatrix.makeTranslation(
              (gx - gridOffset) * block,
              k * block,
              (gz - gridOffset) * block
            );
            bucket.push(nzGeometry.clone().applyMatrix4(wallMatrix));
          }
        }
      }
    }

    // merge the grass bucket into its one-draw-call mesh
    const meshes: THREE.Mesh[] = [];
    if (grassParts.length > 0) {
      const merged = BufferGeometryUtils.mergeGeometries(grassParts);
      for (const part of grassParts) part.dispose();
      if (merged) {
        merged.computeBoundingSphere();

        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = true; // hills cast shadows into valleys
        mesh.receiveShadow = true; // player shadow lands here
        mesh.matrixAutoUpdate = false; // static geometry, world-space vertices
        scene.add(mesh);
        meshes.push(mesh);
      }
    }
    if (meshes.length === 0) return;

    chunks.set(key, { cx, cz, meshes });
    if (!silentRebuild) options.onChunkBuilt?.(cx, cz);
  }

  function unloadChunk(key: string, chunk: Chunk): void {
    for (const mesh of chunk.meshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    chunks.delete(key);
    if (!silentRebuild) options.onChunkUnloaded?.(chunk.cx, chunk.cz);
  }

  /** Player chunk coordinates from a world position. */
  function playerChunk(playerX: number, playerZ: number): { cx: number; cz: number } {
    const gx = playerX / block + gridOffset;
    const gz = playerZ / block + gridOffset;
    return {
      cx: Math.floor(gx / chunkBlocks),
      cz: Math.floor(gz / chunkBlocks),
    };
  }

  /**
   * Streams the world around (pcx, pcz): builds up to `budget` missing
   * chunks (nearest first), unloads everything beyond viewRadius + 1.
   */
  let pendingCount = 0;

  function stream(pcx: number, pcz: number, budget: number): void {
    // --- collect missing chunks inside the view radius, nearest first ---
    const missing: Array<{ cx: number; cz: number; d: number }> = [];
    for (let dz = -viewRadius; dz <= viewRadius; dz++) {
      for (let dx = -viewRadius; dx <= viewRadius; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (!chunks.has(chunkKey(cx, cz))) {
          missing.push({ cx, cz, d: Math.max(Math.abs(dx), Math.abs(dz)) });
        }
      }
    }
    pendingCount = missing.length;
    if (missing.length > 0) {
      missing.sort((a, b) => a.d - b.d);
      for (let i = 0; i < Math.min(budget, missing.length); i++) {
        buildChunk(missing[i].cx, missing[i].cz);
      }
    }

    // --- unload terrain that fell out of the keep-radius behind the player ---
    const keep = viewRadius + 1;
    for (const [key, chunk] of chunks) {
      const d = Math.max(
        Math.abs(chunk.cx - pcx),
        Math.abs(chunk.cz - pcz)
      );
      if (d > keep) unloadChunk(key, chunk);
    }
  }

  // ---------------- flatten pads (dungeon-cave building sites) -------------
  const flattenRects = new Map<string, FlattenRect>();
  /** While true, chunk build/unload fires NO decor hooks — pad rebuilds are
   *  internal terrain edits, not streaming events. */
  let silentRebuild = false;

  /** Rebuild every LOADED chunk mesh overlapping the pad (unloaded ones will
   *  pick the pad up naturally the next time they stream in). */
  function rebuildPadChunks(rect: FlattenRect): void {
    const minCx = Math.floor(rect.gx0 / chunkBlocks);
    const maxCx = Math.floor(rect.gx1 / chunkBlocks);
    const minCz = Math.floor(rect.gz0 / chunkBlocks);
    const maxCz = Math.floor(rect.gz1 / chunkBlocks);
    const prev = silentRebuild;
    silentRebuild = true;
    try {
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const key = chunkKey(cx, cz);
          const chunk = chunks.get(key);
          if (!chunk) continue;
          unloadChunk(key, chunk);
          buildChunk(cx, cz);
        }
      }
    } finally {
      silentRebuild = prev;
    }
  }

  function addFlattenRect(rect: FlattenRect): void {
    flattenRects.set(rect.id, rect);
    rebuildPadChunks(rect);
  }

  function removeFlattenRect(id: string): void {
    const rect = flattenRects.get(id);
    if (!rect) return;
    flattenRects.delete(id);
    rebuildPadChunks(rect);
  }

  // ---------------- public API ----------------

  function update(playerX: number, playerZ: number): void {
    const { cx, cz } = playerChunk(playerX, playerZ);
    // Runs EVERY frame on purpose: the per-frame build budget is what lets
    // the frontier catch up after a chunk crossing adds a whole new row of
    // missing chunks (the scan itself is only ~a hundred map lookups).
    stream(cx, cz, buildBudget);
  }

  function ensureAround(
    playerX: number,
    playerZ: number,
    radius: number,
    sync: boolean
  ): void {
    const { cx, cz } = playerChunk(playerX, playerZ);
    if (!sync) return; // non-sync is covered by the per-frame update()
    // synchronous: every missing chunk in the radius is built right now,
    // guaranteeing ground under the player (spawn, respawn, teleports)
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        buildChunk(cx + dx, cz + dz);
      }
    }
  }

  function stats(): { chunks: number; pending: number } {
    return { chunks: chunks.size, pending: pendingCount };
  }

  function dispose(): void {
    for (const chunk of chunks.values()) {
      for (const mesh of chunk.meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    chunks.clear();
    heightCache.clear();
    material.dispose();
    texture.dispose();
  }

  return {
    update,
    ensureAround,
    blockHeight,
    surfaceYAt,
    stats,
    addFlattenRect,
    removeFlattenRect,
    dispose,
  };
}
