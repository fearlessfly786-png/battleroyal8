/**
 * Shared placement math for the two pine systems (pineTrees.ts +
 * pineDeadTrees.ts) — the single source of truth for:
 *
 *  1. CANDIDACY — the world-anchored per-cell gates that decide which
 *     cells may hold a pine at all (keep-clear disc, cliff edges, the
 *     grove carving, density rolls). Pure functions of the cell, so
 *     any patch of land always proposes the same trees.
 *
 *  2. CANOPY CLEARANCE — the rule that guarantees two pine MESHES can
 *     never touch or merge. The whole model fits inside a cylinder of
 *     UNIT_CANOPY_R × height around its trunk axis (measured from the
 *     baked pine_tree_ps1.glb geometry), and a lean swings that
 *     cylinder sideways by LEAN × height, so two trees cannot intersect
 *     whenever their trunk axes stay at least pairNeed(…) apart —
 *     summed foliage radii × CANOPY_AIR plus each tree's worst lean.
 *
 * The clearance is enforced with deterministic greedy dart-throwing:
 * every candidate cell owns a priority hash, and a tree only wins its
 * spot if no conflicting candidate with a better priority managed to
 * win its own (resolved recursively + memoised). The result packs the
 * forest about as tightly as a sequential scatter would — yet stays a
 * pure function of the cell coordinates, so trees never pop in or out
 * as the streaming window slides around the player.
 *
 * Living pines resolve among themselves; dead pines additionally
 * yield to every living winner they would touch (a skeleton must
 * never pierce a living canopy) and resolve among themselves with the
 * same rule. Together: NO pine mesh — living or dead — overlaps.
 */

/** Widest horizontal reach of the NORMALISED pine model
 *  (pine_tree_ps1.glb): measured vertex-by-vertex from the baked
 *  geometry exactly as the game normalises it (bbox-centred, unit
 *  height) — the widest branch tier (~31% up the trunk) reaches
 *  0.4413 × height from the trunk axis. UNIT_CANOPY_R rounds that up,
 *  so every foliage vertex of every instance sits within
 *  UNIT_CANOPY_R × height of its trunk axis — the cylinder bound that
 *  makes the clearance rule below airtight. */
export const UNIT_CANOPY_R = 0.445;

/** Guaranteed open-air multiplier on the summed foliage radii of two
 *  neighbours: AFTER absorbing the worst combined lean (below), every
 *  surviving pair still keeps ≥ 2% of its summed foliage radius as
 *  pure air (~9-11 world units at these sizes). */
export const CANOPY_AIR = 1.02;

/** Lean reach of the widest foliage tier per unit of tree height:
 *  sin(TILT_MAX) × ~0.31 (the widest tier sits ~31% up the trunk).
 *  A leaning tree's foliage swings sideways by LEAN × height, which
 *  the clearance rule adds on top of the foliage radii — so even two
 *  maximally-opposed leans can never make two pine meshes touch. */
export const LEAN_LIVE = 0.01394; // sin(0.045) × 0.31 — living pines
export const LEAN_DEAD = 0.02786; // sin(0.09) × 0.31 — dead wood

/** Minimum trunk-axis distance between two pines whose foliage must
 *  never touch: the summed foliage radii times the air multiplier,
 *  plus each tree's worst lean swing at its widest tier. */
export function pairNeed(
  ha: number,
  aDead: boolean,
  hb: number,
  bDead: boolean
): number {
  const lean =
    (aDead ? LEAN_DEAD : LEAN_LIVE) * ha +
    (bDead ? LEAN_DEAD : LEAN_LIVE) * hb;
  return CANOPY_AIR * UNIT_CANOPY_R * (ha + hb) + lean;
}

/* ------------------- shared candidacy tuning ------------------- */

/** Stand-on-its-own column jitter (fraction of a block). */
const JITTER_FRACTION = 0.72;
/** Groves are carved on a coarse grid of GROVE_CELL×GROVE_CELL blocks. */
const GROVE_CELL = 5;
/** Fraction of the coarse grid that is grove — at 0.94 the forest
 *  blankets almost all the land, leaving small irregular meadows. */
const GROVE_FRACTION = 0.94;
/** Inside a grove EVERY cell proposes a tree — the canopy-clearance
 *  dart-throwing alone decides who wins, which keeps the stand at the
 *  physical packing limit while the per-cell jitter + priority hashes
 *  preserve the natural, irregular look. */
