/**
 * After-rain ground water for the RATFIRE terrain — puddles left behind
 * once the daily shower ends, drying out slowly until the next storm.
 *
 * The puddle field is INFINITE-WORLD aware: instead of one fixed whole-map
 * scan, the plane is cut into square REGIONS (in height-grid cells). As the
 * player explores, each region entered for the first time is scanned for
 * FLAT cells (blocks whose four neighbours share the height = plateau tops,
 * exactly where water pools) and a handful of spaced puddle sites are
 * sampled from them with a region-seeded PRNG — so a region always grows
 * the same puddles, even after its sites were pruned and you return later.
 * Regions that fall far behind the player are dropped, exactly like the
 * terrain chunks.
 *
 *  - SHAPE: each puddle is the UNION of 2-3 overlapping discs (one dominant
 *    lobe + satellites offset toward random directions) — real puddles are
 *    lobed and elongated, never round. The outline is the exact union
 *    boundary (max ray/disc hit over 48 angles), softened by two smoothing
 *    passes plus a gentle random-phase sinusoid wobble, so shorelines are
 *    organic curves instead of polygons. Because every disc contains the
 *    site centre, the union is star-shaped around it and a single fan
 *    triangulates it with zero overlap. Radius stays under one block, so
 *    the water sits inside the guaranteed-flat cross of cells.
 *  - RENDER: all live puddles are merged into ONE mesh = one draw call,
 *    rebuilt (cheaply) whenever the live site set changes. The shader does
 *    the realism:
 *      · FEATHERED shoreline — alpha fades to 0 over the outer ~20% of the
 *        radius (no crisp sticker rim) and the waterline is wobbled by the
 *        ripple field so the edge subtly shifts.
 *      · DEPTH gradient — dark tinted centre, thinner and clearer at the
 *        edges where water is shallow.
 *      · FRESNEL — looking down shows dark water, grazing angles mirror
 *        the live sky colour like a real surface.
 *      · RIPPLES — two scrolling value-noise fields perturb the surface
 *        normal; the sun glint shimmers across it, much harder while it
 *        rains (uRainAmt) and glassy-calm after.
 *  - LIFECYCLE: a single "wetness" value integrates over time — while it
 *    pours, puddles GROW slowly out of the ground (full size after ~13 real
 *    seconds of rain, paced by the storm's intensity); once it stops they
 *    decay to zero over ~11 real seconds (~1.6 in-game hours). Per-puddle
 *    random seeds stagger both the growing and the drying: the shader scales
 *    each blob from its centre and fades it as its own wetness rises/drops,
 *    so puddles pop up one by one through the shower and dry one by one
 *    after it.
 *  - `update` receives the scene's directional sun light + the frame's sky
 *    colour (page.tsx re-syncs fog colour to the sky every frame) and the
 *    player position that drives region discovery / pruning.
 */

import * as THREE from 'three';

/* ---------------- tuning ---------------- */
const REGION_CELLS = 28; // height-grid cells per puddle region
const MAX_SITES_PER_REGION = 7; // puddles sampled per discovered region
const MIN_CELL_SPACING = 2; // Chebyshev grid distance between puddles
const KEEP_REGIONS = 2; // Chebyshev region distance kept around the player
const BLOB_SEGMENTS = 48; // outline resolution of each puddle
const BASE_RADIUS_MIN = 18; // world units (skewed small — few big, many little)
const BASE_RADIUS_MAX = 66;
const RADIUS_SKEW = 1.5; // >1 biases sizes toward the small end
const BIG_FLAT_BONUS = 1.35; // bigger puddles on large plateaus (8 flat nbrs)
const LOBES_MAX = 3; // 1 dominant lobe + up to 2 satellite lobes
const SHORE_FEATHER = 0.2; // shoreline fade width, fraction of radius
const LIFT = 1.5; // hover above the block top to avoid z-fighting
const BASE_OPACITY = 0.78; // centre opacity; edges fade out via feather+depth
const FILL_SECONDS = 13; // real seconds of full rain from bone dry to soaked
const DRY_SECONDS = 11; // real seconds from soaked to fully dry (~1.6 game h)
const WATER_COLOR = new THREE.Color(0x2e4654); // deep water tint base

