import {
  BRICK_COLS,
  BRICK_ROWS,
  COLORS,
  FOV_DEG,
  FLOOR_RGB,
  RENDER_H,
  RENDER_W,
  VIEW_DISTANCE,
  WALL_RGB,
  WALL_SIDE_SHADE,
} from './config.ts';
import type { Exploration } from './exploration.ts';
import type { Game } from './game.ts';
import { isWall, type Maze } from './maze.ts';
import { castRay } from './raycast.ts';

function fogFactor(dist: number): number {
  const t = 1 - dist / VIEW_DISTANCE;
  if (t <= 0) return 0;
  return Math.pow(t, 1.4);
}

function shade(rgb: readonly [number, number, number], b: number): string {
  const r = Math.min(255, Math.round(rgb[0] * b));
  const g = Math.min(255, Math.round(rgb[1] * b));
  const bl = Math.min(255, Math.round(rgb[2] * b));
  return `rgb(${r},${g},${bl})`;
}

export function renderView(ctx: CanvasRenderingContext2D, game: Game): void {
  const W = RENDER_W;
  const H = RENDER_H;
  const horizon = H / 2;

  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, W, H);

  const floorGrad = ctx.createLinearGradient(0, horizon, 0, H);
  floorGrad.addColorStop(0, '#000000');
  floorGrad.addColorStop(1, shade(FLOOR_RGB, 0.85));
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, horizon, W, H - horizon);

  const dirX = Math.cos(game.angle);
  const dirY = Math.sin(game.angle);
  const tanHalf = Math.tan(((FOV_DEG * Math.PI) / 180) / 2);
  const planeX = -dirY * tanHalf;
  const planeY = dirX * tanHalf;
  const exitCol = game.maze.exit.col;
  const exitRow = game.maze.exit.row;

  for (let x = 0; x < W; x++) {
    const cameraX = (2 * x) / W - 1;
    let rx = dirX + planeX * cameraX;
    let ry = dirY + planeY * cameraX;
    const len = Math.hypot(rx, ry);
    rx /= len;
    ry /= len;
    const cos = rx * dirX + ry * dirY;

    let exitDist = -1;
    const hit = castRay(game.maze, game.x, game.y, rx, ry, VIEW_DISTANCE, (col, row, dist) => {
      if (exitDist < 0 && col === exitCol && row === exitRow) exitDist = dist;
    });

    if (exitDist >= 0) {
      const perp = Math.max(0.2, exitDist * cos);
      const yNear = Math.min(H, horizon + (H / 2) / perp);
      const yFar = horizon + (H / 2) / (perp + 0.9);
      ctx.fillStyle = `rgba(255,200,87,${(0.45 * fogFactor(perp)).toFixed(3)})`;
      ctx.fillRect(x, yFar, 1, Math.max(1, yNear - yFar));
    }

    if (!hit) continue;

    // 垂直于相机平面的距离，避免鱼眼畸变
    const perp = Math.max(0.02, hit.dist * cos);
    const lineH = H / perp;
    const start = Math.floor(horizon - lineH / 2);
    const end = Math.ceil(horizon + lineH / 2);

    const face = hit.side === 1 ? WALL_SIDE_SHADE : 1;
    const seam = (hit.wallX * BRICK_COLS) % 1 < 0.09 ? 0.82 : 1;
    const b = fogFactor(hit.dist) * face * seam;
    ctx.fillStyle = shade(WALL_RGB, b);
    ctx.fillRect(x, start, 1, end - start);

    ctx.fillStyle = shade(WALL_RGB, b * 0.68);
    for (let k = 1; k < BRICK_ROWS; k++) {
      const y = Math.floor(start + (lineH * k) / BRICK_ROWS);
      if (y > start && y < end) ctx.fillRect(x, y, 1, 1);
    }
  }
}

export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  maze: Maze,
  exp: Exploration,
  game: Game,
  cell: number,
): void {
  const w = maze.cols * cell;
  const h = maze.rows * cell;
  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, w, h);

  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      const idx = row * maze.cols + col;
      if (exp.explored[idx] !== 1) continue;
      const lit = exp.visible[idx] === 1;
      ctx.fillStyle = isWall(maze, col, row)
        ? lit
          ? COLORS.mapWallLit
          : COLORS.mapWallDim
        : lit
          ? COLORS.mapFloorLit
          : COLORS.mapFloorDim;
      ctx.fillRect(col * cell, row * cell, cell, cell);
    }
  }

  if (exp.exitSeen) {
    const ex = maze.exit.col * cell;
    const ey = maze.exit.row * cell;
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(ex + 1, ey + 1, cell - 2, cell - 2);
    ctx.fillStyle = COLORS.page;
    ctx.fillRect(ex + Math.floor(cell / 2) - 1, ey + Math.floor(cell / 2) - 1, 2, 2);
  }

  const px = game.x * cell;
  const py = game.y * cell;
  ctx.strokeStyle = COLORS.mapPlayer;
  ctx.lineWidth = Math.max(1, Math.round(cell / 6));
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + Math.cos(game.angle) * cell * 1.7, py + Math.sin(game.angle) * cell * 1.7);
  ctx.stroke();
  const marker = Math.max(3, Math.round(cell * 0.5));
  const mx = Math.round(px - marker / 2);
  const my = Math.round(py - marker / 2);
  ctx.fillStyle = COLORS.page;
  ctx.fillRect(mx - 1, my - 1, marker + 2, marker + 2);
  ctx.fillStyle = COLORS.mapPlayer;
  ctx.fillRect(mx, my, marker, marker);
}
