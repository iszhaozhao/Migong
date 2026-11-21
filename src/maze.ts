import {
  DOOR,
  DOOR_APPROACH,
  EXIT,
  GEN_MAX_TRIES,
  GRID_COLS,
  GRID_ROWS,
  LOOPS_MAX,
  LOOPS_MIN,
  PATH_LEN_MAX,
  PATH_LEN_MIN,
  START,
  type GridPos,
} from './config.ts';
import { randInt, shuffle, type Random } from './random.ts';

export const WALL = 1;
export const FLOOR = 0;

export type Maze = {
  cols: number;
  rows: number;
  walls: Uint8Array;
  start: GridPos;
  /** 门前交互格：玩家站在这里面向大门按 E 开门 */
  exit: GridPos;
  /** 大门所在的墙面格：始终阻挡通行，渲染为门而不是普通砖墙 */
  door: GridPos;
};

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function cellIndex(maze: Maze, col: number, row: number): number {
  return row * maze.cols + col;
}

export function inBounds(maze: Maze, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < maze.cols && row < maze.rows;
}

export function isWall(maze: Maze, col: number, row: number): boolean {
  if (!inBounds(maze, col, row)) return true;
  return maze.walls[cellIndex(maze, col, row)] === WALL;
}

// 唯一的可走性查询入口：越界与墙（含大门）都算不可走。动态墙通过替换整份 walls 生效。
export function isWalkable(maze: Maze, col: number, row: number): boolean {
  return !isWall(maze, col, row);
}

export function isBorderCell(maze: Maze, col: number, row: number): boolean {
  return col === 0 || row === 0 || col === maze.cols - 1 || row === maze.rows - 1;
}

// 房间格：行列都为奇数，永远是地板
export function isRoomCell(col: number, row: number): boolean {
  return col % 2 === 1 && row % 2 === 1;
}

// 内部通道格：房间之间的隔墙位，是环路拆墙与动态墙模块唯一允许操作的位置
export function isCorridorCell(maze: Maze, col: number, row: number): boolean {
  if (!inBounds(maze, col, row) || isBorderCell(maze, col, row)) return false;
  return (col + row) % 2 === 1;
}

// 出口保护区：大门、门前交互格、固定连接边。任何生成与动态切换都不得改动
export function doorApproach(maze: Maze): GridPos {
  return {
    col: maze.exit.col + (maze.exit.col - maze.door.col),
    row: maze.exit.row + (maze.exit.row - maze.door.row),
  };
}

export function isProtected(maze: Maze, col: number, row: number): boolean {
  if (col === maze.door.col && row === maze.door.row) return true;
  if (col === maze.exit.col && row === maze.exit.row) return true;
  const approach = doorApproach(maze);
  return col === approach.col && row === approach.row;
}

// 门面法线：由门格指向交互格，用于「面向大门」判定与门纹理朝向
export function doorNormal(maze: Maze): GridPos {
  return { col: maze.exit.col - maze.door.col, row: maze.exit.row - maze.door.row };
}

// 门面中心点：门格与交互格共享边的中点（不是两格中心的连线中点）
export function doorFaceCenter(maze: Maze): { x: number; y: number } {
  const n = doorNormal(maze);
  return { x: maze.door.col + 0.5 + n.col * 0.5, y: maze.door.row + 0.5 + n.row * 0.5 };
}

// 点到格子（单位正方形）的净距：0 表示在格内，用于动态墙「不得生成在碰撞体上」检查
export function cellClearance(x: number, y: number, col: number, row: number): number {
  const dx = Math.max(col - x, 0, x - (col + 1));
  const dy = Math.max(row - y, 0, y - (row + 1));
  return Math.hypot(dx, dy);
}

// 圆形碰撞体是否完全落在可走格内（X/Y 分轴滑动与动态墙安全检查共用）
export function isFreeAt(maze: Maze, x: number, y: number, radius: number): boolean {
  const c0 = Math.floor(x - radius);
  const c1 = Math.floor(x + radius);
  const r0 = Math.floor(y - radius);
  const r1 = Math.floor(y + radius);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (!isWalkable(maze, col, row)) return false;
    }
  }
  return true;
}

