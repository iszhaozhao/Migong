import {
  BRICK_COLS,
  BRICK_ROWS,
  COLORS,
  DOOR_FRAME_RGB,
  DOOR_HANDLE_RGB,
  DOOR_LIGHT_RGB,
  DOOR_PANEL_DARK,
  DOOR_PANEL_RGB,
  DOOR_SEAM_RGB,
  DOOR_TEX_U,
  DOOR_TEX_V,
  FOV_DEG,
  FLOOR_GAIN,
  FLOOR_RGB,
  LIGHT_DIST_POWER,
  LIGHT_EDGE_GAIN,
  LIGHT_EDGE_POWER,
  VIGNETTE_ALPHA,
  VIEW_DISTANCE,
  WALL_RGB,
  WALL_SIDE_SHADE,
  WARN_RGB,
} from './config.ts';
import { beamPolygonCapacity, fillBeamPolygon, OBS_WALL, type Exploration } from './exploration.ts';
import { fxHasCell, NO_FX, type SceneFx } from './fx.ts';
import type { Game } from './game.ts';
import { type Maze } from './maze.ts';
import { castRay } from './raycast.ts';

export type ViewSize = { w: number; h: number };

type Rgb = readonly [number, number, number];

function shade(rgb: Rgb, b: number): string {
  const r = Math.min(255, Math.round(rgb[0] * b));
  const g = Math.min(255, Math.round(rgb[1] * b));
  const bl = Math.min(255, Math.round(rgb[2] * b));
  return `rgb(${r},${g},${bl})`;
}

// 手电筒：距离衰减（远处没入纯黑）
function fogFactor(dist: number): number {
  const t = 1 - dist / VIEW_DISTANCE;
  if (t <= 0) return 0;
  return Math.pow(t, LIGHT_DIST_POWER);
}

// 手电筒：视野中央亮、边缘暗（逐列，作用于墙面本身，不是屏幕叠加层）
function coneGain(absCameraX: number): number {
  return 1 - (1 - LIGHT_EDGE_GAIN) * Math.pow(absCameraX, LIGHT_EDGE_POWER);
}

