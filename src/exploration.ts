import { EXPLORE_RAY_COUNT, FOV_DEG, VIEW_DISTANCE } from './config.ts';
import type { Maze } from './maze.ts';
import { castRay } from './raycast.ts';

// 战争迷雾：visible 为当前视野内实际可见（受墙遮挡），explored 为本局累计探索记录。
export class Exploration {
  explored: Uint8Array;
  visible: Uint8Array;
  exitSeen = false;

  constructor(maze: Maze) {
    this.explored = new Uint8Array(maze.cols * maze.rows);
    this.visible = new Uint8Array(maze.cols * maze.rows);
  }

  reset(): void {
    this.explored.fill(0);
    this.visible.fill(0);
    this.exitSeen = false;
  }

  isVisible(maze: Maze, col: number, row: number): boolean {
    return this.visible[row * maze.cols + col] === 1;
  }

  isExplored(maze: Maze, col: number, row: number): boolean {
    return this.explored[row * maze.cols + col] === 1;
  }

  update(maze: Maze, x: number, y: number, angle: number): void {
    const visible = this.visible;
    visible.fill(0);
    const mark = (col: number, row: number): void => {
      visible[row * maze.cols + col] = 1;
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
    if (visible[maze.exit.row * maze.cols + maze.exit.col] === 1) this.exitSeen = true;
  }
}
