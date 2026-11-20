import { EXIT, GRID_COLS, GRID_ROWS, MOVE_SPEED, PLAYER_RADIUS, START, type GridPos } from '../src/config.ts';
import { Exploration } from '../src/exploration.ts';
import { Game, normalizeAngle, type InputState } from '../src/game.ts';
import {
  bfsDistances,
  generateMaze,
  inBounds,
  isWalkable,
  pathLength,
  shortestPath,
  type Maze,
  type Random,
} from '../src/maze.ts';

const MAZE_COUNT = Number(process.argv[2] ?? 100);
const DT = 1 / 60;

let checks = 0;
const failures: string[] = [];

function check(condition: boolean, label: string): void {
  checks++;
  if (!condition) failures.push(label);
}

function section(title: string): void {
  process.stdout.write(`\n== ${title} ==\n`);
}

function report(ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${detail}\n`);
}

function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseMaze(lines: string[]): Maze {
  const rows = lines.length;
  const cols = lines[0].length;
  const walls = new Uint8Array(cols * rows);
  let start: GridPos = { col: 1, row: 1 };
  let exit: GridPos = { col: 1, row: 1 };
  lines.forEach((line, row) => {
    for (let col = 0; col < cols; col++) {
      const ch = line[col];
      walls[row * cols + col] = ch === '#' ? 1 : 0;
      if (ch === 'S') start = { col, row };
      if (ch === 'E') exit = { col, row };
    }
  });
  return { cols, rows, walls, start, exit };
}

function countWalkable(maze: Maze): number {
  let total = 0;
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (isWalkable(maze, col, row)) total++;
    }
  }
  return total;
}

function borderClosed(maze: Maze): boolean {
  for (let col = 0; col < maze.cols; col++) {
    if (isWalkable(maze, col, 0) || isWalkable(maze, col, maze.rows - 1)) return false;
  }
  for (let row = 0; row < maze.rows; row++) {
    if (isWalkable(maze, 0, row) || isWalkable(maze, maze.cols - 1, row)) return false;
  }
  return true;
}

function allRoomsReachable(maze: Maze): boolean {
  const dist = bfsDistances(maze, maze.start);
  for (let ry = 0; ry < (maze.rows - 1) / 2; ry++) {
    for (let rx = 0; rx < (maze.cols - 1) / 2; rx++) {
      if (dist[(ry * 2 + 1) * maze.cols + (rx * 2 + 1)] === -1) return false;
    }
  }
  return true;
}

// 用真实 Game.update + 转向/前进输入沿 BFS 最短路自动驾驶到出口
function autopilot(maze: Maze, dt: number, withExploration: boolean, budgetSec = 120) {
  const game = new Game(maze);
  const exploration = withExploration ? new Exploration(maze) : null;
  const path = shortestPath(maze, maze.start, maze.exit);
  const waypoints = path.slice(1).map((p) => ({ x: p.col + 0.5, y: p.row + 0.5 }));
  const input: InputState = { forward: 0, turn: 0 };
  let seconds = 0;
  let wi = 0;

  while (!game.won && seconds < budgetSec && wi < waypoints.length) {
    const wp = waypoints[wi];
    const dx = wp.x - game.x;
    const dy = wp.y - game.y;
    if (Math.hypot(dx, dy) < 0.35) {
      wi++;
      continue;
    }
    const diff = normalizeAngle(Math.atan2(dy, dx) - game.angle);
    input.turn = Math.max(-1, Math.min(1, diff * 5));
    input.forward = Math.abs(diff) < 0.5 ? 1 : 0.3;
    game.update(dt, input);
    if (exploration) exploration.update(maze, game.x, game.y, game.angle);
    seconds += dt;
  }
  input.forward = 0;
  input.turn = 0;
  return { game, exploration, seconds, waypointsReached: wi, waypointsTotal: waypoints.length };
}

section(`地图生成验证 (${MAZE_COUNT} 张)`);

check(GRID_COLS === 21 && GRID_ROWS === 15, `网格尺寸应为 21x15，实际 ${GRID_COLS}x${GRID_ROWS}`);
check(START.col === 1 && START.row === 1, `入口应为 (1,1)，实际 (${START.col},${START.row})`);
check(EXIT.col === 19 && EXIT.row === 13, `出口应为 (19,13)，实际 (${EXIT.col},${EXIT.row})`);
report(GRID_COLS === 21 && GRID_ROWS === 15, `逻辑房间 10x7 -> 墙/路网格 ${GRID_COLS}x${GRID_ROWS}`);

let minPath = Number.POSITIVE_INFINITY;
let maxPath = 0;
let pathSum = 0;
let worstAutopilotSec = 0;
const distinct = new Set<string>();

for (let i = 0; i < MAZE_COUNT; i++) {
  const maze = generateMaze(mulberry32(1000 + i));
  const tag = `maze#${i}`;

  check(maze.cols === GRID_COLS && maze.rows === GRID_ROWS, `${tag} 尺寸错误 ${maze.cols}x${maze.rows}`);
  check(maze.walls.length === GRID_COLS * GRID_ROWS, `${tag} walls 长度错误`);
  check(borderClosed(maze), `${tag} 外圈未封闭`);
  check(maze.start.col === START.col && maze.start.row === START.row, `${tag} 入口坐标被改写`);
  check(maze.exit.col === EXIT.col && maze.exit.row === EXIT.row, `${tag} 出口坐标被改写`);
  check(inBounds(maze, maze.start.col, maze.start.row) && inBounds(maze, maze.exit.col, maze.exit.row), `${tag} 起终点越界`);
  check(isWalkable(maze, maze.start.col, maze.start.row), `${tag} 入口是墙`);
  check(isWalkable(maze, maze.exit.col, maze.exit.row), `${tag} 出口是墙`);

  const length = pathLength(maze, maze.start, maze.exit);
  check(length > 0, `${tag} BFS 不可达`);
  check(allRoomsReachable(maze), `${tag} 存在孤立房间`);
  check(countWalkable(maze) === bfsDistances(maze, maze.start).filter((d) => d !== -1).length, `${tag} 存在不可达通路格`);

  const run = autopilot(maze, DT, i === 0);
  check(run.game.won, `${tag} 自动驾驶未能走到出口（${run.seconds.toFixed(1)}s，waypoint ${run.waypointsReached}/${run.waypointsTotal}）`);
  check(run.game.free(run.game.x, run.game.y), `${tag} 通关时玩家处于墙内`);
  if (run.exploration) {
    check(run.exploration.exitSeen, `${tag} 通关时迷雾仍未记录出口可见`);
    const explored = run.exploration.explored.reduce((a, b) => a + b, 0);
    check(explored >= countWalkable(maze) * 0.15, `${tag} 通关时探索比例过低 (${explored})`);
  }

  distinct.add(maze.walls.join(''));
  minPath = Math.min(minPath, length);
  maxPath = Math.max(maxPath, length);
  pathSum += length;
  worstAutopilotSec = Math.max(worstAutopilotSec, run.seconds);
}

