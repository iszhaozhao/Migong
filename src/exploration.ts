import { EXPLORE_RAY_COUNT, FOV_DEG, MINIMAP_BEAM_RAYS, VIEW_DISTANCE } from './config.ts';
import { cellIndex, isWall, type Maze } from './maze.ts';
import { castRay } from './raycast.ts';

export const OBS_UNKNOWN = 0;
export const OBS_FLOOR = 1;
export const OBS_WALL = 2;

// 战争迷雾：visible 为当前视野内实际可见（受墙遮挡），explored 为本局累计探索记录，
// observed 为「最后一次实际看到的地形」。小地图只画 observed，因此远处动态墙变化不会透视泄露。
export class Exploration {
  explored: Uint8Array;
  visible: Uint8Array;
  observed: Uint8Array;
  exitSeen = false;

  constructor(maze: Maze) {
    const total = maze.cols * maze.rows;
    this.explored = new Uint8Array(total);
    this.visible = new Uint8Array(total);
    this.observed = new Uint8Array(total);
  }

  reset(): void {
    this.explored.fill(0);
    this.visible.fill(0);
    this.observed.fill(OBS_UNKNOWN);
    this.exitSeen = false;
  }

  isVisible(maze: Maze, col: number, row: number): boolean {
    return this.visible[cellIndex(maze, col, row)] === 1;
  }

  isExplored(maze: Maze, col: number, row: number): boolean {
    return this.explored[cellIndex(maze, col, row)] === 1;
  }

  observedAt(maze: Maze, col: number, row: number): number {
    return this.observed[cellIndex(maze, col, row)];
  }

  // 只用水平朝向 angle：抬头低头不会误清空或误记录地图
  update(maze: Maze, x: number, y: number, angle: number): void {
    const visible = this.visible;
    const observed = this.observed;
    visible.fill(0);

    const mark = (col: number, row: number): void => {
      const i = cellIndex(maze, col, row);
      visible[i] = 1;
      observed[i] = isWall(maze, col, row) ? OBS_WALL : OBS_FLOOR;
    };
    mark(Math.floor(x), Math.floor(y));

    const half = ((FOV_DEG * Math.PI) / 180) / 2;
    for (let i = 0; i < EXPLORE_RAY_COUNT; i++) {
      const a = angle - half + (2 * half * i) / (EXPLORE_RAY_COUNT - 1);
      const hit = castRay(maze, x, y, Math.cos(a), Math.sin(a), VIEW_DISTANCE, (col, row) => mark(col, row));
      if (hit) mark(hit.col, hit.row);
    }

    const explored = this.explored;
    for (let i = 0; i < explored.length; i++) {
      if (visible[i] === 1) explored[i] = 1;
    }
    if (visible[cellIndex(maze, maze.door.col, maze.door.row)] === 1) this.exitSeen = true;
  }
}

// 小地图手电筒光束：与第一人称相同的朝向、水平视野角、最大照明距离，
// 用每条射线的首个交点构成可见多边形，因此扇形会被墙截断而不是穿过所有墙壁。
export function fillBeamPolygon(
  maze: Maze,
  x: number,
  y: number,
  angle: number,
  out: Float32Array,
  rays: number = MINIMAP_BEAM_RAYS,
): number {
  const half = ((FOV_DEG * Math.PI) / 180) / 2;
  let n = 0;
  out[n++] = x;
  out[n++] = y;
  for (let i = 0; i < rays; i++) {
    const a = angle - half + (2 * half * i) / (rays - 1);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const hit = castRay(maze, x, y, dx, dy, VIEW_DISTANCE);
    const d = hit ? Math.min(hit.dist, VIEW_DISTANCE) : VIEW_DISTANCE;
    out[n++] = x + dx * d;
    out[n++] = y + dy * d;
  }
  return n / 2;
}

export function beamPolygonCapacity(rays: number = MINIMAP_BEAM_RAYS): number {
  return (rays + 1) * 2;
}