const GROVE_THIN = 0;
/** Lone pines in the rare open meadows (30× the old scatter). */
const DENSITY_OPEN = 0.072;
/** Max block-height range across a cell before it counts as a cliff. */
const SLOPE_MAX_BLOCKS = 2;

/** Height range in world units — matched 1:1 between living and dead
 *  pines (the character is 190 tall: forest giants 2.3×..3.3×). */
export const HEIGHT_MIN = 445;
export const HEIGHT_VAR = 185;
const HEIGHT_MAX = HEIGHT_MIN + HEIGHT_VAR;

/** Fresh hash salts that order the dart-throwing (never reused by the
 *  per-tree look hashes that live in the pine systems). */
const PRI_LIVE = 2477;
const PRI_DEAD = 3499;
/** Per-cell candidacy roll for DEAD pines (their density control). */
const DEAD_GATE_SALT = 3457;

/** Safety cap for the dart-throwing chain. Deep priority chains are
 *  rare but dense groves can grow long ones; the cap is FAIL-CLOSED —
 *  a candidate whose chain runs past it simply loses its spot, so the
 *  no-touch guarantee never depends on it. */
const MAX_CHAIN = 2048;

/** Dart-throwing priority blend: PRI_RAND weight on the pure hash,
 *  the rest on the candidate's height fraction. Smaller trees win
 *  contested spots more often, which packs a polymorphic forest
 *  noticeably tighter (a giant only claims space where no smaller
 *  rival needs it) while the hash half keeps the outcome irregular. */
const PRI_RAND = 0.5;

export interface SpacingCfg {
  /** World units per voxel block edge (100). */
  block: number;
  /** Grid origin offset (64) — matches terrainChunks' grid mapping. */
  gridOffset: number;
  /** Deterministic integer block height at grid coordinates. */
  blockHeight(gx: number, gz: number): number;
  /** Keep-clear disc around the player spawn (lobby showcase). */
  clearX: number;
  clearZ: number;
  clearRadius: number;
  /** Per-cell candidacy roll for DEAD pines (low spec uses less). */
  deadDensity?: number;
}

export interface PineSpot {
  /** Jittered world-space base position of the tree. */
  wx: number;
  wz: number;
  /** Tree height in world units. */
  h: number;
  /** Canopy radius: UNIT_CANOPY_R × h. */
  r: number;
  /** Priority hash — lower wins the spot. */
  pri: number;
}

/* --------------------------- small helpers --------------------------- */

/** Deterministic 0..1 hash from two integer coords + a seed salt.
 *  MUST stay identical to the copies in the pine systems (they hash
 *  rotation/tilt/tint from the same cells). */
function hash2(x: number, z: number, salt: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) | 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Strict total order on candidate cells: priority first, then cell
 *  coordinates as the tie-break. The dart-throwing chain always walks
 *  DOWN this order, which is what makes the recursion terminate. */
function before(
  ax: number, az: number, a: PineSpot,
  bx: number, bz: number, b: PineSpot
): boolean {
  if (a.pri !== b.pri) return a.pri < b.pri;
  if (ax !== bx) return ax < bx;
  return az < bz;
}

/** Jittered world position of a LIVING pine rooted at cell (gx, gz). */
function livePos(gx: number, gz: number, cfg: SpacingCfg): { x: number; z: number } {
  const b = cfg.block;
  return {
    x: (gx - cfg.gridOffset) * b + (hash2(gx, gz, 2179) - 0.5) * b * JITTER_FRACTION,
    z: (gz - cfg.gridOffset) * b + (hash2(gx, gz, 2267) - 0.5) * b * JITTER_FRACTION,
  };
}

/** Jittered world position of a DEAD pine rooted at cell (gx, gz). */
function deadPos(gx: number, gz: number, cfg: SpacingCfg): { x: number; z: number } {
  const b = cfg.block;
  return {
    x: (gx - cfg.gridOffset) * b + (hash2(gx, gz, 3203) - 0.5) * b * JITTER_FRACTION,
    z: (gz - cfg.gridOffset) * b + (hash2(gx, gz, 3251) - 0.5) * b * JITTER_FRACTION,
  };
}

/** Shared cliff gate: the voxel height across the block must stay
 *  within a couple of steps or the cell is rejected. */
