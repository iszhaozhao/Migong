import { isWall, type Maze } from './maze.ts';

export type RayHit = {
  dist: number;
  col: number;
  row: number;
  side: 0 | 1;
  wallX: number;
};

export type FloorVisitor = (col: number, row: number, enterDist: number) => void;

// 网格 DDA 遍历。方向必须归一化，dist 为欧氏距离。
// onFloor 对射线穿过的每个道路格回调（含起点格）；命中第一块墙即返回，墙后不再遍历。
export function castRay(
  maze: Maze,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
  onFloor?: FloorVisitor,
): RayHit | null {
  let col = Math.floor(ox);
  let row = Math.floor(oy);
  if (onFloor) onFloor(col, row, 0);

  const ddx = dx === 0 ? Infinity : Math.abs(1 / dx);
  const ddy = dy === 0 ? Infinity : Math.abs(1 / dy);
  const stepX = dx < 0 ? -1 : 1;
  const stepY = dy < 0 ? -1 : 1;
  let sideDistX = dx === 0 ? Infinity : (dx < 0 ? ox - col : col + 1 - ox) * ddx;
  let sideDistY = dy === 0 ? Infinity : (dy < 0 ? oy - row : row + 1 - oy) * ddy;

  let side: 0 | 1 = 0;
  let dist = 0;

  for (let i = 0; i < 512; i++) {
    if (sideDistX < sideDistY) {
      dist = sideDistX;
      sideDistX += ddx;
      col += stepX;
      side = 0;
    } else {
      dist = sideDistY;
      sideDistY += ddy;
      row += stepY;
      side = 1;
    }
    if (dist > maxDist) return null;

    if (isWall(maze, col, row)) {
      const hx = ox + dx * dist;
      const hy = oy + dy * dist;
      const wallX = side === 0 ? hy - Math.floor(hy) : hx - Math.floor(hx);
      return { dist, col, row, side, wallX };
    }
    if (onFloor) onFloor(col, row, dist);
  }
  return null;
}
