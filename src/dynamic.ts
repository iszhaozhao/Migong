import {
  DYNAMIC_ANIM_MS,
  DYNAMIC_FLASH_MS,
  DYNAMIC_INTERVAL_MS,
  DYNAMIC_MODULE_MAX,
  DYNAMIC_MODULE_MIN,
  DYNAMIC_MODULE_SPAN,
  DYNAMIC_PULSE_MS,
  DYNAMIC_SAFE_MARGIN,
  DYNAMIC_WARN_MS,
  PLAYER_RADIUS,
  type GridPos,
} from './config.ts';
import { clearFx, type SceneFx } from './fx.ts';
import type { Game } from './game.ts';
import {
  allRoomsReachableFrom,
  borderClosed,
  cellClearance,
  cellIndex,
  doorApproach,
  isCorridorCell,
  isFreeAt,
  isProtected,
  isReachable,
  isWalkable,
  WALL,
  withWalls,
  type Maze,
} from './maze.ts';
import { randInt, shuffle, type Random } from './random.ts';

/**
 * 局部改道模块：两个内部通道格 a / b，状态 0 = a 开 b 关，状态 1 = a 关 b 开。
 * 生成时 a 一定是地图上已打开的那一格，所以初始状态永远是 0，等于原图。
 */
export type Module = { a: GridPos; b: GridPos; state: 0 | 1 };

export type DynamicStats = {
  attempts: number;
  committed: number;
  cancelled: number;
  rejected: number;
  fallbackAtomic: number;
};

export type Pending = {
  moduleIndex: number;
  target: 0 | 1;
  closing: GridPos;
  opening: GridPos;
  nextWalls: Uint8Array;
  unionWalls: Uint8Array;
  phase: 'warn' | 'anim';
  ms: number;
  unionSafe: boolean;
};

function openCell(module: Module, state: 0 | 1): GridPos {
  return state === 0 ? module.a : module.b;
}

function closedCell(module: Module, state: 0 | 1): GridPos {
  return state === 0 ? module.b : module.a;
}

function applyState(walls: Uint8Array, cols: number, module: Module, state: 0 | 1): void {
  const open = openCell(module, state);
  const closed = closedCell(module, state);
  walls[open.row * cols + open.col] = 0;
  walls[closed.row * cols + closed.col] = WALL;
}

function unionWallsOf(base: Uint8Array, next: Uint8Array): Uint8Array {
  const union = new Uint8Array(base.length);
  for (let i = 0; i < union.length; i++) union[i] = base[i] === WALL || next[i] === WALL ? WALL : 0;
  return union;
}

/** 从地图上挑选互不重叠、只在局部改道的候选模块 */
export function pickModules(maze: Maze, random: Random): Module[] {
  const target = randInt(random, DYNAMIC_MODULE_MIN, DYNAMIC_MODULE_MAX);
  const cells: GridPos[] = [];
  for (let row = 1; row < maze.rows - 1; row++) {
    for (let col = 1; col < maze.cols - 1; col++) {
      if (!isCorridorCell(maze, col, row) || isProtected(maze, col, row)) continue;
      cells.push({ col, row });
    }
  }

  const pairs: Module[] = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const c = cells[i];
      const d = cells[j];
      if (Math.abs(c.col - d.col) + Math.abs(c.row - d.row) > DYNAMIC_MODULE_SPAN) continue;
      const cOpen = isWalkable(maze, c.col, c.row);
      const dOpen = isWalkable(maze, d.col, d.row);
      if (cOpen === dOpen) continue; // 必须一开一关，切换后才形成绕行
      pairs.push(cOpen ? { a: c, b: d, state: 0 } : { a: d, b: c, state: 0 });
    }
  }
  shuffle(pairs, random);

  const chosen: Module[] = [];
  const used = new Set<number>();
  for (const pair of pairs) {
    if (chosen.length >= target) break;
    const ia = cellIndex(maze, pair.a.col, pair.a.row);
    const ib = cellIndex(maze, pair.b.col, pair.b.row);
    if (used.has(ia) || used.has(ib)) continue; // 模块之间不共用格子，避免相互干扰
    used.add(ia);
    used.add(ib);
    chosen.push(pair);
  }
  return chosen;
}

