import { EXIT, GRID_COLS, GRID_ROWS, START, type GridPos } from './config.ts';

export type Random = () => number;

export type Maze = {
  cols: number;
  rows: number;
  walls: Uint8Array;
  start: GridPos;
  exit: GridPos;
};

const WALL = 1;
const FLOOR = 0;

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function inBounds(maze: Maze, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < maze.cols && row < maze.rows;
}

export function isWall(maze: Maze, col: number, row: number): boolean {
  if (!inBounds(maze, col, row)) return true;
  return maze.walls[row * maze.cols + col] === WALL;
}

// 唯一的可走性查询入口：越界与墙都算不可走。未来加入动态墙时只需改这里。
export function isWalkable(maze: Maze, col: number, row: number): boolean {
  return !isWall(maze, col, row);
}

export function bfsDistances(maze: Maze, from: GridPos): Int32Array {
  const total = maze.cols * maze.rows;
  const dist = new Int32Array(total).fill(-1);
  if (!isWalkable(maze, from.col, from.row)) return dist;

  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const startIndex = from.row * maze.cols + from.col;
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
      const ni = nr * maze.cols + nc;
      if (dist[ni] !== -1) continue;
      dist[ni] = next;
      queue[tail++] = ni;
    }
  }
  return dist;
}

export function isReachable(maze: Maze, from: GridPos, to: GridPos): boolean {
  return bfsDistances(maze, from)[to.row * maze.cols + to.col] !== -1;
}

export function pathLength(maze: Maze, from: GridPos, to: GridPos): number {
  return bfsDistances(maze, from)[to.row * maze.cols + to.col];
}

// 从 to 回溯到 from 的方向序列（col/row 差值），用于自动验证与未来的提示功能。
export function shortestPath(maze: Maze, from: GridPos, to: GridPos): GridPos[] {
  const dist = bfsDistances(maze, from);
  const target = to.row * maze.cols + to.col;
  if (dist[target] === -1) return [];

  const path: GridPos[] = [to];
  let col = to.col;
  let row = to.row;
  while (col !== from.col || row !== from.row) {
    for (const [dc, dr] of DIRECTIONS) {
      const nc = col + dc;
      const nr = row + dr;
      if (!isWalkable(maze, nc, nr)) continue;
      if (dist[nr * maze.cols + nc] === dist[row * maze.cols + col] - 1) {
        col = nc;
        row = nr;
        path.push({ col, row });
        break;
      }
    }
  }
  return path.reverse();
}

function shuffle<T>(items: T[], random: Random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function generateMaze(random: Random = Math.random): Maze {
  const cols = GRID_COLS;
  const rows = GRID_ROWS;
  const walls = new Uint8Array(cols * rows).fill(WALL);

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

  const maze: Maze = {
    cols,
    rows,
    walls,
    start: { col: START.col, row: START.row },
    exit: { col: EXIT.col, row: EXIT.row },
  };

  if (!isReachable(maze, maze.start, maze.exit)) {
    throw new Error(`generated maze is unsolvable: start=${maze.start} exit=${maze.exit}`);
  }
  return maze;
}