const WATER_VERTEX = /* glsl */ `
  attribute vec3 aPuddle; // x: center world x, y: center world z, z: seed 0..0.5
  attribute float aRad;   // 0 at the puddle centre .. 1 at the shoreline
  uniform float uWet;
  varying float vWet;
  varying float vRad;
  varying float vSeed;
  varying vec3 vWorldPos;
  #include <fog_pars_vertex>
  void main() {
    // per-puddle staggered grow/dry: 0 = dry, 1 = full
    float f = smoothstep(aPuddle.z, aPuddle.z + 0.5, uWet);
    vWet = f;
    vSeed = aPuddle.z;
    vRad = aRad;
    // scale the blob from its centre as it fills up / dries out
    vec2 xz = mix(aPuddle.xy, position.xz, f);
    vec3 p = vec3(xz.x, position.y, xz.y);
    vWorldPos = p;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  uniform vec3 uWaterColor;
  uniform vec3 uSkyColor;
  uniform vec3 uSunDir;
  uniform float uSunI;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uRainAmt; // 0 calm .. 1 pouring
  varying float vWet;
  varying float vRad;
  varying float vSeed;
  varying vec3 vWorldPos;
  #include <fog_pars_fragment>

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    vec2 p = vWorldPos.xz;
    float t = uTime + vSeed * 40.0; // desynchronise the puddles

    // two scrolling ripple fields -> perturbed surface normal
    float n1 = vnoise(p * 0.085 + vec2(t * 0.55, t * 0.35));
    float n2 = vnoise(p * 0.21 + vec2(-t * 0.42, t * 0.61) + 19.7);
    float ripX = n1 - 0.5;
    float ripZ = n2 - 0.5;
    float amp = mix(0.05, 0.34, uRainAmt); // glassy when calm, choppy in rain
    vec3 n = normalize(vec3(ripX * amp, 1.0, ripZ * amp));

    // fresnel: straight down -> dark water, grazing angle -> sky mirror
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0), 3.0);
    float skyMix = mix(0.15, 0.95, fres);

    // sun glint + broad wet sheen off the rippled normal
    vec3 refl = reflect(-uSunDir, n);
    float rv = max(dot(refl, viewDir), 0.0);
    float glint = pow(rv, 64.0) * uSunI;
    float sheen = pow(rv, 7.0) * uSunI * 0.10;

    // depth shading: deep dark centre, thin clearer edges
    float depth = pow(1.0 - vRad, 1.5);
    vec3 shallowCol = mix(uWaterColor, uSkyColor, 0.30);
    vec3 deepCol = uWaterColor * 0.85;
    vec3 col = mix(shallowCol, deepCol, depth);
    col = mix(col, uSkyColor, skyMix);
    col += (glint * 0.9 + sheen) * vec3(1.0, 0.95, 0.85) * (1.0 - vRad * 0.6);

    // raindrop impact sparkle while it pours (fast fine noise, sparse)
    float impact = vnoise(p * 0.9 + vec2(t * 6.0, -t * 4.0));
    col += vec3(0.5, 0.55, 0.6) * pow(impact, 6.0) * uRainAmt
         * (1.0 - vRad * 0.5) * 0.35;

    // feathered shoreline, wobbled by the ripple field
    float edge = vRad + ripX * 0.06;
    float shore = 1.0 - smoothstep(1.0 - ${SHORE_FEATHER.toFixed(2)}, 1.0, edge);
    float a = uOpacity * vWet * shore * mix(0.62, 1.0, depth);
    gl_FragColor = vec4(col, a);
    #include <fog_fragment>
  }
`;

export interface GroundWaterHandle {
  /** The merged puddle mesh — add it to the scene. */
  readonly object: THREE.Mesh;
  /** Advance fill/dry + discover/prune regions around the player.
   *  skyColor + sunLight drive the water's look. */
  update(
    dt: number,
    rainIntensity: number,
    skyColor: THREE.Color,
    sunLight: THREE.DirectionalLight,
    focusX: number,
    focusZ: number
  ): void;
  /** Live puddle count + current wetness for debug handles. */
  readonly stats: { sites: number };
  wet(): number;
  /** Nearest puddle site to a world xz point (debug helper). */
  nearest(x: number, z: number): { x: number; y: number; z: number } | null;
  dispose(): void;
}

export interface WaterGrid {
  /** World units per block edge. */
  block: number;
  /** Grid origin offset — world x = (gx - gridOffset) * block. */
  gridOffset: number;
  /** Deterministic integer block height at grid coordinates (unbounded). */
  heightAt(gx: number, gz: number): number;
}

interface Lobe {
  dx: number;
  dz: number;
  r: number;
}

