/**
 * RATFIRE WATCHTOWER — a Minecraft-style voxel watchtower built ONE BLOCK AT
 * A TIME to clone the reference renders (front, back, top and underside).
 *
 * Every block is a textured cube on a strict grid (B = 100 world units, the
 * same edge as one terrain block, so the 190-tall hero reads ~1.9 blocks —
 * true Minecraft proportions). The textures are generated big-pixel PNGs
 * (public/models/tower/*.png) drawn with NearestFilter for the crunchy
 * Minecraft look.
 *
 * STRUCTURE (tower-local block coords, y = 0 at the base level):
 *   - 4 stone-brick legs (2x2) with yellow/black HAZARD-striped bases on
 *     4x4 footing pads, each leg rooted into the terrain (fills down).
 *   - Dark brick cross-brace bands + chunky X braces on three faces
 *     (the fourth face carries the staircase).
 *   - A wooden staircase that WINDS around the tower: entry steps from the
 *     ground, a 2-wide flight up the right face, a mid landing, a spine
 *     walkway and a second flight arriving on the platform — every step
 *     WALKABLE via the ground override (the player auto-steps up).
 *   - The main platform: 15x15 wood-plank floor, stone corner turrets with
 *     glowing lanterns, dark post-and-rail fencing (gapped where the stairs
 *     arrive) and 8 hanging war banners (black + gold phoenix).
 *   - The cabin: orange plank walls with a glass window band on all faces.
 *   - The roof: three stepped stone-brick slabs, a red/white striped
 *     antenna with a glowing red beacon, and a tilted voxel satellite dish.
 *
 * COLLISION — pixel perfect per block: every solid block is an exact AABB
 * and pushOut() resolves the player's circle against each outline (slides
 * along walls, can never clip through). Stair/landing/floor blocks are
 * WALKABLE, not walls: they feed groundYAt() (the player stands on them and
 * auto-steps up a block at a time) and only push back when they are "in the
 * face" (higher than one step) — so the player walks THROUGH/UP the stairs
 * smoothly and can never walk through walls, railings or legs.
 */

import * as THREE from 'three';

export interface WatchTowerOptions {
  /** Terrain surface height at a world position (for rooting the legs). */
  surfaceYAt(worldX: number, worldZ: number): number;
  /** Tower centre in world XZ. */
  x: number;
  z: number;
  /** Mobile LOW tier: no shadow casting (geometry is identical). */
  lowSpec?: boolean;
}

export interface WatchTowerHandle {
  /** True once the block map is built (collision active immediately). */
  ready(): boolean;
  /** Slide a collider out of every solid tower block it overlaps at this
   *  height. Returns the corrected position (shared object, zero alloc). */
  pushOut(
    x: number,
    z: number,
    radius: number,
    feetY: number
  ): { x: number; z: number };
  /** Highest WALKABLE tower surface (stairs / landing / platform floor)
   *  under this XZ position that the mover can stand on or step up onto.
   *  Returns -Infinity when no tower surface applies here. */
  groundYAt(x: number, z: number, feetY: number, ascending: boolean): number;
  stats(): { blocks: number; solid: number; walkable: number; baseY: number };
  dispose(): void;
}

type BlockType =
  | 'stone'
  | 'dark'
  | 'wood'
  | 'darkwood'
  | 'glass'
  | 'hazard'
  | 'lantern'
  | 'beacon'
  | 'antenna';

/* ------------------------------ tuning ------------------------------ */

const B = 100; // world units per block edge (matches terrain blocks)
const STEP_UP = 110; // max auto-step height (one block + slack)
const BODY = 185; // collision body height (just under CHAR_HEIGHT)
const EPS = 8; // skin: standing exactly on top never pushes

const TEX_DIR = '/models/tower/';
const TEX_FILES: Record<BlockType, string> = {
  stone: 'stone_bricks.png',
  dark: 'dark_bricks.png',
  wood: 'wood_planks.png',
  darkwood: 'dark_wood.png',
  glass: 'glass.png',
  hazard: 'hazard.png',
  lantern: 'lantern.png',
  beacon: 'beacon.png',
  antenna: 'antenna.png',
};

