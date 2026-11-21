import {
  DOOR_INTERACT_ANGLE_DEG,
  DOOR_INTERACT_DISTANCE,
  DOOR_OPEN_MS,
  MAX_SUBSTEP_DISTANCE,
  MOVE_SPEED,
  PITCH_MAX_DEG,
  PLAYER_RADIUS,
  TURN_SPEED,
  type GridPos,
} from './config.ts';
import {
  doorFaceCenter,
  generateMaze,
  isFreeAt,
  isWalkable,
  type Maze,
} from './maze.ts';
import type { Random } from './random.ts';
import { castRay } from './raycast.ts';

export type InputState = { forward: number; turn: number; pitch: number };

export const PITCH_MAX = (PITCH_MAX_DEG * Math.PI) / 180;

export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

const FACING_OPTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [0, 1, Math.PI / 2],
  [-1, 0, Math.PI],
  [0, -1, -Math.PI / 2],
];

// 初始朝向优先面向大门方向，其次任意可走方向
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
  /** 抬头/低头（弧度），射线投射伪 3D 只用于地平线偏移，受 PITCH_MAX 钳制 */
  pitch = 0;
  doorOpening = false;
  doorOpenMs = 0;
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
    this.pitch = 0;
    this.doorOpening = false;
    this.doorOpenMs = 0;
    this.won = false;
    this.elapsedMs = 0;
  }

  // 动态墙切换时替换整份地图：渲染、碰撞、探索射线都读同一个引用
  setMaze(maze: Maze): void {
    this.maze = maze;
  }

  newMaze(random?: Random): void {
    this.maze = generateMaze(random);
    this.reset();
  }

  cell(): GridPos {
    return { col: Math.floor(this.x), row: Math.floor(this.y) };
  }

  free(px: number, py: number): boolean {
    return isFreeAt(this.maze, px, py, PLAYER_RADIUS);
  }

  // ==================== 大门交互 ====================

  /** 玩家到门面的距离；站在门的错误一侧（墙内/地图外）返回 Infinity */
  doorDistance(): number {
    const face = doorFaceCenter(this.maze);
    const dx = face.x - this.x;
    const dy = face.y - this.y;
    const nx = this.maze.exit.col - this.maze.door.col;
    const ny = this.maze.exit.row - this.maze.door.row;
    // 门在 +n 侧是墙：玩家必须在门面外侧（沿法线反方向）
    if (dx * nx + dy * ny > 0) return Number.POSITIVE_INFINITY;
    return Math.hypot(dx, dy);
  }

  /** 视线朝向与「玩家 -> 门面中心」方向的夹角（弧度） */
  doorAngleDiff(): number {
    const face = doorFaceCenter(this.maze);
    const target = Math.atan2(face.y - this.y, face.x - this.x);
    return Math.abs(normalizeAngle(target - this.angle));
  }

  /** 视线是否真的打在大门所在墙格上：隔墙、背对、超距都返回 false */
  hasDoorLineOfSight(): boolean {
    const face = doorFaceCenter(this.maze);
    const dx = face.x - this.x;
    const dy = face.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return false;
    const hit = castRay(this.maze, this.x, this.y, dx / dist, dy / dist, dist + 0.05);
    return hit !== null && hit.col === this.maze.door.col && hit.row === this.maze.door.row;
  }

  canOpenDoor(): boolean {
    if (this.won || this.doorOpening) return false;
    if (this.doorDistance() > DOOR_INTERACT_DISTANCE) return false;
    if (this.doorAngleDiff() > (DOOR_INTERACT_ANGLE_DEG * Math.PI) / 180) return false;
    return this.hasDoorLineOfSight();
  }

  /** 按 E：只在靠近 + 面向 + 有视线时触发一次开门表现 */
  openDoor(): boolean {
    if (!this.canOpenDoor()) return false;
    this.doorOpening = true;
    this.doorOpenMs = 0;
    return true;
  }

  get doorOpenT(): number {
    return clamp(this.doorOpenMs / DOOR_OPEN_MS, 0, 1);
  }

  update(dtSec: number, input: InputState): void {
    if (this.won) return;

    if (this.doorOpening) {
      this.doorOpenMs += dtSec * 1000;
      if (this.doorOpenMs >= DOOR_OPEN_MS) {
        this.doorOpenMs = DOOR_OPEN_MS;
        this.won = true;
      }
      return;
    }

    this.angle = normalizeAngle(this.angle + input.turn * TURN_SPEED * dtSec);
    this.pitch = clamp(this.pitch + input.pitch, -PITCH_MAX, PITCH_MAX);

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
  }

  // X/Y 轴分别检测：被挡的轴不动，另一轴继续，形成贴墙滑动
  private slide(dist: number): void {
    const dx = Math.cos(this.angle) * dist;
    const dy = Math.sin(this.angle) * dist;
    if (dx !== 0 && this.free(this.x + dx, this.y)) this.x += dx;
    if (dy !== 0 && this.free(this.x, this.y + dy)) this.y += dy;
  }
}