report(failures.length === 0, `${MAZE_COUNT} 张地图：尺寸/边界/起终点/BFS 可达/连续移动自动通关 全部通过`);
report(distinct.size === MAZE_COUNT, `随机性：${distinct.size}/${MAZE_COUNT} 张地图互不相同`);
process.stdout.write(
  `最短路 min=${minPath} max=${maxPath} avg=${(pathSum / MAZE_COUNT).toFixed(1)} 格；自动驾驶最慢 ${worstAutopilotSec.toFixed(1)}s（行走速度 ${MOVE_SPEED} 格/秒）\n`,
);

section('连续移动与碰撞验证');

let slideMaze: Maze | null = null;
for (let seed = 1; seed < 300 && slideMaze === null; seed++) {
  const candidate = generateMaze(mulberry32(seed));
  if (isWalkable(candidate, 2, 1)) slideMaze = candidate;
}
check(slideMaze !== null, '找不到起点向东开放的测试地图');
const maze = slideMaze ?? generateMaze(mulberry32(1));

const wallGame = new Game(maze);
wallGame.angle = -Math.PI / 2;
for (let i = 0; i < 120; i++) {
  wallGame.update(DT, { forward: 1, turn: 0 });
  check(wallGame.free(wallGame.x, wallGame.y), `撞墙过程中进入墙内 (i=${i})`);
  check(wallGame.y - PLAYER_RADIUS >= 1 - 1e-9, `圆形碰撞体侵入北墙 (i=${i}, y=${wallGame.y})`);
}
check(wallGame.x === 1.5 && wallGame.y < 1.5 && wallGame.y >= 1.5 - PLAYER_RADIUS - 0.08, `正对北墙前进 2s 后应停在接触距离，实际 (${wallGame.x},${wallGame.y})`);
report(wallGame.x === 1.5 && wallGame.y >= 1.25 - 1e-9, `正对墙持续前进：停在半径接触处 y=${wallGame.y.toFixed(3)}，不进入墙内`);

