import {
  BRICK_COLS,
  BRICK_ROWS,
  COLORS,
  DECOR_CRYSTAL_RGB,
  DECOR_RUNE_RGB,
  DECOR_STONE_RGB,
  EXIT_GLOW_RGB,
  FOV_DEG,
  RENDER_H,
  RENDER_W,
  VIEW_DISTANCE,
  WALL_EDGE_RGB,
  WALL_RGB,
  WALL_SIDE_SHADE,
} from './config.ts';
import type { Decoration } from './decor.ts';
import type { Exploration } from './exploration.ts';
import type { Game } from './game.ts';
import { isWall, type Maze } from './maze.ts';
import { castRay } from './raycast.ts';
import { cellHash, renderBase } from './scene.ts';

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

// 每列首墙垂直距离：装饰按列做遮挡测试，保证不穿墙
const wallDepth = new Float64Array(RENDER_W);

export function renderView(ctx: CanvasRenderingContext2D, game: Game, decorations: readonly Decoration[] = []): void {
  const W = RENDER_W;
  const H = RENDER_H;
  const horizon = H / 2;
  wallDepth.fill(Infinity);

  // 世界锚定的石板地面 + 拱顶石梁基层（程序化贴图，视距外深暖底色）
  renderBase(ctx, game);

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
      ctx.fillStyle = `rgba(${EXIT_GLOW_RGB[0]},${EXIT_GLOW_RGB[1]},${EXIT_GLOW_RGB[2]},${(0.45 * fogFactor(perp)).toFixed(3)})`;
      ctx.fillRect(x, yFar, 1, Math.max(1, yNear - yFar));
    }

    if (!hit) continue;

    // 垂直于相机平面的距离，避免鱼眼畸变
    const perp = Math.max(0.02, hit.dist * cos);
    wallDepth[x] = perp;
    const lineH = H / perp;
    const start = Math.floor(horizon - lineH / 2);
    const end = Math.ceil(horizon + lineH / 2);

    const face = hit.side === 1 ? WALL_SIDE_SHADE : 1;
    const b = fogFactor(hit.dist) * face;
    ctx.fillStyle = shade(WALL_RGB, b);
    ctx.fillRect(x, start, 1, end - start);

    if (end - start < 8) {
      // 远处小墙面：只留顶缘/底缘两条层次
      ctx.fillStyle = shade(WALL_EDGE_RGB, b * 0.5);
      ctx.fillRect(x, start, 1, 1);
      ctx.fillStyle = shade(WALL_RGB, b * 0.55);
      ctx.fillRect(x, end - 1, 1, 1);
      continue;
    }

    // 厚重岩壁：顶部结构石梁 + 底部墙基 + 中段错缝大石砖（切面明暗）
    const plinthH = Math.max(2, Math.round(lineH * 0.12));
    const lintelH = Math.max(2, Math.round(lineH * 0.08));
    const plinthTop = end - plinthH;
    const lintelBot = start + lintelH;
    const midH = plinthTop - lintelBot;

    if (midH >= 4) {
      for (let k = 0; k < BRICK_ROWS; k++) {
        const cTop = lintelBot + (midH * k) / BRICK_ROWS;
        const cBot = lintelBot + (midH * (k + 1)) / BRICK_ROWS;
        const offset = k % 2 === 1 ? 0.5 : 0;
        if (((hit.wallX * BRICK_COLS + offset) % 1) < 0.06) {
          ctx.fillStyle = shade(WALL_RGB, b * 0.78);
          ctx.fillRect(x, cTop, 1, cBot - cTop);
        }
        if (cBot - cTop >= 3) {
          ctx.fillStyle = shade(WALL_RGB, b * 1.1);
          ctx.fillRect(x, cTop, 1, 1);
          ctx.fillStyle = shade(WALL_RGB, b * 0.72);
          ctx.fillRect(x, cBot - 1, 1, 1);
        }
      }

      // 部分墙面的大型几何浮雕：低对比菱形刻面，无可读文字、不暗示机关
      if ((cellHash(hit.col, hit.row) & 7) === 0 && midH >= 10) {
        const du = Math.abs(hit.wallX - 0.5) * 2;
        if (du < 0.72) {
          const span = (0.72 - du) * midH * 0.3;
          const yc = (lintelBot + plinthTop) / 2;
          const th = Math.max(1, Math.round(midH * 0.035));
          ctx.fillStyle = shade(WALL_RGB, b * 0.84);
          ctx.fillRect(x, yc - span, 1, th);
          ctx.fillRect(x, yc + span - th, 1, th);
          ctx.fillStyle = shade(WALL_RGB, b * 1.08);
          ctx.fillRect(x, yc - th / 2, 1, th);
        }
      }
    }

    // 墙基：压暗色面 + 极弱暗金压顶线
    ctx.fillStyle = shade(WALL_RGB, b * 0.6);
    ctx.fillRect(x, plinthTop, 1, end - plinthTop);
    ctx.fillStyle = shade(WALL_EDGE_RGB, b * 0.28);
    ctx.fillRect(x, plinthTop, 1, 1);

    // 石梁：略亮结构带 + 弱暗金梁缘
    ctx.fillStyle = shade(WALL_RGB, b * 1.06);
    ctx.fillRect(x, start, 1, lintelBot - start);
    ctx.fillStyle = shade(WALL_EDGE_RGB, b * 0.4);
    ctx.fillRect(x, lintelBot - 1, 1, 1);
  }

  renderDecorations(ctx, game, decorations, horizon, tanHalf);
}

