import type { GridPos } from './config.ts';
import type { Maze } from './maze.ts';

// 主画面与小地图共用的瞬时特效状态（预警 / 动画 / 闪光）。
// 单例复用，避免每帧分配。
export type SceneFx = {
  /** 预警中的格子：并集图里会新增的墙 + 即将打开的墙 */
  warnCells: GridPos[];
  /** 预警期间用于绘制半透明幻影墙的并集图；null 表示无预警 */
  ghostMaze: Maze | null;
  /** 预警脉冲相位 0..1；-1 表示无预警 */
  pulse: number;
  /** 动画期间正在生成的墙 */
  closing: GridPos[];
  /** 动画期间正在消失的墙 */
  opening: GridPos[];
  /** 动画进度 0..1；-1 表示无动画 */
  animT: number;
  /** 提交后的视觉闪光 0..1（不影响碰撞）；-1 表示无 */
  flash: number;
};

export const NO_FX: SceneFx = {
  warnCells: [],
  ghostMaze: null,
  pulse: -1,
  closing: [],
  opening: [],
  animT: -1,
  flash: -1,
};

export function clearFx(fx: SceneFx): void {
  fx.warnCells.length = 0;
  fx.ghostMaze = null;
  fx.pulse = -1;
  fx.closing.length = 0;
  fx.opening.length = 0;
  fx.animT = -1;
  fx.flash = -1;
}

export function fxHasCell(list: readonly GridPos[], col: number, row: number): boolean {
  for (const cell of list) if (cell.col === col && cell.row === row) return true;
  return false;
}
