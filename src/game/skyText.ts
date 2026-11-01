/**
 * 3D SKY ZONE SIGN for RATFIRE — when the player crosses into a climate
 * zone, its name materialises high in the sky as giant 3D BLOCK LETTERS
 * (voxel-cube extrusion of a classic 5x7 pixel font — perfectly on-theme
 * for a minecraft-style world), holds a few seconds, then fades away.
 *
 * Fully procedural: no font assets, no TextGeometry — each glyph is a
 * bitmap of cube pixels merged into ONE mesh (a name like "DESERT ZONE"
 * is ~100 cubes / ~1.2k triangles). The sign rides ahead of the camera
 * every frame (re-anchored like the sun/moon/stars), scales itself to a
 * fixed fraction of the horizontal FOV so it reads identically on any
 * aspect ratio, bobs gently, and fades in/out. MeshBasicMaterial with
 * fog:false keeps the letters bright and untouched by the haze.
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 5x7 bitmap font (3-wide I) — every letter the zone names need.
 *  '1' = cube pixel. Kept hand-written so the shapes stay chunky. */
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  I: ['111', '010', '010', '010', '010', '010', '111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
};

const ROWS = 7;

/** Total glyph-advance columns for a text (letters + 1-col tracking). */
function textCols(text: string): number {
  let cols = 0;
  for (const ch of text) {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    cols += g[0].length + 1;
  }
  return Math.max(1, cols - 1);
}

/** Builds the whole name as ONE merged cube-pixel geometry (x to the
 *  right, y up, z depth) centred on the origin; pixel = 1 unit. */
function buildTextGeometry(text: string): THREE.BufferGeometry {
  const boxes: THREE.BufferGeometry[] = [];
  const box = new THREE.BoxGeometry(1, 1, 1);
  const m = new THREE.Matrix4();
  let cursor = 0;
  for (const ch of text) {
    const g = GLYPHS[ch] ?? GLYPHS[' '];
    for (let r = 0; r < ROWS; r++) {
      const row = g[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== '1') continue;
        m.makeTranslation(cursor + c + 0.5, ROWS - r - 0.5, 0);
        boxes.push(box.clone().applyMatrix4(m));
      }
    }
    cursor += g[0].length + 1;
  }
  box.dispose();
  const merged =
    BufferGeometryUtils.mergeGeometries(boxes) ?? new THREE.BoxGeometry(1, 1, 1);
  for (const b of boxes) b.dispose();
  merged.center(); // scale/position pivot at the middle of the sign
  return merged;
}

export interface SkyTextHandle {
  /** Raise a new sign: text + colour (previous sign is replaced). */
  show(text: string, color: number): void;
  /** Per-frame: fade state machine + ride ahead of the camera. */
  update(dt: number, camera: THREE.PerspectiveCamera): void;
  /** True while a sign is on screen (in / hold / fading out). */
  isBusy(): boolean;
  dispose(): void;
}

export function createSkyText(scene: THREE.Scene): SkyTextHandle {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    fog: false, // the sign reads bright and clear above the haze
    depthWrite: false,
    depthTest: false, // draws over the world: the game camera pitches
    // steeply down at the player, so a world-anchored sky sign would sit
    // above the frame — riding the VIEW AXIS instead and skipping the
    // depth test keeps the announcement perfectly framed at all times
  });
  let mesh: THREE.Mesh | null = null;
  let cols = 1;
  let phase: 'idle' | 'in' | 'hold' | 'out' = 'idle';
  let timer = 0;
  let clock = 0; // for the gentle bob

  // choreography (seconds) + placement
  const FADE_IN = 0.55;
  const HOLD = 4.4;
  const FADE_OUT = 1.2;
  const DIST = 1800; // along the camera's view axis (world units)
  const LIFT_DEG = 10; // nudged above the view centre — upper frame
  const BOB = 12; // idle float amplitude (screen-space-consistent)
  const WIDTH_FRAC = 0.52; // sign width as fraction of the horizontal FOV

  const dirV = new THREE.Vector3();
  const rightV = new THREE.Vector3();
  const signDir = new THREE.Vector3();
  const UP_V = new THREE.Vector3(0, 1, 0);
  const liftQ = new THREE.Quaternion();

  function show(text: string, color: number): void {
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    const upper = text.toUpperCase();
    const geometry = buildTextGeometry(upper);
    cols = textCols(upper);
    material.color.setHex(color);
    material.opacity = 0;
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; // always relevant while shown
    mesh.renderOrder = 999; // on top of the world (depthTest is off)
    scene.add(mesh);
    phase = 'in';
    timer = 0;
  }

  function update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (phase === 'idle' || !mesh) return;
    clock += dt;
    timer += dt;

    if (phase === 'in') {
      material.opacity = Math.min(1, timer / FADE_IN);
      if (timer >= FADE_IN) {
        phase = 'hold';
        timer = 0;
      }
    } else if (phase === 'hold') {
      material.opacity = 1;
      if (timer >= HOLD) {
        phase = 'out';
        timer = 0;
      }
    } else {
      material.opacity = Math.max(0, 1 - timer / FADE_OUT);
      if (timer >= FADE_OUT) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh = null;
        phase = 'idle';
        return;
      }
    }

    // ride the camera's VIEW AXIS (pitch included), lifted ~10° so the
    // sign floats in the upper frame no matter how the camera pitches
    camera.getWorldDirection(dirV);
    rightV.crossVectors(dirV, UP_V);
    if (rightV.lengthSq() < 1e-8) rightV.set(1, 0, 0); // looking straight up/down
    rightV.normalize();
    liftQ.setFromAxisAngle(rightV, (LIFT_DEG * Math.PI) / 180);
    signDir.copy(dirV).applyQuaternion(liftQ).normalize();
    mesh.position.copy(camera.position).addScaledVector(signDir, DIST);
    mesh.position.y += Math.sin(clock * 1.2) * BOB;
    mesh.lookAt(camera.position);

    // scale to a fixed fraction of the horizontal FOV at that distance
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * camera.aspect;
    const worldWidth = DIST * 2 * tanH * WIDTH_FRAC;
    mesh.scale.setScalar(worldWidth / cols);
  }

  function isBusy(): boolean {
    return phase !== 'idle';
  }

  function dispose(): void {
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    material.dispose();
    phase = 'idle';
  }

  return { show, update, isBusy, dispose };
}