export function withWalls(maze: Maze, walls: Uint8Array): Maze {
  return { cols: maze.cols, rows: maze.rows, walls, start: maze.start, exit: maze.exit, door: maze.door };
}

export function cloneMaze(maze: Maze): Maze {
  return withWalls(maze, maze.walls.slice());
}

export function bfsDistances(maze: Maze, from: GridPos): Int32Array {
  const total = maze.cols * maze.rows;
  const dist = new Int32Array(total).fill(-1);
  if (!isWalkable(maze, from.col, from.row)) return dist;

  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const startIndex = cellIndex(maze, from.col, from.row);
  dist[startIndex] = 0;
  queue[tail++] = startIndex;

  while (head < tail) {
    const index = queue[head++];
    const col = index % maze.cols;
    const row = (index - col) / maze.cols;
    const next = dist[index] + 1;
    for (const [dc, dr] of DIRECTIONS) {
      const nc = col + dc;
      const nr = row + dr;
      if (!isWalkable(maze, nc, nr)) continue;
      const ni = cellIndex(maze, nc, nr);
      if (dist[ni] !== -1) continue;
      dist[ni] = next;
      queue[tail++] = ni;
    }
  }
  return dist;
}

export function isReachable(maze: Maze, from: GridPos, to: GridPos): boolean {
  return bfsDistances(maze, from)[cellIndex(maze, to.col, to.row)] !== -1;
}

export function pathLength(maze: Maze, from: GridPos, to: GridPos): number {
  return bfsDistances(maze, from)[to.row * maze.cols + to.col];
}

// 从 to 回溯到 from 的方向序列（col/row 差值），用于自动验证与未来的提示功能。
export function shortestPath(maze: Maze, from: GridPos, to: GridPos): GridPos[] {
  const dist = bfsDistances(maze, from);
  const target = cellIndex(maze, to.col, to.row);
  if (dist[target] === -1) return [];

  const path: GridPos[] = [to];
  let col = to.col;
  let row = to.row;
  while (col !== from.col || row !== from.row) {
    for (const [dc, dr] of DIRECTIONS) {
      const nc = col + dc;
      const nr = row + dr;
      if (!isWalkable(maze, nc, nr)) continue;
      if (dist[cellIndex(maze, nc, nr)] === dist[cellIndex(maze, col, row)] - 1) {
        col = nc;
        row = nr;
        path.push({ col, row });
        break;
      }
    }
  }
  return path.reverse();
}

export function countWalkable(maze: Maze): number {
  let total = 0;
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (isWalkable(maze, col, row)) total++;
    }
  }
  return total;
}

export function borderClosed(maze: Maze): boolean {
  for (let col = 0; col < maze.cols; col++) {
    if (isWalkable(maze, col, 0) || isWalkable(maze, col, maze.rows - 1)) return false;
  }
  for (let row = 0; row < maze.rows; row++) {
    if (isWalkable(maze, 0, row) || isWalkable(maze, maze.cols - 1, row)) return false;
  }
  return true;
}

export function allRoomsReachableFrom(maze: Maze, from: GridPos): boolean {
  const dist = bfsDistances(maze, from);
  for (let row = 1; row < maze.rows - 1; row += 2) {
    for (let col = 1; col < maze.cols - 1; col += 2) {
      if (dist[cellIndex(maze, col, row)] === -1) return false;
    }
  }
  return true;
}

export function allRoomsReachable(maze: Maze): boolean {
  return allRoomsReachableFrom(maze, maze.start);
}

export function allWalkableReachable(maze: Maze): boolean {
  const dist = bfsDistances(maze, maze.start);
  let reachable = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] !== -1) reachable++;
  return reachable === countWalkable(maze);
}

// 连通图存在环路 <=> 边数 >= 顶点数（树恰好是 V-1 条边）
export function hasCycle(maze: Maze): boolean {
  let vertices = 0;
  let edges = 0;
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (!isWalkable(maze, col, row)) continue;
      vertices++;
      if (isWalkable(maze, col + 1, row)) edges++;
      if (isWalkable(maze, col, row + 1)) edges++;
    }
  }
  return edges >= vertices;
}