type Projected = { d: Decoration; depth: number; screenX: number; widthPx: number };

// 世界空间装饰：相机平面投影 + 视距/FOV 裁剪 + 远到近画家排序 + 每列墙深遮挡
function renderDecorations(
  ctx: CanvasRenderingContext2D,
  game: Game,
  decorations: readonly Decoration[],
  horizon: number,
  tanHalf: number,
): void {
  const W = RENDER_W;
  const H = RENDER_H;
  const dirX = Math.cos(game.angle);
  const dirY = Math.sin(game.angle);
  const planeX = -dirY * tanHalf;
  const planeY = dirX * tanHalf;
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  const hScale = W / (2 * tanHalf);

  const visible: Projected[] = [];
  for (const d of decorations) {
    const sx = d.x - game.x;
    const sy = d.y - game.y;
    const depth = invDet * (-planeY * sx + planeX * sy);
    if (depth <= 0.15 || depth > VIEW_DISTANCE) continue;
    const screenX = (W / 2) * (1 + (invDet * (dirY * sx - dirX * sy)) / depth);
    const widthPx = (d.w * hScale) / depth;
    if (screenX + widthPx / 2 < 0 || screenX - widthPx / 2 > W) continue;
    visible.push({ d, depth, screenX, widthPx });
  }
  visible.sort((a, b) => b.depth - a.depth);

  for (const v of visible) {
    const { d, depth, screenX, widthPx } = v;
    const b = fogFactor(depth);
    const baseY = horizon + H / 2 / depth;
    const x0 = Math.max(0, Math.floor(screenX - widthPx / 2));
    const x1 = Math.min(W - 1, Math.ceil(screenX + widthPx / 2));
    const left = screenX - widthPx / 2;

    for (let x = x0; x <= x1; x++) {
      if (depth >= wallDepth[x]) continue;
      const u = (x + 0.5 - left) / widthPx;
      const a = Math.abs(u - 0.5);
      if (a > 0.5) continue;

      if (d.kind === 'rune') {
        // 贴地菱形刻印：按地面透视取近/远边，环状两条低对比暗金带
        const yNear = horizon + H / 2 / Math.max(0.2, depth - d.w / 2);
        const yFar = horizon + H / 2 / (depth + d.w / 2);
        const half = (1 - a * 2) * 0.5;
        if (half <= 0) continue;
        const th = Math.max(0.05, half * 0.35);
        ctx.fillStyle = shade(DECOR_RUNE_RGB, b * 0.5);
        ctx.fillRect(x, yFar + (0.5 - half) * (yNear - yFar), 1, Math.max(1, th * (yNear - yFar)));
        ctx.fillRect(x, yFar + (0.5 + half - th) * (yNear - yFar), 1, Math.max(1, th * (yNear - yFar)));
        continue;
      }

      const heightPx = (d.h * H) / depth;
      const topY = baseY - heightPx;

      if (d.kind === 'pillar') {
        // 高石柱：两级柱帽/带凹槽柱身/两级底座，左右削角明暗 + 帽顶极弱暗金
        const facet = u < 0.3 ? 0.78 : u > 0.72 ? 0.88 : 1;
        const capH = heightPx * 0.14;
        const baseH = heightPx * 0.16;
        if (a < 0.5) {
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 1.08);
          ctx.fillRect(x, topY, 1, capH);
          ctx.fillStyle = shade(WALL_EDGE_RGB, b * 0.45);
          ctx.fillRect(x, topY, 1, 1);
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 0.85);
          ctx.fillRect(x, topY + capH - 1, 1, 1);
        }
        if (a < 0.34) {
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet);
          ctx.fillRect(x, topY + capH, 1, heightPx - capH - baseH);
          if (Math.abs(u - 0.42) < 0.035 || Math.abs(u - 0.58) < 0.035) {
            ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 0.88);
            ctx.fillRect(x, topY + capH, 1, heightPx - capH - baseH);
          }
        }
        if (a < 0.44) {
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 0.82);
          ctx.fillRect(x, baseY - baseH, 1, baseH);
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 0.95);
          ctx.fillRect(x, baseY - baseH, 1, 1);
        }
      } else if (d.kind === 'altar') {
        // 大型祭台/石棺状石台：三级体块 + 盖板缺角，不可交互、无恐怖内容
        const facet = u < 0.45 ? 1 : 0.82;
        const t1 = heightPx * 0.34;
        const t2 = heightPx * 0.4;
        const lid = heightPx * 0.26;
        ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 0.85);
        ctx.fillRect(x, baseY - t1, 1, t1);
        if (a < 0.42) {
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet);
          ctx.fillRect(x, baseY - t1 - t2, 1, t2);
        }
        if (a < 0.34) {
          let lidTop = topY;
          const n = 0.4 + d.notch * 0.25;
          if (u > n && u < n + 0.18) lidTop = topY + lid * 0.5;
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 1.06);
          ctx.fillRect(x, lidTop, 1, baseY - t1 - t2 - lidTop);
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 1.15);
          ctx.fillRect(x, lidTop, 1, 1);
          ctx.fillStyle = shade(WALL_EDGE_RGB, b * 0.3);
          ctx.fillRect(x, baseY - t1 - t2 - 1, 1, 1);
        }
      } else if (d.kind === 'stele') {
        // 倾斜石碑/破损门框残片：整体倾斜 + 顶部断口 + 低对比刻带
        const facet = u < 0.5 ? 1 : 0.82;
        let top = topY + u * heightPx * 0.1;
        const n = 0.35 + d.notch * 0.3;
        if (u > n && u < n + 0.22) top += heightPx * 0.28;
        else if (u > 0.86) top += heightPx * 0.14;
        ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet);
        ctx.fillRect(x, top, 1, baseY - top);
        ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 1.12);
        ctx.fillRect(x, top, 1, 1);
        if (baseY - top >= 8) {
          ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 0.85);
          ctx.fillRect(x, top + (baseY - top) * 0.35, 1, 1);
          ctx.fillRect(x, top + (baseY - top) * 0.55, 1, 1);
        }
        ctx.fillStyle = shade(DECOR_STONE_RGB, b * facet * 0.8);
        ctx.fillRect(x, baseY - heightPx * 0.08, 1, heightPx * 0.08);
      } else {
        // 晶石簇：三根淡青晶柱 + 静态低强度局部柔光（无动画，暂停即冻结）
        ctx.globalAlpha = 0.09 * b;
        ctx.fillStyle = shade(DECOR_CRYSTAL_RGB, 1);
        ctx.fillRect(x, baseY - heightPx * 1.12, 1, heightPx * 1.12);
        ctx.globalAlpha = 1;
        const shards: ReadonlyArray<readonly [number, number, number]> = [
          [0.28, 0.11, 0.62],
          [0.52, 0.14, 1],
          [0.75, 0.1, 0.72],
        ];
        for (const [c, hw, hh] of shards) {
          const local = Math.abs(u - c) / hw;
          if (local >= 1) continue;
          const top = baseY - heightPx * hh * (1 - local * 0.55);
          ctx.fillStyle = shade(DECOR_CRYSTAL_RGB, b * (0.5 + 0.3 * (1 - local)));
          ctx.fillRect(x, top, 1, baseY - top);
          ctx.fillStyle = shade(DECOR_CRYSTAL_RGB, b * 0.85);
          ctx.fillRect(x, top, 1, 1);
        }
      }
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