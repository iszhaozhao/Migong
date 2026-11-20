import {
  MAX_SUBSTEP_DISTANCE,
  MOVE_SPEED,
  PLAYER_RADIUS,
  TURN_SPEED,
  type GridPos,
} from './config.ts';
import { generateMaze, isWalkable, type Maze, type Random } from './maze.ts';

export type InputState = { forward: number; turn: number };

export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const FACING_OPTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [0, 1, Math.PI / 2],
  [-1, 0, Math.PI],
  [0, -1, -Math.PI / 2],
];

function initialFacing(maze: Maze): number {
  for (const [dc, dr, angle] of FACING_OPTIONS) {
    if (isWalkable(maze, maze.start.col + dc, maze.start.row + dr)) return angle;
  }
  return 0;
}

export class Game {
  maze: Maze;
  x = 0;
  y = 0;
  angle = 0;
  won = false;
  elapsedMs = 0;

  constructor(maze: Maze = generateMaze()) {
    this.maze = maze;
    this.reset();
  }

  reset(): void {
    this.x = this.maze.start.col + 0.5;
    this.y = this.maze.start.row + 0.5;
    this.angle = initialFacing(this.maze);
    this.won = false;
    this.elapsedMs = 0;
  }

  newMaze(random?: Random): void {
    this.maze = generateMaze(random);
    this.reset();
  }

  update(dtSec: number, input: InputState): void {
    if (this.won) return;

    this.angle = normalizeAngle(this.angle + input.turn * TURN_SPEED * dtSec);

    // 子步限制单步位移，卡顿时也不会穿墙
    const stepTime = MAX_SUBSTEP_DISTANCE / MOVE_SPEED;
    let remaining = dtSec;
    while (remaining > 1e-9) {
      const step = Math.min(remaining, stepTime);
      const dist = MOVE_SPEED * input.forward * step;
      if (dist !== 0) this.slide(dist);
      remaining -= step;
    }

    this.elapsedMs += dtSec * 1000;
    if (this.cell().col === this.maze.exit.col && this.cell().row === this.maze.exit.row) {
      this.won = true;
    }
  }

  cell(): GridPos {
    return { col: Math.floor(this.x), row: Math.floor(this.y) };
  }

  // X/Y 轴分别检测：被挡的轴不动，另一轴继续，形成贴墙滑动
  private slide(dist: number): void {
    const dx = Math.cos(this.angle) * dist;
    const dy = Math.sin(this.angle) * dist;
    if (dx !== 0 && this.free(this.x + dx, this.y)) this.x += dx;
    if (dy !== 0 && this.free(this.x, this.y + dy)) this.y += dy;
  }

  free(px: number, py: number): boolean {
    const r = PLAYER_RADIUS;
    const c0 = Math.floor(px - r);
    const c1 = Math.floor(px + r);
    const r0 = Math.floor(py - r);
    const r1 = Math.floor(py + r);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        if (!isWalkable(this.maze, col, row)) return false;
      }
    }
    return true;
  }
}