function tooSteep(gx: number, gz: number, cfg: SpacingCfg): boolean {
  const h00 = cfg.blockHeight(gx, gz);
  const h10 = cfg.blockHeight(gx + 1, gz);
  const h01 = cfg.blockHeight(gx, gz + 1);
  const h11 = cfg.blockHeight(gx + 1, gz + 1);
  return Math.max(h00, h10, h01, h11) - Math.min(h00, h10, h01, h11) > SLOPE_MAX_BLOCKS;
}

/** Shared keep-clear gate (the lobby spawn showcase stays empty). */
function inKeepClear(wx: number, wz: number, cfg: SpacingCfg): boolean {
  const dx = wx - cfg.clearX;
  const dz = wz - cfg.clearZ;
  return dx * dx + dz * dz < cfg.clearRadius * cfg.clearRadius;
}

/** Scan half-width, in cells, that surely covers every possible
 *  conflict partner of a tree of height h: neighbours whose closest
 *  possible approach (cell gap minus both jitters) still exceeds the
 *  worst-case clearance cannot conflict and are skipped. */
function scanCells(h: number, cfg: SpacingCfg): number {
  return Math.floor(
    ((CANOPY_AIR * UNIT_CANOPY_R + LEAN_DEAD) * (HEIGHT_MAX + h)) /
      cfg.block +
      JITTER_FRACTION
  );
}

/* ------------------------------ caches ------------------------------ */
/* Placement is a pure function of the cell, so results memoise across
 * passes, frames and even systems; the maps only exist to keep the
 * recursion cheap. They are trimmed when they grow past a sane bound —
 * the values themselves never go stale. */

const candCache = new Map<number, PineSpot | null>();
const deadCandCache = new Map<number, PineSpot | null>();
const liveWinCache = new Map<number, PineSpot | null>();
const deadWinCache = new Map<number, PineSpot | null>();

const CACHE_LIMIT = 120000;

function cellKey(gx: number, gz: number): number {
  return (gx + 0x40000) * 0x80000 + (gz + 0x40000);
}

/** Forget every memoised result (they are pure, so this is only ever
 *  a memory reclaim, never a correctness fix). */
export function resetSpacingCache(): void {
  candCache.clear();
  deadCandCache.clear();
  liveWinCache.clear();
  deadWinCache.clear();
}

/* ---------------------------- living pines --------------------------- */

/** Candidacy of a LIVING pine: the exact gates pineTrees.ts applied
 *  inline (keep-clear, grove carving, cliff reject), plus the tree's
 *  height, canopy radius and dart-throwing priority. */
export function liveCandidateAt(gx: number, gz: number, cfg: SpacingCfg): PineSpot | null {
  const pos = livePos(gx, gz, cfg);
  if (inKeepClear(pos.x, pos.z, cfg)) return null;
  const inGrove =
    hash2(Math.floor(gx / GROVE_CELL), Math.floor(gz / GROVE_CELL), 2089) < GROVE_FRACTION;
  const roll = hash2(gx, gz, 2129);
  if (inGrove ? roll < GROVE_THIN : roll > DENSITY_OPEN) return null;
  if (tooSteep(gx, gz, cfg)) return null;
  const h = HEIGHT_MIN + HEIGHT_VAR * hash2(gx, gz, 2281);
  const pri =
    PRI_RAND * hash2(gx, gz, PRI_LIVE) +
    (1 - PRI_RAND) * ((h - HEIGHT_MIN) / HEIGHT_VAR);
  return { wx: pos.x, wz: pos.z, h, r: UNIT_CANOPY_R * h, pri };
}

function liveCandCached(gx: number, gz: number, cfg: SpacingCfg): PineSpot | null {
  const k = cellKey(gx, gz);
  let c = candCache.get(k);
  if (c === undefined) {
    c = liveCandidateAt(gx, gz, cfg);
    candCache.set(k, c);
  }
  return c;
}

/**
 * The spot a LIVING pine wins at cell (gx, gz), or null.
 *
 * Deterministic greedy dart-throwing: the candidate keeps its tree
 * only if no CONFLICTING candidate with a better (lower) priority won
 * its own spot. A conflict is canopy interpenetration — trunk axes
 * closer than CANOPY_CLEAR × (r₁ + r₂) — so whatever survives is
 * guaranteed a full ring of open air around its foliage.
 */