export function cycleCount(maze: Maze): number {
  let vertices = 0;
  let edges = 0;
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (!isWalkable(maze, col, row)) continue;
      vertices++;
      if (isWalkable(maze, col + 1, row)) edges++;
      if (isWalkable(maze, col, row + 1)) edges++;
    }
  }
  return edges - vertices + 1;
}

/** 地图合法性统一检查：生成重试、模板回退与自动验证共用同一份规则 */
export function validateMaze(maze: Maze): string[] {
  const problems: string[] = [];
  const push = (ok: boolean, label: string): void => {
    if (!ok) problems.push(label);
  };

  push(maze.cols === GRID_COLS && maze.rows === GRID_ROWS, `尺寸应为 ${GRID_COLS}x${GRID_ROWS}，实际 ${maze.cols}x${maze.rows}`);
  push(maze.walls.length === maze.cols * maze.rows, 'walls 长度与尺寸不符');
  push(borderClosed(maze), '外边界未封闭');
  push(maze.start.col === START.col && maze.start.row === START.row, '入口坐标被改写');
  push(maze.exit.col === EXIT.col && maze.exit.row === EXIT.row, '门前交互格坐标被改写');
  push(maze.door.col === DOOR.col && maze.door.row === DOOR.row, '大门坐标被改写');
  push(isWalkable(maze, maze.start.col, maze.start.row), '入口是墙');
  push(isWalkable(maze, maze.exit.col, maze.exit.row), '门前交互格是墙');
  push(isWall(maze, maze.door.col, maze.door.row), '大门所在墙格不是墙（门必须嵌在墙面上）');
  const approach = doorApproach(maze);
  push(isWalkable(maze, approach.col, approach.row), '大门固定连接边被封闭');
  push(isReachable(maze, maze.start, maze.exit), '入口无法到达门前交互格');
  push(allRoomsReachable(maze), '存在孤立房间');
  push(allWalkableReachable(maze), '存在不可达通路格');
  push(hasCycle(maze), '地图没有环路（仍是树形死胡同迷宫）');

  const length = pathLength(maze, maze.start, maze.exit);
  push(
    length >= PATH_LEN_MIN && length <= PATH_LEN_MAX,
    `最短路长度 ${length} 超出配置范围 [${PATH_LEN_MIN},${PATH_LEN_MAX}]`,
  );
  return problems;
}

function carvePerfectMaze(walls: Uint8Array, cols: number, rows: number, random: Random): void {
  const roomCols = (cols - 1) / 2;
  const roomRows = (rows - 1) / 2;
  const visited = new Uint8Array(roomCols * roomRows);
  const cellCol = (roomX: number): number => roomX * 2 + 1;
  const cellRow = (roomY: number): number => roomY * 2 + 1;

  visited[0] = 1;
  walls[cellRow(0) * cols + cellCol(0)] = FLOOR;
  const stack: Array<[number, number]> = [[0, 0]];

  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const order = shuffle([...DIRECTIONS], random);
    let carved = false;

    for (const [dx, dy] of order) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= roomCols || ny >= roomRows) continue;
      if (visited[ny * roomCols + nx] === 1) continue;

      visited[ny * roomCols + nx] = 1;
      walls[(cellRow(cy) + dy) * cols + (cellCol(cx) + dx)] = FLOOR;
      walls[cellRow(ny) * cols + cellCol(nx)] = FLOOR;
      stack.push([nx, ny]);
      carved = true;
      break;
    }

    if (!carved) stack.pop();
  }
}