const lagGame = new Game(maze);
lagGame.angle = -Math.PI / 2;
for (let i = 0; i < 40; i++) {
  lagGame.update(0.25, { forward: 1, turn: 0 });
  check(lagGame.free(lagGame.x, lagGame.y), `大时间增量下穿墙 (i=${i})`);
  check(lagGame.y - PLAYER_RADIUS >= 1 - 1e-9, `大时间增量下侵入墙内 (i=${i}, y=${lagGame.y})`);
}
check(lagGame.y >= 1.5 - PLAYER_RADIUS - 1e-9, `dt=0.25s 卡顿模拟后穿墙，y=${lagGame.y}`);
report(lagGame.y >= 1.25 - 1e-9, `dt=0.25s 卡顿模拟 40 次：子步限制生效，未穿墙 (y=${lagGame.y.toFixed(3)})`);

const slideGame = new Game(maze);
slideGame.angle = -Math.PI / 4;
for (let i = 0; i < 60; i++) {
  slideGame.update(DT, { forward: 1, turn: 0 });
  check(slideGame.free(slideGame.x, slideGame.y), '斜向贴墙后进入墙内');
  check(slideGame.y - PLAYER_RADIUS >= 1 - 1e-9, '斜向贴墙时侵入北墙');
}
check(slideGame.x > 2.2, `斜向贴墙未产生滑动，x=${slideGame.x}`);
check(slideGame.y < 1.5 && slideGame.y >= 1.25 - 1e-9, `斜向贴墙时 Y 轴应被墙挡住，y=${slideGame.y}`);
report(slideGame.x > 2.2 && slideGame.y >= 1.25 - 1e-9, `45° 撞墙可沿墙滑动：X 前进到 ${slideGame.x.toFixed(2)}、Y 停在接触处 ${slideGame.y.toFixed(3)}`);

const cornerMaze = parseMaze(['#####', '#S#.#', '#.#.#', '#...#', '#####']);
const cornerGame = new Game(cornerMaze);
cornerGame.angle = Math.PI / 4;
let enteredDiagonal = false;
for (let i = 0; i < 120; i++) {
  cornerGame.update(DT, { forward: 1, turn: 0 });
  if (Math.floor(cornerGame.x) === 2 && Math.floor(cornerGame.y) === 2) enteredDiagonal = true;
  check(cornerGame.free(cornerGame.x, cornerGame.y), '钻墙角过程中进入墙内');
}
check(!enteredDiagonal, '玩家切过内墙角进入对角格 (2,2)');
check(cornerGame.x < 1.75 + 1e-6 && cornerGame.y < 1.75 + 1e-6, `对角移动超出半径接触范围 (${cornerGame.x},${cornerGame.y})`);
report(!enteredDiagonal, '内墙角对角线：X/Y 分轴检测阻止钻墙角，始终未进入对角格');

const openGame30 = new Game(maze);
const openGame144 = new Game(maze);
for (let i = 0; i < 30; i++) openGame30.update(1 / 30, { forward: 1, turn: 0 });
for (let i = 0; i < 144; i++) openGame144.update(1 / 144, { forward: 1, turn: 0 });
const drift = Math.hypot(openGame30.x - openGame144.x, openGame30.y - openGame144.y);
check(drift < 1e-9, `30fps 与 144fps 行走 1s 位置不一致，偏差 ${drift}`);
check(Math.abs(openGame30.x - 1.5 - MOVE_SPEED) < 0.01 || openGame30.x < 1.5 + MOVE_SPEED, '行走距离异常');
report(drift < 1e-9, `30fps 与 144fps 同走 1s 位置完全一致（偏差 ${drift.toExponential(1)}）`);

const turnGame = new Game(maze);
const angleBefore = turnGame.angle;
turnGame.update(0.5, { forward: 0, turn: 1 });
check(Math.abs(normalizeAngle(turnGame.angle - angleBefore) - 0.5 * 2.8) < 1e-9, '转向角度与时间增量不成比例');
report(true, '转向按时间增量计算（0.5s × TURN_SPEED）');