export function livePlaceAt(gx: number, gz: number, cfg: SpacingCfg, depth = 0): PineSpot | null {
  if (candCache.size > CACHE_LIMIT || liveWinCache.size > CACHE_LIMIT) resetSpacingCache();
  const k = cellKey(gx, gz);
  if (liveWinCache.has(k)) return liveWinCache.get(k)!;
  const self = liveCandCached(gx, gz, cfg);
  let out: PineSpot | null = null;
  if (self && depth < MAX_CHAIN) {
    out = self;
    const R = scanCells(self.h, cfg);
    outer: for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = gx + dx;
        const nz = gz + dz;
        const other = liveCandCached(nx, nz, cfg);
        if (!other) continue;
        const ddx = other.wx - self.wx;
        const ddz = other.wz - self.wz;
        const minD = pairNeed(self.h, false, other.h, false);
        if (ddx * ddx + ddz * ddz >= minD * minD) continue;
        // a better-priority rival: only a problem if it wins its spot
        if (!before(nx, nz, other, gx, gz, self)) continue;
        if (livePlaceAt(nx, nz, cfg, depth + 1)) {
          out = null;
          break outer;
        }
      }
    }
  }
  liveWinCache.set(k, out);
  return out;
}

/* ----------------------------- dead pines ---------------------------- */

/** Candidacy of a DEAD pine: keep-clear + cliff gates, then the sparse
 *  per-cell roll that keeps lone skeletons rare. Dead wood ignores the
 *  grove carving — a skeleton may stand in a meadow or, where the
 *  living forest leaves room, at a grove's edge. */
export function deadCandidateAt(gx: number, gz: number, cfg: SpacingCfg): PineSpot | null {
  const pos = deadPos(gx, gz, cfg);
  if (inKeepClear(pos.x, pos.z, cfg)) return null;
  if (hash2(gx, gz, DEAD_GATE_SALT) >= (cfg.deadDensity ?? 0)) return null;
  if (tooSteep(gx, gz, cfg)) return null;
  const h = HEIGHT_MIN + HEIGHT_VAR * hash2(gx, gz, 3301);
  const pri =
    PRI_RAND * hash2(gx, gz, PRI_DEAD) +
    (1 - PRI_RAND) * ((h - HEIGHT_MIN) / HEIGHT_VAR);
  return { wx: pos.x, wz: pos.z, h, r: UNIT_CANOPY_R * h, pri };
}

function deadCandCached(gx: number, gz: number, cfg: SpacingCfg): PineSpot | null {
  const k = cellKey(gx, gz);
  let c = deadCandCache.get(k);
  if (c === undefined) {
    c = deadCandidateAt(gx, gz, cfg);
    deadCandCache.set(k, c);
  }
  return c;
}

/**
 * The spot a DEAD pine wins at cell (gx, gz), or null. Dead wood
 * yields to every LIVING winner whose canopy it would touch (same
 * cell included), then resolves against rival skeletons with the same
 * deterministic dart-throwing as the living forest.
 */
export function deadPlaceAt(gx: number, gz: number, cfg: SpacingCfg, depth = 0): PineSpot | null {
  if (deadCandCache.size > CACHE_LIMIT || deadWinCache.size > CACHE_LIMIT) resetSpacingCache();
  const k = cellKey(gx, gz);
  if (deadWinCache.has(k)) return deadWinCache.get(k)!;
  const self = deadCandCached(gx, gz, cfg);
  let out: PineSpot | null = null;
  if (self && depth < MAX_CHAIN) {
    out = self;
    const R = scanCells(self.h, cfg);
    // yield to the living first — kills most grove skeletons early
    outer: for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const live = livePlaceAt(gx + dx, gz + dz, cfg, depth + 1);
        if (!live) continue;
        const ddx = live.wx - self.wx;
        const ddz = live.wz - self.wz;
        const minD = pairNeed(self.h, true, live.h, false);
        if (ddx * ddx + ddz * ddz < minD * minD) {
          out = null;
          break outer;
        }
      }
    }
    // then the usual dart-throw against rival dead candidates
    if (out) {
      outer2: for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = gx + dx;
          const nz = gz + dz;
          const other = deadCandCached(nx, nz, cfg);
          if (!other) continue;
          const ddx = other.wx - self.wx;
          const ddz = other.wz - self.wz;
          const minD = pairNeed(self.h, true, other.h, true);
          if (ddx * ddx + ddz * ddz >= minD * minD) continue;
          if (!before(nx, nz, other, gx, gz, self)) continue;
          if (deadPlaceAt(nx, nz, cfg, depth + 1)) {
            out = null;
            break outer2;
          }
        }
      }
    }
  }
  deadWinCache.set(k, out);
  return out;
}