/** Flat colours if a texture fails to load (the tower always builds). */
const FALLBACK: Record<BlockType, number> = {
  stone: 0x9a9aa0,
  dark: 0x3a3a40,
  wood: 0xd4803a,
  darkwood: 0x4a3024,
  glass: 0xcfe8f8,
  hazard: 0xeec422,
  lantern: 0xffb03c,
  beacon: 0xff2c1e,
  antenna: 0xd2382c,
};

export function createWatchTower(
  scene: THREE.Scene,
  options: WatchTowerOptions
): WatchTowerHandle {
  const surfaceYAt = options.surfaceYAt;
  const X = options.x;
  const Z = options.z;
  const lowSpec = options.lowSpec ?? false;

  /* ---------- base level: sit on the highest terrain under the build ---------- */
  let maxY = -Infinity;
  for (let gx = -8; gx <= 8; gx++) {
    for (let gz = -8; gz <= 8; gz++) {
      const t = surfaceYAt(X + gx * 100, Z + gz * 100);
      if (t > maxY) maxY = t;
    }
  }
  const baseY = Math.ceil(maxY / 100) * 100;

  /** Terrain height in tower-local block levels at a cell (for rooting). */
  const terrainLevel = (bx: number, bz: number): number =>
    (surfaceYAt(X + (bx + 0.5) * B, Z + (bz + 0.5) * B) - baseY) / B;

  /* ------------------- voxel map (block-by-block build) ------------------- */
  interface Cell {
    bx: number;
    by: number;
    bz: number;
    t: BlockType;
    walk: boolean;
  }
  const map = new Map<string, Cell>();
  const key = (bx: number, by: number, bz: number) => `${bx},${by},${bz}`;
  const set = (bx: number, by: number, bz: number, t: BlockType, walk = false) =>
    map.set(key(bx, by, bz), { bx, by, bz, t, walk });
  const setIfAbsent = (
    bx: number,
    by: number,
    bz: number,
    t: BlockType,
    walk = false
  ) => {
    if (!map.has(key(bx, by, bz))) set(bx, by, bz, t, walk);
  };

  /** Root a column into the hillside: fill `t` downward from `by` until the
   *  block bottoms sit below the real terrain (never overwrites existing). */
  const fillDown = (bx: number, bz: number, by: number, t: BlockType) => {
    const terr = terrainLevel(bx, bz);
    for (let y = by; baseY + y * B > baseY + terr * B + 30; y--) {
      if (y < -12) break;
      setIfAbsent(bx, y, bz, t);
    }
  };

  /* ---- 4 LEGS: 2x2 stone columns, hazard-striped bases on 4x4 pads ---- */
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      // footing pad 4x4 at the base level (rooted into the terrain)
      for (let dx = 3; dx <= 6; dx++) {
        for (let dz = 3; dz <= 6; dz++) {
          const bx = sx * dx;
          const bz = sz * dz;
          set(bx, 0, bz, 'stone');
          fillDown(bx, bz, -1, 'stone');
        }
      }
      // leg column 2x2: bottom two blocks hazard-striped, stone above
      for (let dx = 5; dx <= 6; dx++) {
        for (let dz = 5; dz <= 6; dz++) {
          const bx = sx * dx;
          const bz = sz * dz;
          set(bx, 0, bz, 'hazard');
          set(bx, 1, bz, 'hazard');
          for (let y = 2; y <= 11; y++) set(bx, y, bz, 'stone');
        }
      }
    }
  }

  /* ---- dark brace BANDS + X BRACES on front / back / left faces ---- */
  // (the right face carries the open staircase — no braces there)
  const diagA: Array<[number, number[]]> = [
    [4, [-3, -2]],
    [5, [-1, 0]],
    [6, [1, 2]],
    [7, [3]],
  ];
  const diagB: Array<[number, number[]]> = [
    [4, [2, 3]],
    [5, [0, 1]],
    [6, [-2, -1]],
    [7, [-3]],
  ];
  const diagC: Array<[number, number[]]> = [
    [9, [-3, -2]],
    [10, [-1, 0, 1]],
    [11, [2, 3]],
  ];
  const diagD: Array<[number, number[]]> = [
    [9, [2, 3]],
    [10, [-1, 0, 1]],
    [11, [-3, -2]],
  ];
  for (const [y, xs] of diagA) for (const x of xs) set(x, y, 6, 'dark');
  for (const [y, xs] of diagB) for (const x of xs) set(x, y, 6, 'dark');
  for (const [y, xs] of diagC) for (const x of xs) set(x, y, -6, 'dark');
  for (const [y, xs] of diagD) for (const x of xs) set(x, y, -6, 'dark');
  for (const [y, zs] of diagA) for (const z of zs) set(-6, y, z, 'dark');
  for (const [y, zs] of diagB) for (const z of zs) set(-6, y, z, 'dark');
  for (const [y, zs] of diagC) for (const z of zs) set(-5, y, z, 'dark');
  for (const [y, zs] of diagD) for (const z of zs) set(-5, y, z, 'dark');
  // horizontal bands: y=3 and y=8, 2 deep, flush with the leg faces
  for (let x = -4; x <= 4; x++) {
    for (const z of [5, 6]) {
      set(x, 3, z, 'dark');
      set(x, 8, z, 'dark');
      set(x, 3, -z, 'dark');
      set(x, 8, -z, 'dark');
    }
  }
  for (let z = -4; z <= 4; z++) {
    for (const x of [-5, -6]) {
      set(x, 3, z, 'dark');
      set(x, 8, z, 'dark');
    }
  }

  /* ---- STAIRCASE: entry steps -> flight 1 -> landing -> walkway -> flight 2 ---- */
  // entry steps from the terrain up to the base level (auto-sized to the slope:
  // one wood step per block of height difference, rooted into the hillside)
  {
    let z = 7;
    let y = -1;
    while (z <= 12) {
      const terrWorld = baseY + terrainLevel(7, z) * B;
      const stepTop = baseY + (y + 1) * B;
      if (stepTop <= terrWorld + 40) break; // close enough to the ground
      set(7, y, z, 'wood', true);
      set(8, y, z, 'wood', true);
      fillDown(7, z, y - 1, 'wood');
      fillDown(8, z, y - 1, 'wood');
      z++;
      y--;
    }
  }
  // flight 1: 2 wide, hugging the right leg face, rising toward the back
  for (let i = 0; i <= 6; i++) {
    const z = 6 - i;
    set(7, i, z, 'wood', true);
    set(8, i, z, 'wood', true);
    fillDown(7, z, i - 1, 'wood');
    fillDown(8, z, i - 1, 'dark'); // outer stringer wall
    // outer railing: rail every step, posts on alternating steps
    set(9, i + 2, z, 'darkwood');
    if (i % 2 === 0) set(9, i + 1, z, 'darkwood');
    // inner railing where the tower face is open (legs cover z=5,6)
    if (i >= 2) {
      set(6, i + 2, z, 'darkwood');
      if (i % 2 === 0) set(6, i + 1, z, 'darkwood');
    }
  }
  // mid landing (2 deep) + corner support posts
  for (let x = 6; x <= 8; x++) {
    for (let z = -1; z >= -2; z--) set(x, 7, z, 'wood', true);
  }
  for (const x of [6, 8]) {
    for (const z of [-1, -2]) fillDown(x, z, 6, 'darkwood');
  }
  // solid posts on the landing's outer edge
  for (const z of [-1, -2]) {
    set(9, 8, z, 'darkwood');
    set(9, 9, z, 'darkwood');
    set(5, 8, z, 'darkwood'); // inner posts facing the tower
    set(5, 9, z, 'darkwood');
  }
  // spine walkway from the landing toward the back, under the floor edge
  for (let z = -3; z >= -7; z--) {
    set(7, 7, z, 'wood', true);
    if (z % 2 === -1) fillDown(7, z, 6, 'darkwood'); // stilt supports
    // inner rail blocks where the tower face is open (legs at z=-5,-6)
    if (z === -3 || z === -4 || z === -7) set(6, 8, z, 'darkwood');
    // outer rail: posts alternating with rail blocks
    if (z % 2 === -1) {
      set(8, 8, z, 'darkwood');
      set(8, 9, z, 'darkwood');
    } else {
      set(8, 9, z, 'darkwood');
    }
  }
  // flight 2: single file outside the floor edge, arriving on the platform
  for (let k = 0; k <= 4; k++) {
    const x = 7 - k;
    const y = 8 + k;
    set(x, y, -8, 'wood', true);
    fillDown(x, -8, y - 1, 'dark'); // stringer wall under the flight
    // outer railing on the far side
    set(x, y + 2, -9, 'darkwood');
    if (k % 2 === 0) set(x, y + 1, -9, 'darkwood');
  }

  /* ---- PLATFORM: 15x15 wood floor on the leg tops ---- */
  for (let x = -7; x <= 7; x++) {
    for (let z = -7; z <= 7; z++) {
      const inCabin = x >= -5 && x <= 5 && z >= -5 && z <= 5;
      const inCorner = Math.abs(x) >= 6 && Math.abs(z) >= 6;
      if (inCabin || inCorner) continue;
      set(x, 12, z, 'wood', true);
    }
  }
  // stone corner turrets (2x2, two tall) + a glowing lantern on each
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      for (let dx = 6; dx <= 7; dx++) {
        for (let dz = 6; dz <= 7; dz++) {
          set(sx * dx, 12, sz * dz, 'stone');
          set(sx * dx, 13, sz * dz, 'stone');
        }
      }
      set(sx * 7, 14, sz * 7, 'lantern');
    }
  }
  // two lanterns under the platform, lighting the stairs' arrival zone
  set(3, 11, 0, 'lantern');
  set(-3, 11, 0, 'lantern');

  /* ---- platform fencing: posts every 2 blocks + continuous top rail ---- */
  const fenceRun = (
    fixed: number,
    from: number,
    to: number,
    alongX: boolean,
    skip: (v: number) => boolean
  ) => {
    for (let v = from; v <= to; v++) {
      if (skip(v)) continue;
      if (alongX) set(v, 14, fixed, 'darkwood');
      else set(fixed, 14, v, 'darkwood');
    }
    for (let v = from; v <= to; v++) {
      if (skip(v)) continue;
      if (v % 2 !== 0) continue; // posts on alternating blocks
      if (alongX) {
        set(v, 13, fixed, 'darkwood');
        set(v, 14, fixed, 'darkwood');
      } else {
        set(fixed, 13, v, 'darkwood');
        set(fixed, 14, v, 'darkwood');
      }
    }
  };
  const never = () => false;
  fenceRun(7, -5, 5, true, never); // front edge
  fenceRun(-7, -5, 5, true, never); // left edge
  fenceRun(7, -5, 5, false, never); // right edge
  fenceRun(-7, -5, 5, false, (v) => v >= 2 && v <= 4); // back edge (stair gap)

  /* ---- CABIN: orange plank walls with a glass band on every face ---- */
  for (let y = 13; y <= 18; y++) {
    for (let v = -5; v <= 5; v++) {
      for (const [x, z] of [
        [v, 5],
        [v, -5],
        [5, v],
        [-5, v],
      ] as const) {
        if (y >= 15 && y <= 16 && Math.abs(v) <= 4) set(x, y, z, 'glass');
        else set(x, y, z, 'wood');
      }
    }
  }

  /* ---- ROOF: three stepped stone slabs ---- */
  for (let x = -7; x <= 7; x++)
    for (let z = -7; z <= 7; z++) set(x, 19, z, 'stone');
  for (let x = -6; x <= 6; x++)
    for (let z = -6; z <= 6; z++) set(x, 20, z, 'stone');
  for (let x = -4; x <= 4; x++)
    for (let z = -4; z <= 4; z++) set(x, 21, z, 'stone');

  /* ---- ANTENNA: striped pole + glowing red beacon on the roof centre ---- */
  set(0, 22, 0, 'stone');
  set(0, 23, 0, 'antenna');
  set(0, 24, 0, 'antenna');
  set(0, 25, 0, 'beacon');

  /* ---- SATELLITE DISH: dark post + tilted stepped voxel dish ---- */
  set(4, 22, -4, 'dark');
  set(4, 23, -4, 'dark');

  /* ---------------- collision volumes (exact per-block AABBs) ---------------- */
  /** Packed AABBs: minX, maxX, minZ, maxZ, y0, y1 (world units). */
  const solids: number[] = [];
  const walkables: number[] = [];
  const half = B / 2;
  for (const c of map.values()) {
    const wx = X + (c.bx + 0.5) * B;
    const wy = baseY + c.by * B;
    const wz = Z + (c.bz + 0.5) * B;
    const box = [
      wx - half,
      wx + half,
      wz - half,
      wz + half,
      wy,
      wy + B,
    ];
    const list = c.walk ? walkables : solids;
    list.push(box[0], box[1], box[2], box[3], box[4], box[5]);
  }
  const solidArr = new Float32Array(solids);
  const walkArr = new Float32Array(walkables);
  const solidCount = solidArr.length / 6;
  const walkCount = walkArr.length / 6;

  const slideOut = { x: 0, z: 0 };

  /** Circle vs AABB in XZ: pushes the circle out along the nearest face. */
  const pushCircle = (
    px: number,
    pz: number,
    r: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number
  ): boolean => {
    const nx = px < minX ? minX : px > maxX ? maxX : px;
    const nz = pz < minZ ? minZ : pz > maxZ ? maxZ : pz;
    const dx = px - nx;
    const dz = pz - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r * r) return false;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      slideOut.x = nx + (dx / d) * r;
      slideOut.z = nz + (dz / d) * r;
      return true;
    }
    // centre inside the box: eject through the shallowest face
    const l = px - minX;
    const rr = maxX - px;
    const f = pz - minZ;
    const bk = maxZ - pz;
    let m = l;
    let axis = 0;
    let sign = -1;
    if (rr < m) {
      m = rr;
      axis = 0;
      sign = 1;
    }
    if (f < m) {
      m = f;
      axis = 1;
      sign = -1;
    }
    if (bk < m) {
      m = bk;
      axis = 1;
      sign = 1;
    }
    if (axis === 0) slideOut.x = sign < 0 ? minX - r : maxX + r;
    else slideOut.z = sign < 0 ? minZ - r : maxZ + r;
    return true;
  };

  /* ----------------------------- rendering ----------------------------- */
  const meshes: THREE.InstancedMesh[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.MeshLambertMaterial[] = [];
  const texs: THREE.Texture[] = [];
  let disposed = false;

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  geos.push(boxGeo);
  const dummy = new THREE.Object3D();

  /** Decorative non-block shapes: tilted dish panels + hanging banners. */
  interface Deco {
    t: 'dish' | 'nub' | 'banner';
    m: THREE.Matrix4;
  }
  const decos: Deco[] = [];
  {
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(-1, 0, -1).normalize(),
      THREE.MathUtils.degToRad(35)
    );
    const centre = new THREE.Vector3(
      X + 4.5 * B,
      baseY + 24.9 * B,
      Z + -4.5 * B
    );
    const qM = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const centreM = new THREE.Matrix4().makeTranslation(
      centre.x,
      centre.y,
      centre.z
    );
    const ring2: Array<[number, number]> = [
      [2, 0],
      [1, 1],
      [0, 2],
      [-1, 1],
      [-2, 0],
      [-1, -1],
      [0, -2],
      [1, -1],
    ];
    const ring1: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    const addPanel = (dx: number, dy: number, dz: number, s: number) => {
      const local = new THREE.Matrix4().makeTranslation(dx * B, dy * B, dz * B);
      const scale = new THREE.Matrix4().makeScale(s, s * 0.22, s);
      decos.push({
        t: 'dish',
        m: centreM.clone().multiply(qM).multiply(local).multiply(scale),
      });
    };
    for (const [dx, dz] of ring2) addPanel(dx, 0, dz, 1);
    for (const [dx, dz] of ring1) addPanel(dx, 0.45, dz, 1);
    addPanel(0, 0.9, 0, 1);
    {
      const local = new THREE.Matrix4().makeTranslation(0, 1.35 * B, 0);
      const scale = new THREE.Matrix4().makeScale(0.45, 0.5, 0.45);
      decos.push({
        t: 'nub',
        m: centreM.clone().multiply(qM).multiply(local).multiply(scale),
      });
    }
    // hanging war banners: 3x5 thin panels just outside each floor edge
    const bannerSpots: Array<[number, number, number]> = [];
    for (const sx of [1, -1]) {
      bannerSpots.push([sx * 6.5, 9.5, 7.62]); // front face
      bannerSpots.push([sx * 6.5, 9.5, -7.62]); // back face
      bannerSpots.push([7.62, 9.5, sx * 6.5]); // right face
      bannerSpots.push([-7.62, 9.5, sx * 6.5]); // left face
    }
    for (const [bxw, byw, bzw] of bannerSpots) {
      const m = new THREE.Matrix4()
        .makeTranslation(X + bxw * B, baseY + byw * B, Z + bzw * B)
        .multiply(new THREE.Matrix4().makeScale(3, 5, 0.3));
      decos.push({ t: 'banner', m });
    }
  }

  function loadTexture(url: string): Promise<THREE.Texture | null> {
    return new Promise((resolve) => {
      new THREE.TextureLoader().load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.magFilter = THREE.NearestFilter;
          t.minFilter = THREE.NearestFilter;
          t.generateMipmaps = false;
          texs.push(t);
          resolve(t);
        },
        undefined,
        () => resolve(null)
      );
    });
  }

  function buildMeshes(
    texByName: Map<BlockType, THREE.Texture | null>
  ): void {
    // one InstancedMesh per block type
    const byType = new Map<BlockType, Cell[]>();
    for (const c of map.values()) {
      const list = byType.get(c.t);
      if (list) list.push(c);
      else byType.set(c.t, [c]);
    }
    for (const [t, cells] of byType) {
      const tex = texByName.get(t) ?? null;
      const mat = new THREE.MeshLambertMaterial({
        map: tex,
        color: tex ? 0xffffff : FALLBACK[t],
        side: t === 'glass' ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (t === 'glass') {
        mat.transparent = true;
        mat.castShadow = false;
      }
      if (t === 'lantern' || t === 'beacon') {
        // self-lit: the texture also drives full emissive, glowing at night
        mat.emissive = new THREE.Color(0xffffff);
        mat.emissiveMap = tex;
      }
      const mesh = new THREE.InstancedMesh(boxGeo, mat, cells.length);
      mesh.frustumCulled = false;
      mesh.castShadow = !lowSpec && t !== 'glass';
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        dummy.position.set(
          X + (c.bx + 0.5) * B,
          baseY + (c.by + 0.5) * B,
          Z + (c.bz + 0.5) * B
        );
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      meshes.push(mesh);
      geos.push(mesh.geometry);
      mats.push(mat);
    }
    // decorative thin panels (dish + banners)
    const dishTex = texByName.get('dish') ?? null;
    const bannerTex = texByName.get('banner') ?? null;
    const dishCells = decos.filter((d) => d.t !== 'banner');
    const bannerCells = decos.filter((d) => d.t === 'banner');
    const buildDeco = (
      list: Deco[],
      tex: THREE.Texture | null,
      fallback: number,
      doubleSide: boolean
    ) => {
      if (list.length === 0) return;
      const mat = new THREE.MeshLambertMaterial({
        map: tex,
        color: tex ? 0xffffff : fallback,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.InstancedMesh(boxGeo, mat, list.length);
      mesh.frustumCulled = false;
      mesh.castShadow = !lowSpec;
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i].m);
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      meshes.push(mesh);
      mats.push(mat);
    };
    buildDeco(dishCells, dishTex, FALLBACK.stone, false);
    buildDeco(bannerCells, bannerTex, FALLBACK.dark, true);
    loaded = true;
  }

  let loaded = false;

  // kick off texture loading, then build the meshes
  {
    const names = Object.keys(TEX_FILES) as BlockType[];
    Promise.all(
      names.map((n) =>
        loadTexture(TEX_DIR + TEX_FILES[n]).then((t) => [n, t] as const)
      )
    ).then((pairs) => {
      if (disposed) return;
      buildMeshes(new Map(pairs));
    });
  }

  /* ------------------------------ public API ------------------------------ */

  function pushOut(
    x: number,
    z: number,
    radius: number,
    feetY: number
  ): { x: number; z: number } {
    slideOut.x = x;
    slideOut.z = z;
    // solid blocks: walls, legs, railings, roof — always block the body
    for (let i = 0; i < solidCount; i++) {
      const o = i * 6;
      if (solidArr[o + 4] >= feetY + BODY) continue; // entirely above
      if (solidArr[o + 5] <= feetY + EPS) continue; // at/under the feet
      pushCircle(
        slideOut.x,
        slideOut.z,
        radius,
        solidArr[o],
        solidArr[o + 1],
        solidArr[o + 2],
        solidArr[o + 3]
      );
    }
    // walkable blocks: only push when "in the face" (higher than one step) —
    // standing on / stepping up onto them is handled by groundYAt
    for (let i = 0; i < walkCount; i++) {
      const o = i * 6;
      if (walkArr[o + 4] >= feetY + BODY) continue;
      if (walkArr[o + 5] <= feetY + STEP_UP) continue;
      pushCircle(
        slideOut.x,
        slideOut.z,
        radius,
        walkArr[o],
        walkArr[o + 1],
        walkArr[o + 2],
        walkArr[o + 3]
      );
    }
    return slideOut;
  }

  function groundYAt(
    x: number,
    z: number,
    feetY: number,
    ascending: boolean
  ): number {
    let best = -Infinity;
    const limit = ascending ? feetY : feetY + STEP_UP;
    for (let i = 0; i < walkCount; i++) {
      const o = i * 6;
      const top = walkArr[o + 5];
      if (top > limit) continue;
      if (x < walkArr[o] || x > walkArr[o + 1]) continue;
      if (z < walkArr[o + 2] || z > walkArr[o + 3]) continue;
      if (top > best) best = top;
    }
    return best;
  }

  return {
    ready: () => loaded,
    pushOut,
    groundYAt,
    debug: () =>
      meshes.map((m) => ({
        count: m.count,
        visible: m.visible,
        inScene: !!m.parent,
        y: Math.round(m.position.y),
      })),
    stats: () => ({
      blocks: map.size,
      solid: solidCount,
      walkable: walkCount,
      baseY,
    }),
    dispose: () => {
      disposed = true;
      for (const m of meshes) {
        scene.remove(m);
        m.dispose();
      }
      for (const g of geos) g.dispose();
      for (const mat of mats) mat.dispose();
      for (const t of texs) t.dispose();
      meshes.length = 0;
      geos.length = 0;
      mats.length = 0;
      texs.length = 0;
      loaded = false;
    },
  };
}