/**
 * 中等模式的局部动态墙：固定周期尝试切换一个模块，事务式校验后才预警、动画、提交。
 * 简单模式不使用本类，整局地图静止。
 */
export class DynamicWalls {
  base: Maze;
  /** 渲染、碰撞、探索射线读取的同一份当前有效地图（动画期间是并集图） */
  effective: Maze;
  modules: Module[];
  fx: SceneFx;
  stats: DynamicStats = { attempts: 0, committed: 0, cancelled: 0, rejected: 0, fallbackAtomic: 0 };

  private random: Random;
  private timerMs = 0;
  private pending: Pending | null = null;
  private lastModule = -1;

  constructor(maze: Maze, random: Random, fx: SceneFx) {
    this.random = random;
    this.fx = fx;
    this.base = maze;
    this.effective = maze;
    this.modules = pickModules(maze, random);
  }

  get pendingInfo(): Pending | null {
    return this.pending;
  }

  /** 换关/返回主页面：清空待切换状态与特效，不再改图也不再推进计时 */
  destroy(): void {
    this.pending = null;
    this.timerMs = 0;
    clearFx(this.fx);
  }

  /** active 为 false（暂停 / 失焦 / 通关 / 菜单）时完全冻结，不在后台改图 */
  update(dtMs: number, game: Game, active: boolean): void {
    if (!active) return;

    if (this.fx.flash >= 0) {
      this.fx.flash -= dtMs / DYNAMIC_FLASH_MS;
      if (this.fx.flash <= 0) this.fx.flash = -1;
    }

    if (this.pending === null) {
      this.timerMs += dtMs;
      if (this.timerMs >= DYNAMIC_INTERVAL_MS) {
        this.timerMs = 0;
        this.attemptSwitch(game);
      }
      return;
    }

    const pending = this.pending;
    pending.ms += dtMs;

    if (pending.phase === 'warn') {
      this.fx.pulse = 0.5 - 0.5 * Math.cos((pending.ms / DYNAMIC_PULSE_MS) * Math.PI * 2);
      if (pending.ms >= DYNAMIC_WARN_MS) this.beginAnimation(game);
      return;
    }

    this.fx.animT = Math.min(1, pending.ms / DYNAMIC_ANIM_MS);
    if (pending.ms >= DYNAMIC_ANIM_MS) this.commit(game);
  }

  // ==================== 事务式切换 ====================

  private attemptSwitch(game: Game): void {
    this.stats.attempts++;
    const order = this.modules.map((_, i) => i);
    shuffle(order, this.random);
    // 上一轮刚切过的模块排到最后，让改道位置有变化
    if (this.lastModule >= 0) {
      const at = order.indexOf(this.lastModule);
      if (at > 0) {
        order.splice(at, 1);
        order.push(this.lastModule);
      }
    }

    let relaxed: Pending | null = null;
    for (const strict of [true, false]) {
      for (const moduleIndex of order) {
        const pending = this.buildPending(moduleIndex, game, strict);
        if (pending === null) continue;
        if (strict) {
          this.startWarn(pending);
          return;
        }
        relaxed ??= pending;
      }
      if (relaxed !== null) break;
    }
    if (relaxed !== null) {
      this.startWarn(relaxed);
      return;
    }
    // 找不到合法方案就跳过本周期，不死循环
    this.stats.cancelled++;
  }