// 稳定的逐像素噪声：动态墙「生长/消散」动画用它做像素级溶解，帧间不闪烁
function dissolveNoise(col: number, row: number, y: number): number {
  const s = Math.sin(col * 127.1 + row * 311.7 + y * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ==================== 大门纹理 ====================

// u 为门面横向 0..1，v 为纵向 0（上）..1（下）；返回 null 表示这一像素是门洞亮光
function doorSurface(
  u: number,
  v: number,
  openT: number,
): { rgb: Rgb; emissive: number } | null {
  const gap = 0.42 * easeOut(openT);
  const fromSeam = Math.abs(u - 0.5);
  if (openT > 0 && fromSeam < gap) return null;

  // 门框与门槛
  if (u < 0.085 || u > 0.915) return { rgb: DOOR_FRAME_RGB, emissive: 0 };
  if (v < 0.055) return { rgb: DOOR_FRAME_RGB, emissive: 0 };
  if (v > 0.955) {
    // 门底漏光：关着也能看到一线暖光
    return { rgb: DOOR_SEAM_RGB, emissive: openT > 0 ? 0.9 : 0.34 };
  }

  // 关闭状态的中缝亮光
  if (openT === 0 && fromSeam < 0.014) return { rgb: DOOR_SEAM_RGB, emissive: 0.42 };

  const leafLeft = u < 0.5;
  const leafStart = leafLeft ? 0.085 : 0.5;
  const leafWidth = leafLeft ? 0.5 - 0.085 : 0.915 - 0.5;
  const lu = (u - leafStart) / leafWidth;

  // 门把手：靠近中缝的一侧
  const handleU = leafLeft ? lu > 0.76 && lu < 0.9 : lu > 0.1 && lu < 0.24;
  if (handleU && v > 0.465 && v < 0.535) return { rgb: DOOR_HANDLE_RGB, emissive: 0.3 };

  // 门板边框（stile / rail）
  const panelU = lu > 0.13 && lu < 0.87;
  const inUpper = v > 0.13 && v < 0.42;
  const inLower = v > 0.56 && v < 0.87;
  if (panelU && (inUpper || inLower)) {
    const top = inUpper ? 0.13 : 0.56;
    // 门板上沿高光、下沿阴影，形成像素浮雕
    if (v - top < 0.035) return { rgb: DOOR_PANEL_RGB, emissive: 0.14 };
    if (inUpper ? v > 0.385 : v > 0.835) return { rgb: DOOR_PANEL_DARK, emissive: 0 };
    return { rgb: DOOR_PANEL_RGB, emissive: 0 };
  }
  return { rgb: DOOR_PANEL_DARK, emissive: 0 };
}

// ==================== 主画面 ====================

export function renderView(
  ctx: CanvasRenderingContext2D,
  game: Game,
  view: ViewSize,
  fx: SceneFx = NO_FX,
): void {
  const W = view.w;
  const H = view.h;
  const maze = game.maze;
  const tanHalf = Math.tan(((FOV_DEG * Math.PI) / 180) / 2);
  // 方形像素投影：恒定水平视野角，纵向按窗口宽高比换算，窗口缩放不会变形
  const proj = W / (2 * tanHalf);
  // 抬头/低头 = 地平线偏移（伪 3D 的限制：墙仍然是竖直的，没有真正的 3D 几何）
  const horizon = H / 2 + proj * Math.tan(game.pitch);

  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, W, H);

  const floorTop = Math.max(0, Math.min(H, Math.floor(horizon)));
  const ceilGrad = ctx.createLinearGradient(0, 0, 0, Math.max(1, floorTop));
  ceilGrad.addColorStop(0, '#000000');
  ceilGrad.addColorStop(1, '#0a0a12');
  ctx.fillStyle = ceilGrad;
  ctx.fillRect(0, 0, W, floorTop);

  const floorGrad = ctx.createLinearGradient(0, floorTop, 0, H);
  floorGrad.addColorStop(0, '#000000');
  floorGrad.addColorStop(1, shade(FLOOR_RGB, FLOOR_GAIN));
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, floorTop, W, H - floorTop);

  const dirX = Math.cos(game.angle);
  const dirY = Math.sin(game.angle);
  const planeX = -dirY * tanHalf;
  const planeY = dirX * tanHalf;
  const doorCol = maze.door.col;
  const doorRow = maze.door.row;
  const openT = game.doorOpenT;
  const animating = fx.animT >= 0;

  for (let x = 0; x < W; x++) {
    const cameraX = (2 * x) / W - 1;
    let rx = dirX + planeX * cameraX;
    let ry = dirY + planeY * cameraX;
    const len = Math.hypot(rx, ry);
    rx /= len;
    ry /= len;
    const cos = rx * dirX + ry * dirY;
    const cone = coneGain(Math.abs(cameraX));

    const hit = castRay(maze, game.x, game.y, rx, ry, VIEW_DISTANCE);
    if (hit) {
      const perp = Math.max(0.02, hit.dist * cos);
      const lineH = proj / perp;
      const top = horizon - lineH / 2;
      const b = fogFactor(hit.dist) * cone * (hit.side === 1 ? WALL_SIDE_SHADE : 1);
      const isDoor = hit.col === doorCol && hit.row === doorRow;

      if (isDoor) {
        paintDoorColumn(ctx, x, top, lineH, H, hit.wallX, b, openT);
      } else if (animating && fxHasCell(fx.closing, hit.col, hit.row)) {
        paintDissolveColumn(ctx, x, top, lineH, H, hit.wallX, b, hit.col, hit.row, fx.animT, true);
      } else if (animating && fxHasCell(fx.opening, hit.col, hit.row)) {
        paintDissolveColumn(ctx, x, top, lineH, H, hit.wallX, b, hit.col, hit.row, fx.animT, false);
      } else {
        paintWallColumn(ctx, x, top, lineH, H, hit.wallX, b);
      }
    }

    // 预警幻影墙：用并集图另打一条射线，只在幻影墙比真实墙更近时叠加半透明像素屏障
    if (fx.pulse >= 0 && fx.ghostMaze) {
      const ghost = castRay(fx.ghostMaze, game.x, game.y, rx, ry, VIEW_DISTANCE);
      if (ghost && fxHasCell(fx.warnCells, ghost.col, ghost.row) && (!hit || ghost.dist <= hit.dist + 1e-6)) {
        paintGhostColumn(ctx, x, horizon, proj, H, ghost.dist * cos, fx.pulse);
      }
    }
  }

  // 暗角：中央亮、四周暗，叠加在墙面照明之上（不代替它）
  const radius = Math.max(W, H) * 0.82;
  const vig = ctx.createRadialGradient(W / 2, horizon, radius * 0.3, W / 2, horizon, radius);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, `rgba(0,0,0,${VIGNETTE_ALPHA})`);
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  if (fx.flash >= 0) {
    ctx.fillStyle = `rgba(196,208,255,${(0.2 * fx.flash).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }

  if (openT > 0) {
    // 开门时暖光涌入
    ctx.fillStyle = `rgba(255,232,168,${(0.55 * openT * openT).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalAlpha = 1;
}

function paintWallColumn(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  lineH: number,
  H: number,
  wallX: number,
  b: number,
): void {
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(H, Math.ceil(top + lineH));
  if (y1 <= y0) return;

  const seam = ((wallX * BRICK_COLS) % 1 < 0.09 ? 0.82 : 1);
  ctx.fillStyle = shade(WALL_RGB, b * seam);
  ctx.fillRect(x, y0, 1, y1 - y0);

  ctx.fillStyle = shade(WALL_RGB, b * seam * 0.66);
  for (let k = 1; k < BRICK_ROWS; k++) {
    const y = Math.floor(top + (lineH * k) / BRICK_ROWS);
    if (y > y0 && y < y1) ctx.fillRect(x, y, 1, 1);
  }
}

// 动态墙动画：像素级生长（materialize）或消散（dissolve），生长边缘用预警色高亮
function paintDissolveColumn(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  lineH: number,
  H: number,
  wallX: number,
  b: number,
  col: number,
  row: number,
  t: number,
  growing: boolean,
): void {
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(H, Math.ceil(top + lineH));
  if (y1 <= y0) return;

  const seam = ((wallX * BRICK_COLS) % 1 < 0.09 ? 0.82 : 1);
  const base = shade(WALL_RGB, b * seam);
  const edge = shade(WARN_RGB, Math.min(1.4, b * 1.5 + 0.3));
  const presence = growing ? t : 1 - t;

  for (let y = y0; y < y1; y++) {
    const n = dissolveNoise(col, row, y);
    if (n >= presence) continue;
    ctx.fillStyle = Math.abs(n - presence) < 0.07 ? edge : base;
    ctx.fillRect(x, y, 1, 1);
  }
}

function paintGhostColumn(
  ctx: CanvasRenderingContext2D,
  x: number,
  horizon: number,
  proj: number,
  H: number,
  perp: number,
  pulse: number,
): void {
  const p = Math.max(0.02, perp);
  const lineH = proj / p;
  const top = horizon - lineH / 2;
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(H, Math.ceil(top + lineH));
  const alpha = 0.16 + 0.2 * pulse;
  ctx.fillStyle = `rgba(${WARN_RGB[0]},${WARN_RGB[1]},${WARN_RGB[2]},${alpha.toFixed(3)})`;
  // 扫描线：像素风能量屏障，而不是整块半透明墙
  for (let y = y0; y < y1; y++) {
    if ((y + Math.floor(pulse * 6)) % 4 >= 2) continue;
    ctx.fillRect(x, y, 1, 1);
  }
}

function paintDoorColumn(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  lineH: number,
  H: number,
  wallX: number,
  b: number,
  openT: number,
): void {
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(H, Math.ceil(top + lineH));
  if (y1 <= y0) return;

  // 量化到像素纹理网格，任何窗口尺寸下都是清晰的像素门
  const u = (Math.floor(wallX * DOOR_TEX_U) + 0.5) / DOOR_TEX_U;
  let runStart = y0;
  let runColor = '';

  for (let y = y0; y < y1; y++) {
    const vRaw = clamp01((y + 0.5 - top) / lineH);
    const v = (Math.floor(vRaw * DOOR_TEX_V) + 0.5) / DOOR_TEX_V;
    const surface = doorSurface(u, v, openT);
    let color: string;
    if (surface === null) {
      // 门洞：随开门进度越来越亮的暖光
      color = shade(DOOR_LIGHT_RGB, 0.55 + 0.75 * openT);
    } else {
      color = shade(surface.rgb, Math.max(b, surface.emissive));
    }
    if (color !== runColor) {
      if (runColor !== '') ctx.fillRect(x, runStart, 1, y - runStart);
      runColor = color;
      runStart = y;
      ctx.fillStyle = color;
    }
  }
  if (runColor !== '') {
    ctx.fillStyle = runColor;
    ctx.fillRect(x, runStart, 1, y1 - runStart);
  }
}

// ==================== 小地图 ====================

let beamBuffer = new Float32Array(beamPolygonCapacity());

export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  maze: Maze,
  exp: Exploration,
  game: Game,
  cell: number,
  fx: SceneFx = NO_FX,
): void {
  const w = maze.cols * cell;
  const h = maze.rows * cell;
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, w, h);

  // 只画「最后一次实际看到的地形」：未探索区域是不透明纯黑，远处动态墙变化不会透视泄露
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      const idx = row * maze.cols + col;
      const observed = exp.observed[idx];
      if (observed === 0) continue;
      const lit = exp.visible[idx] === 1;
      ctx.fillStyle =
        observed === OBS_WALL
          ? lit
            ? COLORS.mapWallLit
            : COLORS.mapWallDim
          : lit
            ? COLORS.mapFloorLit
            : COLORS.mapFloorDim;
      ctx.fillRect(col * cell, row * cell, cell, cell);
    }
  }

  // 手电筒扇形光束：与第一人称相同的朝向/视野角/视距，用射线首个交点构成多边形，被墙截断
  if (beamBuffer.length < beamPolygonCapacity()) beamBuffer = new Float32Array(beamPolygonCapacity());
  const points = fillBeamPolygon(maze, game.x, game.y, game.angle, beamBuffer);
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const px = beamBuffer[i * 2] * cell;
    const py = beamBuffer[i * 2 + 1] * cell;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = COLORS.mapBeam;
  ctx.fill();

  if (exp.exitSeen) {
    const dx = maze.door.col * cell;
    const dy = maze.door.row * cell;
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(dx, dy, cell, cell);
    ctx.fillStyle = COLORS.page;
    ctx.fillRect(dx + Math.floor(cell / 2), dy + 1, Math.max(1, Math.floor(cell / 5)), cell - 2);
  }

  // 预警标记只出现在已观察格上，未知区域不泄露
  if (fx.pulse >= 0) {
    const alpha = 0.35 + 0.5 * fx.pulse;
    for (const warn of fx.warnCells) {
      if (exp.observed[idxOf(maze, warn.col, warn.row)] === 0) continue;
      ctx.strokeStyle = `rgba(${WARN_RGB[0]},${WARN_RGB[1]},${WARN_RGB[2]},${alpha.toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(warn.col * cell + 0.5, warn.row * cell + 0.5, cell - 1, cell - 1);
    }
  }

  const px = game.x * cell;
  const py = game.y * cell;
  ctx.strokeStyle = COLORS.mapPlayer;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + Math.cos(game.angle) * cell * 1.7, py + Math.sin(game.angle) * cell * 1.7);
  ctx.stroke();
  ctx.fillStyle = COLORS.mapPlayer;
  ctx.fillRect(Math.round(px) - 1, Math.round(py) - 1, 3, 3);
}

function idxOf(maze: Maze, col: number, row: number): number {
  return row * maze.cols + col;
}
