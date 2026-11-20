import {
  CEILING_RGB,
  FLOOR_RGB,
  FOV_DEG,
  RENDER_H,
  RENDER_W,
  SCENE_BEAM_RGB,
  SCENE_DEEP_RGB,
  VIEW_DISTANCE,
  WALL_EDGE_RGB,
} from './config.ts';
import type { Game } from './game.ts';

// 程序化自制贴图（无外部图片，见 ASSETS.md）：
// 地面 = 世界锚定的大半格不规则石板（磨损缝、缺角、明暗差），
// 拱顶 = 世界锚定的穹顶石板 + 每两格一道横向石梁（弱暗金梁缘）。
// 逐像素写入 ImageData，颜色全部查预烘焙 LUT（材质级 × 雾级），控制每帧成本。
// 图案只依赖世界坐标与固定网格，不含迷宫布局信息；视距外一律深暖底色，不泄露迷雾。

const W = RENDER_W;
const H = RENDER_H;
const HORIZON = H / 2;
const FOG_LEVELS = 32;

const image = new ImageData(W, H);
const buf = new Uint32Array(image.data.buffer);
const rowT = new Float64Array(H);
const rowFog = new Uint8Array(H);
const rayX = new Float64Array(W);
const rayY = new Float64Array(W);

// 地面材质级：0..7 石板明暗，8 磨损缝，9 缺角
const FLOOR_FACTORS = [0.88, 0.915, 0.95, 0.985, 1.02, 1.055, 1.09, 1.125, 0.66, 0.5];
// 拱顶材质级：0..3 穹顶石板，4 石梁，5 梁缘弱暗金
const CEIL_FACTORS = [0.82, 0.91, 1.0, 1.09];
const floorLUT = new Uint32Array(FLOOR_FACTORS.length * FOG_LEVELS);
const ceilLUT = new Uint32Array(6 * FOG_LEVELS);

function pack(r: number, g: number, b: number): number {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function fogMix(rgb: readonly [number, number, number], factor: number, f: number): number {
  const r = Math.round(SCENE_DEEP_RGB[0] + (rgb[0] * factor - SCENE_DEEP_RGB[0]) * f);
  const g = Math.round(SCENE_DEEP_RGB[1] + (rgb[1] * factor - SCENE_DEEP_RGB[1]) * f);
  const b = Math.round(SCENE_DEEP_RGB[2] + (rgb[2] * factor - SCENE_DEEP_RGB[2]) * f);
  return pack(Math.min(255, r), Math.min(255, g), Math.min(255, b));
}

const deepPack = pack(SCENE_DEEP_RGB[0], SCENE_DEEP_RGB[1], SCENE_DEEP_RGB[2]);

for (let lvl = 0; lvl < FOG_LEVELS; lvl++) {
  const f = lvl / (FOG_LEVELS - 1);
  for (let m = 0; m < FLOOR_FACTORS.length; m++) floorLUT[m * FOG_LEVELS + lvl] = fogMix(FLOOR_RGB, FLOOR_FACTORS[m], f);
  for (let m = 0; m < 4; m++) ceilLUT[m * FOG_LEVELS + lvl] = fogMix(CEILING_RGB, CEIL_FACTORS[m], f);
  ceilLUT[4 * FOG_LEVELS + lvl] = fogMix(SCENE_BEAM_RGB, 1, f);
  ceilLUT[5 * FOG_LEVELS + lvl] = fogMix(WALL_EDGE_RGB, 0.32, f);
}

export function cellHash(cx: number, cy: number): number {
  let n = Math.imul(cx, 0x27d4eb2d) ^ Math.imul(cy, 0x165667b1);
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n ^= n >>> 12;
  return n >>> 0;
}

export function renderBase(ctx: CanvasRenderingContext2D, game: Game): void {
  const dirX = Math.cos(game.angle);
  const dirY = Math.sin(game.angle);
  const tanHalf = Math.tan(((FOV_DEG * Math.PI) / 180) / 2);
  const planeX = -dirY * tanHalf;
  const planeY = dirX * tanHalf;

  for (let x = 0; x < W; x++) {
    const cameraX = (2 * x) / W - 1;
    let rx = dirX + planeX * cameraX;
    let ry = dirY + planeY * cameraX;
    const len = Math.hypot(rx, ry);
    rayX[x] = rx / len;
    rayY[x] = ry / len;
  }

  for (let y = 0; y < H; y++) {
    const t = y === HORIZON ? Infinity : y < HORIZON ? HORIZON / (HORIZON - y) : HORIZON / (y - HORIZON);
    rowT[y] = t;
    const f = t >= VIEW_DISTANCE ? 0 : Math.pow(1 - t / VIEW_DISTANCE, 1.4);
    rowFog[y] = Math.min(FOG_LEVELS - 1, (f * (FOG_LEVELS - 1)) | 0);
  }

  const ox = game.x;
  const oy = game.y;
  for (let y = 0; y < H; y++) {
    const rowOff = y * W;
    const t = rowT[y];
    if (t > VIEW_DISTANCE) {
      buf.fill(deepPack, rowOff, rowOff + W);
      continue;
    }
    const fog = rowFog[y];
    if (y > HORIZON) {
      for (let x = 0; x < W; x++) {
        const sy = (oy + rayY[x] * t) * 2;
        const cy = Math.floor(sy);
        // 错缝铺法：奇数行石板横向偏移半块，避免整齐网格感
        const sx = (ox + rayX[x] * t) * 2 + (cy & 1 ? 0.5 : 0);
        const cx = Math.floor(sx);
        const fx = sx - cx;
        const fy = sy - cy;
        const h = cellHash(cx, cy);
        let lvl = h & 7;
        const edgeW = 0.05 + ((h >>> 3) & 3) * 0.018;
        if (fx < edgeW || fy < edgeW) lvl = 8;
        else if ((h & 63) === 0 && fx > 0.58 && fy > 0.58) lvl = 9;
        buf[rowOff + x] = floorLUT[lvl * FOG_LEVELS + fog];
      }
    } else {
      for (let x = 0; x < W; x++) {
        const wx = ox + rayX[x] * t;
        const wy = oy + rayY[x] * t;
        const h = cellHash(Math.floor(wx), Math.floor(wy));
        let lvl = h & 3;
        // 双向石梁：横向每两格一道、纵向每四格一道，构成藻井式梁格
        const bmY = wy - Math.floor(wy / 2) * 2;
        const bmX = wx - Math.floor(wx / 4) * 4;
        if (bmY < 0.24 || bmX < 0.2) lvl = 4;
        else if (bmY < 0.32 || bmX < 0.28) lvl = 5;
        buf[rowOff + x] = ceilLUT[lvl * FOG_LEVELS + fog];
      }
    }
  }

  ctx.putImageData(image, 0, 0);
}