  private buildPending(moduleIndex: number, game: Game, strict: boolean): Pending | null {
    const module = this.modules[moduleIndex];
    const target: 0 | 1 = module.state === 0 ? 1 : 0;
    const cols = this.base.cols;
    const nextWalls = this.base.walls.slice();
    applyState(nextWalls, cols, module, target);
    if (!this.isSafe(nextWalls, game, closedCell(module, target), strict)) {
      this.stats.rejected++;
      return null;
    }
    const union = unionWallsOf(this.base.walls, nextWalls);
    return {
      moduleIndex,
      target,
      closing: closedCell(module, target),
      opening: openCell(module, target),
      nextWalls,
      unionWalls: union,
      phase: 'warn',
      ms: 0,
      // 动画期间玩家仍可移动，保守并集图只需保证「不压住玩家 + 仍能走到门前」；
      // 这里若沿用 strict（要求所有房间可达）会把大量合法切换退化成瞬时切换，看不到动画。
      unionSafe: this.isSafe(union, game, closedCell(module, target), false),
    };
  }

  /** 一次切换的全部安全约束：几何合法 + 不压玩家 + 玩家仍可达门前 */
  private isSafe(walls: Uint8Array, game: Game, closing: GridPos, strict: boolean): boolean {
    const next = withWalls(this.base, walls);

    if (!borderClosed(next)) return false;
    if (next.walls[cellIndex(next, next.door.col, next.door.row)] !== WALL) return false;
    if (!isWalkable(next, next.exit.col, next.exit.row)) return false;
    const approach = doorApproach(next);
    if (!isWalkable(next, approach.col, approach.row)) return false;

    // 新墙不得生成在碰撞体上，并保留安全净距
    if (cellClearance(game.x, game.y, closing.col, closing.row) < PLAYER_RADIUS + DYNAMIC_SAFE_MARGIN) return false;
    if (!isFreeAt(next, game.x, game.y, PLAYER_RADIUS)) return false;

    const from = game.cell();
    if (!isWalkable(next, from.col, from.row)) return false;
    // 玩家当前位置始终可达门前交互格：既排除被封死，也排除无出口的死房间
    if (!isReachable(next, from, next.exit)) return false;
    if (strict && !allRoomsReachableFrom(next, from)) return false;
    return true;
  }

  private startWarn(pending: Pending): void {
    this.pending = pending;
    pending.ms = 0;
    pending.phase = 'warn';
    this.lastModule = pending.moduleIndex;
    // 预警只影响画面，碰撞与探索仍读旧地图：玩家可以在预警期间继续走
    this.fx.warnCells.push(pending.closing, pending.opening);
    this.fx.ghostMaze = withWalls(this.base, pending.unionWalls);
    this.fx.pulse = 0;
    this.fx.animT = -1;
  }

  private beginAnimation(game: Game): void {
    const pending = this.pending;
    if (pending === null) return;

    // 预警期间玩家仍可移动：动画开始前必须基于最新位置复验，不能只信预警开始时的旧位置
    if (!this.isSafe(pending.nextWalls, game, pending.closing, true) &&
        !this.isSafe(pending.nextWalls, game, pending.closing, false)) {
      this.cancel();
      this.stats.cancelled++;
      return;
    }

    if (!pending.unionSafe || !this.isSafe(pending.unionWalls, game, pending.closing, false)) {
      // 并集图不安全时退化为「瞬时原子切换 + 不影响碰撞的短暂闪光」
      this.stats.fallbackAtomic++;
      this.commit(game);
      return;
    }

    pending.phase = 'anim';
    pending.ms = 0;
    this.effective = withWalls(this.base, pending.unionWalls);
    game.setMaze(this.effective);
    this.fx.pulse = -1;
    this.fx.ghostMaze = null;
    this.fx.animT = 0;
    this.fx.closing.push(pending.closing);
    this.fx.opening.push(pending.opening);
  }

  private commit(game: Game): void {
    const pending = this.pending;
    if (pending === null) return;
    const module = this.modules[pending.moduleIndex];
    module.state = pending.target;
    this.base = withWalls(this.base, pending.nextWalls);
    this.effective = this.base;
    game.setMaze(this.base);
    this.pending = null;
    clearFx(this.fx);
    this.fx.flash = 1;
    this.stats.committed++;
  }

  private cancel(): void {
    this.pending = null;
    clearFx(this.fx);
  }
}
