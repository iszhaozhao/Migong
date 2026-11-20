import { DECOR_CHANCE, DECOR_LIMITS } from './config.ts';
import { isWall, type Maze } from './maze.ts';

export type DecorKind = 'pillar' | 'altar' | 'stele' | 'rune' | 'crystal';

export type Decoration = {
  kind: DecorKind;
  x: number;
  y: number;
  w: number;
  h: number;
  notch: number;
};

function hashMaze(maze: Maze): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < maze.walls.length; i++) {
    h ^= maze.walls[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIDES: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

// 同一张地图布局确定：种子来自墙格哈希；重开不变，新迷宫重新布置。
// 只选房间格（奇,奇）：走廊与转角保持干净；起点/出口及其邻格不放装饰。
// 大件贴墙/贴角布置，房间中心与两条轴向通道始终留空，不挡路线。
export function createDecorations(maze: Maze): Decoration[] {
  const random = mulberry32(hashMaze(maze));
  const out: Decoration[] = [];
  const counts: Record<DecorKind, number> = { pillar: 0, altar: 0, stele: 0, rune: 0, crystal: 0 };
  const nearKey = (col: number, row: number): boolean => {
    for (const p of [maze.start, maze.exit]) {
      if (Math.abs(col - p.col) <= 1 && Math.abs(row - p.row) <= 1) return true;
    }
    return false;
  };

  const push = (kind: DecorKind, x: number, y: number, w: number, h: number): void => {
    out.push({ kind, x, y, w, h, notch: random() });
    counts[kind]++;
  };

  for (let row = 1; row < maze.rows - 1; row += 2) {
    for (let col = 1; col < maze.cols - 1; col += 2) {
      if (isWall(maze, col, row) || nearKey(col, row)) continue;
      const wallList = SIDES.map(([dc, dr], idx) => ({ dc, dr, idx })).filter((w) =>
        isWall(maze, col + w.dc, row + w.dr),
      );
      const open = 4 - wallList.length;
      const used = new Set<DecorKind>();
      const usedWalls = new Set<number>();
      const freeWall = (): { dc: number; dr: number; idx: number } | null => {
        const free = wallList.filter((w) => !usedWalls.has(w.idx));
        if (free.length === 0) return null;
        const w = free[Math.floor(random() * free.length)];
        usedWalls.add(w.idx);
        return w;
      };
      const cx = col + 0.5;
      const cy = row + 0.5;

      if (open >= 3) {
        // 路口房间：沿仅存墙面成对布置高石柱（门柱式组合），中央可加符文地饰
        if (wallList.length > 0) {
          const { dc, dr } = wallList[0];
          const lx = dc === 0 ? 1 : 0;
          const ly = dc === 0 ? 0 : 1;
          for (const s of [1, -1]) {
            if (counts.pillar >= DECOR_LIMITS.pillar || random() >= 0.85) continue;
            push('pillar', cx + dc * 0.28 + lx * s * 0.28, cy + dr * 0.28 + ly * s * 0.28, 0.4, 0.95);
            used.add('pillar');
          }
        }
        if (used.size < 3 && counts.rune < DECOR_LIMITS.rune && random() < DECOR_CHANCE.rune) {
          push('rune', cx, cy, 0.6, 0);
          used.add('rune');
        }
        continue;
      }

      // 普通房间：至多两件大件 + 可选地饰/晶石；大件各占一面墙，避免互相重叠
      if (counts.pillar < DECOR_LIMITS.pillar && random() < DECOR_CHANCE.pillar) {
        const w = freeWall();
        if (w) {
          const lx = w.dc === 0 ? 1 : 0;
          const ly = w.dc === 0 ? 0 : 1;
          const closed = [1, -1].filter((s) => isWall(maze, col + lx * s, row + ly * s));
          const s = closed.length > 0 ? closed[Math.floor(random() * closed.length)] : random() < 0.5 ? 1 : -1;
          push('pillar', cx + w.dc * 0.28 + lx * s * 0.28, cy + w.dr * 0.28 + ly * s * 0.28, 0.4, 0.95);
          used.add('pillar');
        }
      }
      if (used.size < 2 && counts.altar < DECOR_LIMITS.altar && random() < DECOR_CHANCE.altar) {
        const w = freeWall();
        if (w) {
          push('altar', cx + w.dc * 0.33, cy + w.dr * 0.33, 0.9, 0.4);
          used.add('altar');
        }
      }
      if (used.size < 2 && counts.stele < DECOR_LIMITS.stele && random() < DECOR_CHANCE.stele) {
        const w = freeWall();
        if (w) {
          push('stele', cx + w.dc * 0.36, cy + w.dr * 0.36, 0.44, 0.85);
          used.add('stele');
        }
      }
      if (used.size < 2 && counts.crystal < DECOR_LIMITS.crystal && random() < DECOR_CHANCE.crystal) {
        const w = freeWall();
        if (w) {
          const lx = w.dc === 0 ? 1 : 0;
          const ly = w.dc === 0 ? 0 : 1;
          const s = random() < 0.5 ? 1 : -1;
          push('crystal', cx + w.dc * 0.3 + lx * s * 0.3, cy + w.dr * 0.3 + ly * s * 0.3, 0.4, 0.5);
          used.add('crystal');
        }
      }
      if (used.size < 2 && counts.rune < DECOR_LIMITS.rune && random() < DECOR_CHANCE.rune) {
        push('rune', cx, cy, 0.6, 0);
      }
    }
  }
  return out;
}