interface Site {
  x: number;
  y: number;
  z: number;
  r: number;
  seed: number;
  /** Deterministic PRNG stream position — replays the blob shape exactly. */
  rngState: number;
}

/** Small deterministic PRNG (mulberry32) so regions replay identically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable integer hash of two region coordinates. */
function hashRegion(rx: number, rz: number): number {
  let h = (rx * 374761393 + rz * 668265263) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Creates the infinite-world puddle system (starts dry). */
export function createGroundWater(
  scene: THREE.Scene,
  grid: WaterGrid
): GroundWaterHandle {
  // ---------------- merged puddle geometry (one draw call) ----------------
  // Rebuilt whenever the live site set changes. Each puddle = union of 2-3
  // overlapping discs (see header); shapes are replayed from the site's
  // stored PRNG state so rebuilds are pixel-identical.
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uWet: { value: 0 },
        uWaterColor: { value: new THREE.Color(WATER_COLOR) },
        uSkyColor: { value: new THREE.Color(0xbfd1e5) },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
        uSunI: { value: 0 },
        uOpacity: { value: BASE_OPACITY },
        uTime: { value: 0 },
        uRainAmt: { value: 0 },
      },
    ]),
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true, // distant puddles fade into the aerial haze
  });

  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // vertices shrink/move in the shader
  mesh.renderOrder = 3; // above terrain, below the rain streaks
  mesh.visible = false; // starts dry
  scene.add(mesh);

  // ---------------- region-based site discovery ----------------
  const liveRegions = new Map<string, Site[]>(); // "rx,rz" -> sites
  const stats = { sites: 0 };

  function regionKey(rx: number, rz: number): string {
    return rx + ',' + rz;
  }

  /** Emits one puddle blob's fan triangles from its (replayable) PRNG. */
  function emitBlob(
    s: Site,
    rng: () => number,
    positions: Float32Array,
    puddleAttr: Float32Array,
    radAttr: Float32Array,
    viRef: { v: number },
    riRef: { v: number }
  ): void {
    // --- lobes: dominant disc + satellites kept inside its radius ---
    const lobes: Lobe[] = [{ dx: 0, dz: 0, r: s.r }];
    const nLobes = 2 + ((rng() * (LOBES_MAX - 1)) | 0); // 2..LOBES_MAX
    for (let l = 1; l < nLobes; l++) {
      const rl = s.r * (0.45 + rng() * 0.3);
      // keep the site centre inside the satellite (|offset| + rl <= r)
      const d = (s.r - rl) * (0.35 + rng() * 0.5);
      const a = rng() * Math.PI * 2;
      lobes.push({ dx: Math.cos(a) * d, dz: Math.sin(a) * d, r: rl });
    }

    // --- outline: max ray/disc hit over all lobes for each angle ---
    const ring: number[] = [];
    for (let k = 0; k < BLOB_SEGMENTS; k++) {
      const a = (k / BLOB_SEGMENTS) * Math.PI * 2;
      const ct = Math.cos(a);
      const st = Math.sin(a);
      let hit = 0;
      for (const l of lobes) {
        const proj = l.dx * ct + l.dz * st;
        const perp2 = l.dx * l.dx + l.dz * l.dz - proj * proj;
        const th = proj + Math.sqrt(Math.max(l.r * l.r - perp2, 0));
        if (th > hit) hit = th;
      }
      ring.push(hit);
    }
    // two smoothing passes soften the corners where the max switches lobes
    for (let pass = 0; pass < 2; pass++) {
      const prev = ring.slice();
      for (let k = 0; k < BLOB_SEGMENTS; k++) {
        ring[k] =
          prev[(k + BLOB_SEGMENTS - 1) % BLOB_SEGMENTS] * 0.25 +
          prev[k] * 0.5 +
          prev[(k + 1) % BLOB_SEGMENTS] * 0.25;
      }
    }
    // gentle organic wobble: smooth sinusoids with random phases (no spikes)
    const ph1 = rng() * Math.PI * 2;
    const ph2 = rng() * Math.PI * 2;
    const ph3 = rng() * Math.PI * 2;
    for (let k = 0; k < BLOB_SEGMENTS; k++) {
      const a = (k / BLOB_SEGMENTS) * Math.PI * 2;
      const w =
        1 +
        0.05 * Math.sin(3 * a + ph1) +
        0.035 * Math.sin(7 * a + ph2) +
        0.022 * Math.sin(11 * a + ph3);
      ring[k] *= w;
    }

    // --- emit the fan: centre vertex (aRad 0) + outline ring (aRad 1) ---
    for (let k = 0; k < BLOB_SEGMENTS; k++) {
      const k2 = (k + 1) % BLOB_SEGMENTS;
      const rk = ring[k];
      const rk2 = ring[k2];
      const ak = (k / BLOB_SEGMENTS) * Math.PI * 2;
      const ak2 = (k2 / BLOB_SEGMENTS) * Math.PI * 2;
      const tri = [
        s.x, s.y, s.z,
        s.x + Math.cos(ak) * rk, s.y, s.z + Math.sin(ak) * rk,
        s.x + Math.cos(ak2) * rk2, s.y, s.z + Math.sin(ak2) * rk2,
      ];
      const rad = [0, 1, 1];
      for (let v = 0; v < 3; v++) {
        positions[viRef.v] = tri[v * 3 + 0];
        positions[viRef.v + 1] = tri[v * 3 + 1];
        positions[viRef.v + 2] = tri[v * 3 + 2];
        puddleAttr[viRef.v] = s.x;
        puddleAttr[viRef.v + 1] = s.z;
        puddleAttr[viRef.v + 2] = s.seed;
        radAttr[riRef.v] = rad[v];
        viRef.v += 3;
        riRef.v += 1;
      }
    }
  }

  /** Rebuilds the merged mesh over every currently-live puddle site. */
  function rebuildGeometry(): void {
    const sites: Site[] = [];
    for (const regionSites of liveRegions.values()) {
      for (const s of regionSites) sites.push(s);
    }
    stats.sites = sites.length;

    geometry.dispose();
    const fresh = new THREE.BufferGeometry();

    if (sites.length === 0) {
      mesh.geometry = fresh;
      mesh.visible = false;
      return;
    }

    const trisPerBlob = BLOB_SEGMENTS;
    const positions = new Float32Array(sites.length * trisPerBlob * 3 * 3);
    const puddleAttr = new Float32Array(sites.length * trisPerBlob * 3 * 3);
    const radAttr = new Float32Array(sites.length * trisPerBlob * 3);

    const viRef = { v: 0 };
    const riRef = { v: 0 };
    for (const s of sites) {
      emitBlob(s, mulberry32(s.rngState), positions, puddleAttr, radAttr, viRef, riRef);
    }

    fresh.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    fresh.setAttribute('aPuddle', new THREE.BufferAttribute(puddleAttr, 3));
    fresh.setAttribute('aRad', new THREE.BufferAttribute(radAttr, 1));
    mesh.geometry = fresh;
  }

  /**
   * Scans one region's cells for flat plateau cells and samples up to
   * MAX_SITES_PER_REGION spaced puddle sites from them. The region-seeded
   * PRNG makes the result identical on every (re)discovery.
   */
  function discoverRegion(rx: number, rz: number): void {
    const key = regionKey(rx, rz);
    if (liveRegions.has(key)) return;

    const rng = mulberry32(hashRegion(rx, rz));
    const baseX = rx * REGION_CELLS;
    const baseZ = rz * REGION_CELLS;

    // --- find flat cells (plateau tops) inside the region ---
    const flatCells: number[] = []; // packed gz * 4096 + gx (coords can skew)
    for (let lz = 0; lz < REGION_CELLS; lz++) {
      for (let lx = 0; lx < REGION_CELLS; lx++) {
        const gx = baseX + lx;
        const gz = baseZ + lz;
        const h = grid.heightAt(gx, gz);
        if (
          grid.heightAt(gx + 1, gz) === h &&
          grid.heightAt(gx - 1, gz) === h &&
          grid.heightAt(gx, gz + 1) === h &&
          grid.heightAt(gx, gz - 1) === h
        ) {
          flatCells.push(gz * 65536 + gx);
        }
      }
    }

    // --- Fisher-Yates (region-seeded) over the flat cells ---
    for (let i = flatCells.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = flatCells[i];
      flatCells[i] = flatCells[j];
      flatCells[j] = t;
    }

    // --- keep sites >= MIN_CELL_SPACING cells apart, up to the cap ---
    const sites: Site[] = [];
    const takenX: number[] = [];
    const takenZ: number[] = [];
    for (const cell of flatCells) {
      if (sites.length >= MAX_SITES_PER_REGION) break;
      const gx = cell % 65536;
      const gz = (cell / 65536) | 0;
      let crowded = false;
      for (let t = 0; t < takenX.length; t++) {
        if (
          Math.abs(takenX[t] - gx) <= MIN_CELL_SPACING &&
          Math.abs(takenZ[t] - gz) <= MIN_CELL_SPACING
        ) {
          crowded = true;
          break;
        }
      }
      if (crowded) continue;
      takenX.push(gx);
      takenZ.push(gz);

      // world-space centre of the cell's top face
      const wx = (gx - grid.gridOffset) * grid.block;
      const wz = (gz - grid.gridOffset) * grid.block;
      const wy = grid.heightAt(gx, gz) * grid.block + grid.block / 2 + LIFT;

      // all 8 neighbours flat => big plateau => bigger puddle
      let flatNbrs = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          if (
            grid.heightAt(gx + dx, gz + dz) === grid.heightAt(gx, gz)
          ) {
            flatNbrs++;
          }
        }
      }
      // skewed distribution: many small puddles, a few large ones
      let r =
        BASE_RADIUS_MIN +
        (BASE_RADIUS_MAX - BASE_RADIUS_MIN) * Math.pow(rng(), RADIUS_SKEW);
      if (flatNbrs === 8) r *= BIG_FLAT_BONUS;

      sites.push({
        x: wx,
        y: wy,
        z: wz,
        r,
        seed: rng() * 0.5,
        // snapshot the PRNG so blob shapes replay exactly on rebuilds
        rngState: (rng() * 0xffffffff) >>> 0,
      });
    }

    liveRegions.set(key, sites);
  }

  // ---------------- wetness integration ----------------
  let wet = 0; // 0 dry .. 1 soaked
  let time = 0; // ripple clock
  let lastRegionX = NaN;
  let lastRegionZ = NaN;

  function update(
    dt: number,
    rainIntensity: number,
    skyColor: THREE.Color,
    sunLight: THREE.DirectionalLight,
    focusX: number,
    focusZ: number
  ) {
    time += dt;

    // --- region discovery / pruning around the player ---
    const cgx = Math.round(focusX / grid.block) + grid.gridOffset;
    const cgz = Math.round(focusZ / grid.block) + grid.gridOffset;
    const prx = Math.floor(cgx / REGION_CELLS);
    const prz = Math.floor(cgz / REGION_CELLS);

    if (prx !== lastRegionX || prz !== lastRegionZ) {
      lastRegionX = prx;
      lastRegionZ = prz;

      let changed = false;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = regionKey(prx + dx, prz + dz);
          if (!liveRegions.has(key)) {
            discoverRegion(prx + dx, prz + dz);
            changed = true;
          }
        }
      }
      // drop regions that fell far behind the player
      for (const [key, sites] of liveRegions) {
        const sep = key.indexOf(',');
        const krx = Number(key.slice(0, sep));
        const krz = Number(key.slice(sep + 1));
        if (
          Math.max(Math.abs(krx - prx), Math.abs(krz - prz)) > KEEP_REGIONS &&
          sites.length >= 0
        ) {
          liveRegions.delete(key);
          changed = true;
        }
      }
      if (changed) rebuildGeometry();
    }

    // --- puddles GROW slowly while it pours (size eases up over the storm,
    // paced by its intensity; per-puddle seeds stagger them), and dry
    // slowly once the shower has passed ---
    if (rainIntensity > 0) {
      wet = Math.min(
        1,
        wet + (dt / FILL_SECONDS) * (0.35 + 0.65 * rainIntensity)
      );
    } else if (wet > 0) {
      wet = Math.max(0, wet - (dt / DRY_SECONDS));
    }

    const active = wet > 0.001 && stats.sites > 0;
    mesh.visible = active;
    if (!active) return;

    const u = material.uniforms;
    u.uWet.value = wet;
    u.uTime.value = time;
    u.uRainAmt.value = rainIntensity;
    (u.uSkyColor.value as THREE.Color).copy(skyColor);
    const sun = sunLight.position.clone().normalize();
    (u.uSunDir.value as THREE.Vector3).copy(sun);
    u.uSunI.value = Math.min(1, sunLight.intensity / 12);
  }

  function dispose() {
    mesh.removeFromParent();
    geometry.dispose();
    material.dispose();
    liveRegions.clear();
  }

  return {
    object: mesh,
    update,
    stats,
    wet: () => wet,
    nearest(x: number, z: number) {
      let best: Site | null = null;
      let bestD = Infinity;
      for (const regionSites of liveRegions.values()) {
        for (const s of regionSites) {
          const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
      }
      return best ? { x: best.x, y: best.y, z: best.z } : null;
    },
    dispose,
  };
}