section('战争迷雾遮挡验证（固定直角走廊图）');

const corridor = parseMaze(['#######', '#S#...#', '#####.#', '#####.#', '#####E#', '#######']);
const cGame = new Game(corridor);
const cExp = new Exploration(corridor);
cGame.x = corridor.start.col + 0.5;
cGame.y = corridor.start.row + 0.5;
cGame.angle = 0;
cExp.update(corridor, cGame.x, cGame.y, cGame.angle);

check(cExp.isVisible(corridor, 1, 1), '出生点脚下未揭示');
check(cExp.isVisible(corridor, 2, 1), '正对的第一块墙未揭示');
check(!cExp.isVisible(corridor, 3, 1), '墙后的道路被提前揭示（隔墙偷看）');
check(!cExp.isVisible(corridor, 5, 1), '视野外同走廊远端被揭示');
check(!cExp.isVisible(corridor, 5, 2), '转角后的道路被提前揭示');
check(!cExp.isVisible(corridor, 5, 4) && !cExp.exitSeen, '未看见的出口被提前标记');
report(
  !cExp.isVisible(corridor, 3, 1) && !cExp.isVisible(corridor, 5, 2) && !cExp.exitSeen,
  '初始朝东：墙后道路、转角后道路、出口均不显示',
);

const exploredAfterStart = cExp.explored.reduce((a, b) => a + b, 0);
check(exploredAfterStart <= 6, `出生揭示范围过大 (${exploredAfterStart} 格)`);
report(exploredAfterStart <= 6, `出生仅揭示初始视野 ${exploredAfterStart} 格（非整片房间）`);

cGame.x = 5.5;
cGame.y = 1.5;
cGame.angle = Math.PI / 2;
cExp.update(corridor, cGame.x, cGame.y, cGame.angle);
check(cExp.isVisible(corridor, 5, 2) && cExp.isVisible(corridor, 5, 3) && cExp.isVisible(corridor, 5, 4), '转向南后转角走廊未揭示');
check(cExp.exitSeen, '看见出口后 exitSeen 未置位');
check(!cExp.isVisible(corridor, 1, 1), '身后旧区域不应仍标记为当前可见');
check(cExp.isExplored(corridor, 1, 1) && cExp.isExplored(corridor, 2, 1), '曾探索区域离开视野后记录丢失');
check(!cExp.isExplored(corridor, 3, 1), '从未看见的墙后格被记为已探索');
report(cExp.exitSeen && cExp.isExplored(corridor, 1, 1), '转弯观察后转角与出口出现，旧探索记录保留');

cGame.angle = -Math.PI / 2;
cExp.update(corridor, cGame.x, cGame.y, cGame.angle);
check(cExp.exitSeen, 'exitSeen 不应在离开视野后被清除');
check(cExp.isExplored(corridor, 5, 4), '出口探索记录不应丢失');
report(true, '出口标记发现后永久保留（本局内）');

const beforeReset = cExp.explored.reduce((a, b) => a + b, 0);
cExp.reset();
cGame.reset();
check(cExp.explored.reduce((a, b) => a + b, 0) === 0 && !cExp.exitSeen, 'reset 未清空探索记录');
check(cGame.x === corridor.start.col + 0.5 && cGame.y === corridor.start.row + 0.5, 'reset 未回到起点');
report(beforeReset > 0, `重新开始清空探索记录（${beforeReset} 格 -> 0）并回到起点`);

const fogRandom = autopilot(generateMaze(mulberry32(4242)), DT, true);
check(fogRandom.exploration !== null && fogRandom.exploration.explored.reduce((a, b) => a + b, 0) < countWalkable(fogRandom.game.maze), '迷雾揭示范围不应等于全图');
report(true, '随机地图通关后仍有未探索区域（迷雾非全图揭开）');

section('结果');

if (failures.length > 0) {
  process.stdout.write(`FAIL  ${failures.length}/${checks} 项检查未通过：\n`);
  for (const failure of failures.slice(0, 40)) process.stdout.write(`  - ${failure}\n`);
  if (failures.length > 40) process.stdout.write(`  - ...另有 ${failures.length - 40} 项\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`PASS  全部 ${checks} 项检查通过（${MAZE_COUNT} 张地图自动驾驶 + 碰撞/子步/帧率 + 迷雾遮挡）\n`);
}