function generateOnce(random: Random): Maze {
  const cols = GRID_COLS;
  const rows = GRID_ROWS;
  const walls = new Uint8Array(cols * rows).fill(WALL);
  carvePerfectMaze(walls, cols, rows, random);

  const maze: Maze = {
    cols,
    rows,
    walls,
    start: { col: START.col, row: START.row },
    exit: { col: EXIT.col, row: EXIT.row },
    door: { col: DOOR.col, row: DOOR.row },
  };

  // 为大门预留固定连接边：交互格西侧通道必须是地板，门永远朝向可走区域
  walls[cellIndex(maze, DOOR_APPROACH.col, DOOR_APPROACH.row)] = FLOOR;

  // 适量拆除内部隔墙形成绕行环路：只动内部通道格，不碰边界与保护区
  const candidates: number[] = [];
  for (let row = 1; row < rows - 1; row++) {
    for (let col = 1; col < cols - 1; col++) {
      if (!isCorridorCell(maze, col, row)) continue;
      if (isProtected(maze, col, row)) continue;
      if (walls[cellIndex(maze, col, row)] !== WALL) continue;
      candidates.push(cellIndex(maze, col, row));
    }
  }
  // 适量拆除内部隔墙形成绕行环路：只动内部通道格，不碰边界与保护区。
  // 以实际 cycleCount 为准（上面为大门开出的连接边也算一个环），因此环路数不会超出配置范围。
  const target = randInt(random, LOOPS_MIN, LOOPS_MAX);
  shuffle(candidates, random);
  for (const index of candidates) {
    if (cycleCount(maze) >= target) break;
    walls[index] = FLOOR;
  }

  return maze;
}

export function parseMaze(lines: string[]): Maze {
  const rows = lines.length;
  const cols = lines[0].length;
  const walls = new Uint8Array(cols * rows);
  let start: GridPos = { col: START.col, row: START.row };
  let exit: GridPos = { col: EXIT.col, row: EXIT.row };
  let door: GridPos = { col: DOOR.col, row: DOOR.row };
  lines.forEach((line, row) => {
    for (let col = 0; col < cols; col++) {
      const ch = line[col];
      walls[row * cols + col] = ch === '#' || ch === 'D' ? WALL : FLOOR;
      if (ch === 'S') start = { col, row };
      if (ch === 'E') exit = { col, row };
      if (ch === 'D') door = { col, row };
    }
  });
  return { cols, rows, walls, start, exit, door };
}

export function mazeToAscii(maze: Maze): string[] {
  const lines: string[] = [];
  for (let row = 0; row < maze.rows; row++) {
    let line = '';
    for (let col = 0; col < maze.cols; col++) {
      if (col === maze.door.col && row === maze.door.row) line += 'D';
      else if (col === maze.start.col && row === maze.start.row) line += 'S';
      else if (col === maze.exit.col && row === maze.exit.row) line += 'E';
      else line += maze.walls[cellIndex(maze, col, row)] === WALL ? '#' : '.';
    }
    lines.push(line);
  }
  return lines;
}

/** 生成失败时使用的固定模板：必须通过 validateMaze 的同一套检查（S 入口 / E 门前交互格 / D 大门墙格） */
export const FALLBACK_TEMPLATE: readonly string[] = [
  '#####################',
  '#S..#.....#.........#',
  '###.#.###.#.#.#####.#',
  '#...#.#...#.........#',
  '#.#.#.#.###.#.#####.#',
  '#...#.#.#.#.#...#...#',
  '#.###.#.#.#.###.#.#.#',
  '#.....#.#.........#.#',
  '#.#####.#.#####.###.#',
  '#.....#.#.#...#.#...#',
  '#.#####.#.#.#.###.#.#',
  '#...#...#.#.#.....#.#',
  '#.#.#.#####.#.#####.#',
  '#.#.........#......ED',
  '#####################',
];

export function fallbackMaze(): Maze {
  if (FALLBACK_TEMPLATE.length === 0) {
    throw new Error('FALLBACK_TEMPLATE 尚未填入');
  }
  return parseMaze([...FALLBACK_TEMPLATE]);
}

export type GenerateResult = { maze: Maze; tries: number; usedFallback: boolean };

export function generateMazeWithInfo(random: Random = Math.random): GenerateResult {
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= GEN_MAX_TRIES; attempt++) {
    const candidate = generateOnce(random);
    lastProblems = validateMaze(candidate);
    if (lastProblems.length === 0) return { maze: candidate, tries: attempt, usedFallback: false };
  }
  const template = fallbackMaze();
  const problems = validateMaze(template);
  if (problems.length > 0) {
    throw new Error(`固定模板未通过检查：${problems.join('；')}（最后一次随机失败：${lastProblems.join('；')}）`);
  }
  return { maze: template, tries: GEN_MAX_TRIES, usedFallback: true };
}

export function generateMaze(random: Random = Math.random): Maze {
  return generateMazeWithInfo(random).maze;
}
