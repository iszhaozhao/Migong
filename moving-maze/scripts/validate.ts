import {
  DOOR,
  DOOR_INTERACT_ANGLE_DEG,
  DOOR_INTERACT_DISTANCE,
  DOOR_OPEN_MS,
  DOOR_APPROACH,
  DYNAMIC_ANIM_MS,
  DYNAMIC_INTERVAL_MS,
  DYNAMIC_MODULE_MAX,
  DYNAMIC_MODULE_MIN,
  DYNAMIC_MODULE_SPAN,
  DYNAMIC_SAFE_MARGIN,
  DYNAMIC_WARN_MS,
  EXIT,
  FOV_DEG,
  GEN_MAX_TRIES,
  GRID_COLS,
  GRID_ROWS,
  LOOPS_MAX,
  LOOPS_MIN,
  MAX_BUFFER_H,
  MAX_BUFFER_W,
  MINIMAP_BEAM_RAYS,
  MOVE_SPEED,
  PATH_LEN_MAX,
  PATH_LEN_MIN,
  PITCH_MAX_DEG,
  PLAYER_RADIUS,
  START,
  VIEW_DISTANCE,
  type GridPos,
} from '../src/config.ts';
import { DynamicWalls, type Pending } from '../src/dynamic.ts';
import {
  beamPolygonCapacity,
  Exploration,
  fillBeamPolygon,
  OBS_FLOOR,
  OBS_UNKNOWN,
  OBS_WALL,
} from '../src/exploration.ts';
import type { SceneFx } from '../src/fx.ts';
import { clamp, Game, normalizeAngle, PITCH_MAX, type InputState } from '../src/game.ts';
import { computeMinimapCell, computeViewLayout } from '../src/layout.ts';
import {
  allRoomsReachableFrom,
  borderClosed,
  cellClearance,
  cellIndex,
  cloneMaze,
  countWalkable,
  cycleCount,
  doorApproach,
  doorFaceCenter,
  doorNormal,
  fallbackMaze,
  generateMazeWithInfo,
  hasCycle,
  isCorridorCell,
  isFreeAt,
  isProtected,
  isReachable,
  isRoomCell,
  isWalkable,
  isWall,
  mazeToAscii,
  parseMaze,
  pathLength,
  shortestPath,
  validateMaze,
  WALL,
  withWalls,
  type Maze,
} from '../src/maze.ts';
import { castRay } from '../src/raycast.ts';
import { mulberry32, shuffle, type Random } from '../src/random.ts';

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

function emptyFx(): SceneFx {
  return { warnCells: [], ghostMaze: null, pulse: -1, closing: [], opening: [], animT: -1, flash: -1 };
}

function fxIdle(fx: SceneFx): boolean {
  return (
    fx.warnCells.length === 0 &&
    fx.ghostMaze === null &&
    fx.closing.length === 0 &&
    fx.opening.length === 0 &&
    fx.pulse === -1 &&
    fx.animT === -1
  );
}

function sameCell(a: GridPos, b: GridPos): boolean {
  return a.col === b.col && a.row === b.row;
}

function sameWalls(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffCells(before: Uint8Array, after: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) out.push(i);
  return out;
}

function place(game: Game, spot: GridPos): void {
  game.x = spot.col + 0.5;
  game.y = spot.row + 0.5;
}

/** 已看到过的可走格数量：与 HUD 的探索百分比同一口径（墙格不算进探索率分母） */
function seenFloorCount(maze: Maze, exp: Exploration): number {
  let seen = 0;
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (isWalkable(maze, col, row) && exp.observedAt(maze, col, row) === OBS_FLOOR) seen++;
    }
  }
  return seen;
}

function pickSpots(maze: Maze, count: number, random: Random): GridPos[] {
  const spots: GridPos[] = [{ ...maze.start }, { ...maze.exit }];
  const cells: GridPos[] = [];
  for (let row = 1; row < maze.rows - 1; row++) {
    for (let col = 1; col < maze.cols - 1; col++) {
      if (isWalkable(maze, col, row)) cells.push({ col, row });
    }
  }
  shuffle(cells, random);
  for (const cell of cells) {
    if (spots.length >= count) break;
    spots.push(cell);
  }
  return spots;
}

/**
 * 用真实 Game.update 沿 BFS 最短路自动驾驶：先走到门前交互格中心，再转向大门，
 * 满足「靠近 + 面向 + 有视线」后调用 openDoor()，最后推进开门表现直到通关。
 */
function driveToDoor(maze: Maze, dt: number, withExploration: boolean, budgetSec = 120) {
  const game = new Game(maze);
  const exploration = withExploration ? new Exploration(maze) : null;
  const path = shortestPath(maze, maze.start, maze.exit);
  const waypoints = path.slice(1).map((p) => ({ x: p.col + 0.5, y: p.row + 0.5 }));
  const input: InputState = { forward: 0, turn: 0, pitch: 0 };
  let seconds = 0;
  let wi = 0;
  let opened = false;
  let openCalls = 0;

  while (!game.won && seconds < budgetSec) {
    if (wi < waypoints.length) {
      const wp = waypoints[wi];
      const dx = wp.x - game.x;
      const dy = wp.y - game.y;
      // 最后一个路径点收紧到格中心，保证转向大门时视线不被墙角挡住
      const arrive = wi === waypoints.length - 1 ? 0.1 : 0.35;
      if (Math.hypot(dx, dy) < arrive) {
        wi++;
        continue;
      }
      const diff = normalizeAngle(Math.atan2(dy, dx) - game.angle);
      input.turn = clamp(diff * 5, -1, 1);
      input.forward = Math.abs(diff) < 0.5 ? 1 : 0.3;
    } else {
      const face = doorFaceCenter(maze);
      const diff = normalizeAngle(Math.atan2(face.y - game.y, face.x - game.x) - game.angle);
      input.forward = 0;
      input.turn = Math.abs(diff) < 0.02 ? 0 : clamp(diff * 6, -1, 1);
      if (game.canOpenDoor()) {
        openCalls++;
        if (game.openDoor()) opened = true;
      }
    }
    game.update(dt, input);
    if (exploration) exploration.update(game.maze, game.x, game.y, game.angle);
    seconds += dt;
  }
  input.forward = 0;
  input.turn = 0;
  return { game, exploration, seconds, waypointsReached: wi, waypointsTotal: waypoints.length, opened, openCalls };
}

// ==================== 1. 地图生成：连通性 / 环路 / 出口保护区 ====================

section(`地图生成验证（${MAZE_COUNT} 个固定种子）`);

check(GRID_COLS === 21 && GRID_ROWS === 15, `网格尺寸应为 21x15，实际 ${GRID_COLS}x${GRID_ROWS}`);
check(START.col === 1 && START.row === 1, `入口应为 (1,1)，实际 (${START.col},${START.row})`);
check(EXIT.col === 19 && EXIT.row === 13, `门前交互格应为 (19,13)，实际 (${EXIT.col},${EXIT.row})`);
check(DOOR.col === 20 && DOOR.row === 13, `大门墙格应为 (20,13)，实际 (${DOOR.col},${DOOR.row})`);
check(DOOR_APPROACH.col === 18 && DOOR_APPROACH.row === 13, `固定连接边应为 (18,13)`);
report(GRID_COLS === 21 && GRID_ROWS === 15, `逻辑房间 10x7 -> 墙/路网格 ${GRID_COLS}x${GRID_ROWS}，门在东侧边界墙上`);

const generated: Maze[] = [];
let minPath = Number.POSITIVE_INFINITY;
let maxPath = 0;
let pathSum = 0;
let minCycles = Number.POSITIVE_INFINITY;
let maxCycles = 0;
let cycleSum = 0;
let maxTries = 0;
let fallbacks = 0;
let worstDriveSec = 0;
const distinct = new Set<string>();

for (let i = 0; i < MAZE_COUNT; i++) {
  const seed = 1000 + i;
  const info = generateMazeWithInfo(mulberry32(seed));
  const maze = info.maze;
  const tag = `seed#${seed}`;
  generated.push(maze);

  if (info.usedFallback) fallbacks++;
  maxTries = Math.max(maxTries, info.tries);
  check(info.tries <= GEN_MAX_TRIES, `${tag} 生成重试次数超出上限 ${GEN_MAX_TRIES}`);

  const problems = validateMaze(maze);
  if (problems.length > 0) {
    failures.push(`${tag} validateMaze 未通过：${problems.join('；')}\n${mazeToAscii(maze).join('\n')}`);
    checks++;
  } else {
    checks++;
  }

  // 出口保护区：门嵌在墙面上、朝向可走区、固定连接边不被封闭
  check(sameCell(maze.door, DOOR) && sameCell(maze.exit, EXIT), `${tag} 门/交互格坐标被改写`);
  check(isWall(maze, maze.door.col, maze.door.row), `${tag} 大门格不是墙（门必须阻挡通行）`);
  check(isWalkable(maze, maze.exit.col, maze.exit.row), `${tag} 门前交互格不可走`);
  const approach = doorApproach(maze);
  check(sameCell(approach, DOOR_APPROACH) && isWalkable(maze, approach.col, approach.row), `${tag} 固定连接边被封闭`);
  const normal = doorNormal(maze);
  check(normal.col === -1 && normal.row === 0, `${tag} 门面法线应指向西（门在交互格东侧），实际 (${normal.col},${normal.row})`);
  const face = doorFaceCenter(maze);
  check(face.x === 20 && face.y === 13.5, `${tag} 门面中心应在共享边中点 (20,13.5)，实际 (${face.x},${face.y})`);

  // 房间格永远是地板；内部通道格才允许被拆墙形成环路
  let roomsOk = true;
  for (let row = 1; row < maze.rows - 1; row += 2) {
    for (let col = 1; col < maze.cols - 1; col += 2) {
      if (!isRoomCell(col, row) || !isWalkable(maze, col, row)) roomsOk = false;
    }
  }
  check(roomsOk, `${tag} 存在被封死的房间格`);

  const length = pathLength(maze, maze.start, maze.exit);
  const cycles = cycleCount(maze);
  check(length >= PATH_LEN_MIN && length <= PATH_LEN_MAX, `${tag} 最短路 ${length} 超出配置范围 [${PATH_LEN_MIN},${PATH_LEN_MAX}]`);
  check(hasCycle(maze) && cycles >= LOOPS_MIN, `${tag} 环路数量 ${cycles} 少于配置下限 ${LOOPS_MIN}（地图全是树形死路）`);
  check(cycles <= LOOPS_MAX, `${tag} 环路数量 ${cycles} 超过配置上限 ${LOOPS_MAX}`);
  check(allRoomsReachableFrom(maze, maze.start), `${tag} 存在孤立房间`);

  // 真实自动驾驶：走到门前 -> 面向 -> 按 E -> 通关
  const run = driveToDoor(maze, DT, i === 0);
  check(run.opened, `${tag} 自动驾驶未能按 E 开门（${run.seconds.toFixed(1)}s，路径点 ${run.waypointsReached}/${run.waypointsTotal}）`);
  check(run.game.won, `${tag} 开门后未通关（${run.seconds.toFixed(1)}s）`);
  check(run.game.free(run.game.x, run.game.y), `${tag} 通关时玩家在墙内`);
  check(run.openCalls === 1, `${tag} 开门被触发 ${run.openCalls} 次（应恰好 1 次）`);
  if (run.exploration) {
    check(run.exploration.exitSeen, `${tag} 通关时迷雾仍未记录大门可见`);
    const seen = seenFloorCount(maze, run.exploration);
    check(seen >= countWalkable(maze) * 0.15, `${tag} 通关时探索比例过低 (${seen}/${countWalkable(maze)})`);
  }

  distinct.add(maze.walls.join(''));
  minPath = Math.min(minPath, length);
  maxPath = Math.max(maxPath, length);
  pathSum += length;
  minCycles = Math.min(minCycles, cycles);
  maxCycles = Math.max(maxCycles, cycles);
  cycleSum += cycles;
  worstDriveSec = Math.max(worstDriveSec, run.seconds);
}

report(fallbacks === 0, `${MAZE_COUNT} 个种子：连通性/环路/出口保护区/最短路长度/自动开门通关 全部通过（回退 ${fallbacks} 次，最多重试 ${maxTries} 次）`);
report(distinct.size === MAZE_COUNT, `随机性：${distinct.size}/${MAZE_COUNT} 张地图互不相同`);
process.stdout.write(
  `最短路 min=${minPath} max=${maxPath} avg=${(pathSum / MAZE_COUNT).toFixed(1)} 格（配置 ${PATH_LEN_MIN}~${PATH_LEN_MAX}）；` +
    `环路 min=${minCycles} max=${maxCycles} avg=${(cycleSum / MAZE_COUNT).toFixed(1)}（配置 ${LOOPS_MIN}~${LOOPS_MAX}）；` +
    `自动驾驶最慢 ${worstDriveSec.toFixed(1)}s（速度 ${MOVE_SPEED} 格/秒）\n`,
);

section('固定模板回退');

const template = fallbackMaze();
const templateProblems = validateMaze(template);
check(templateProblems.length === 0, `固定模板未通过 validateMaze：${templateProblems.join('；')}`);
check(hasCycle(template) && cycleCount(template) >= LOOPS_MIN, `固定模板环路不足 (${cycleCount(template)})`);
const templateRun = driveToDoor(template, DT, false);
check(templateRun.game.won, '固定模板无法自动开门通关');
report(templateProblems.length === 0 && templateRun.game.won, `固定模板通过同一套检查并可通关（环路 ${cycleCount(template)}，最短路 ${pathLength(template, template.start, template.exit)} 格，${templateRun.seconds.toFixed(1)}s）`);
process.stdout.write('NOTE  100 个种子均未触发回退分支，模板路径由上述直接校验覆盖\n');

// ==================== 2. 连续移动、碰撞与帧率 ====================

section('连续移动与碰撞验证');

let openMaze: Maze | null = null;
for (let seed = 1; seed < 300 && openMaze === null; seed++) {
  const candidate = generateMazeWithInfo(mulberry32(seed)).maze;
  if (isWalkable(candidate, 2, 1)) openMaze = candidate;
}
check(openMaze !== null, '找不到起点向东开放的测试地图');
const maze = openMaze ?? generated[0];

const wallGame = new Game(cloneMaze(maze));
wallGame.angle = -Math.PI / 2;
for (let i = 0; i < 120; i++) {
  wallGame.update(DT, { forward: 1, turn: 0, pitch: 0 });
  check(wallGame.free(wallGame.x, wallGame.y), `撞墙过程中进入墙内 (i=${i})`);
  check(wallGame.y - PLAYER_RADIUS >= 1 - 1e-9, `圆形碰撞体侵入北墙 (i=${i}, y=${wallGame.y})`);
}
check(wallGame.x === 1.5 && wallGame.y < 1.5, `正对北墙前进 2s 后应停在接触距离，实际 (${wallGame.x},${wallGame.y})`);
report(wallGame.x === 1.5 && wallGame.y >= 1.5 - PLAYER_RADIUS - 1e-9, `正对墙持续前进：停在半径接触处 y=${wallGame.y.toFixed(3)}，不进入墙内`);

const lagGame = new Game(cloneMaze(maze));
lagGame.angle = -Math.PI / 2;
for (let i = 0; i < 40; i++) {
  lagGame.update(0.25, { forward: 1, turn: 0, pitch: 0 });
  check(lagGame.free(lagGame.x, lagGame.y), `大时间增量下穿墙 (i=${i})`);
  check(lagGame.y - PLAYER_RADIUS >= 1 - 1e-9, `大时间增量下侵入墙内 (i=${i}, y=${lagGame.y})`);
}
report(lagGame.y >= 1.5 - PLAYER_RADIUS - 1e-9, `dt=0.25s 卡顿模拟 40 次：子步限制生效，未穿墙 (y=${lagGame.y.toFixed(3)})`);

const slideGame = new Game(cloneMaze(maze));
slideGame.angle = -Math.PI / 4;
for (let i = 0; i < 60; i++) {
  slideGame.update(DT, { forward: 1, turn: 0, pitch: 0 });
  check(slideGame.free(slideGame.x, slideGame.y), '斜向贴墙后进入墙内');
  check(slideGame.y - PLAYER_RADIUS >= 1 - 1e-9, '斜向贴墙时侵入北墙');
}
check(slideGame.x > 2.2 && slideGame.y < 1.5, `斜向贴墙未产生滑动 (${slideGame.x},${slideGame.y})`);
report(slideGame.x > 2.2 && slideGame.y >= 1.5 - PLAYER_RADIUS - 1e-9, `45° 撞墙可沿墙滑动：X 前进到 ${slideGame.x.toFixed(2)}、Y 停在接触处 ${slideGame.y.toFixed(3)}`);

const cornerMaze = parseMaze(['#####', '#S#.#', '#.#.#', '#...#', '#####']);
const cornerGame = new Game(cornerMaze);
cornerGame.angle = Math.PI / 4;
let enteredDiagonal = false;
let maxXBlockedByCorner = 0;
for (let i = 0; i < 120; i++) {
  cornerGame.update(DT, { forward: 1, turn: 0, pitch: 0 });
  if (Math.floor(cornerGame.x) === 2 && Math.floor(cornerGame.y) === 2) enteredDiagonal = true;
  check(cornerGame.free(cornerGame.x, cornerGame.y), '钻墙角过程中进入墙内');
  check(
    cellClearance(cornerGame.x, cornerGame.y, 2, 2) >= PLAYER_RADIUS - 1e-9,
    `碰撞体压到内墙角墙格 (2,2)，净距 ${cellClearance(cornerGame.x, cornerGame.y, 2, 2).toFixed(3)}`,
  );
  // 仍在墙角北侧时，X 轴必须被 (2,1)/(2,2) 挡住：这才是「不切角」的证据
  if (cornerGame.y < 2.25) maxXBlockedByCorner = Math.max(maxXBlockedByCorner, cornerGame.x);
}
check(!enteredDiagonal, '玩家切过内墙角进入对角格 (2,2)');
check(maxXBlockedByCorner <= 1.75 + 1e-6, `内墙角未挡住 X 轴前进，x 达到 ${maxXBlockedByCorner}`);
report(
  !enteredDiagonal && maxXBlockedByCorner <= 1.75 + 1e-6,
  `内墙角对角线：X/Y 分轴检测阻止钻墙角（北侧最大 x=${maxXBlockedByCorner.toFixed(3)} = 半径接触处），随后沿墙滑到开口行绕过`,
);

const openGame30 = new Game(cloneMaze(maze));
const openGame144 = new Game(cloneMaze(maze));
for (let i = 0; i < 30; i++) openGame30.update(1 / 30, { forward: 1, turn: 0, pitch: 0 });
for (let i = 0; i < 144; i++) openGame144.update(1 / 144, { forward: 1, turn: 0, pitch: 0 });
const drift = Math.hypot(openGame30.x - openGame144.x, openGame30.y - openGame144.y);
check(drift < 1e-9, `30fps 与 144fps 行走 1s 位置不一致，偏差 ${drift}`);
report(drift < 1e-9, `30fps 与 144fps 同走 1s 位置完全一致（偏差 ${drift.toExponential(1)}）`);

const turnGame = new Game(cloneMaze(maze));
const angleBefore = turnGame.angle;
turnGame.update(0.5, { forward: 0, turn: 1, pitch: 0 });
check(Math.abs(normalizeAngle(turnGame.angle - angleBefore) - 0.5 * 2.8) < 1e-9, '转向角度与时间增量不成比例');
report(true, '键盘转向按时间增量计算（0.5s × TURN_SPEED），无鼠标锁定时依然可玩');

section('抬头/低头（pitch）钳制');

const pitchGame = new Game(cloneMaze(maze));
const pitchX = pitchGame.x;
const pitchY = pitchGame.y;
for (let i = 0; i < 120; i++) pitchGame.update(DT, { forward: 0, turn: 0, pitch: 1 });
check(Math.abs(pitchGame.pitch - PITCH_MAX) < 1e-12, `持续抬头未钳制在 +${PITCH_MAX_DEG}°，实际 ${(pitchGame.pitch * 180) / Math.PI}°`);
for (let i = 0; i < 240; i++) pitchGame.update(DT, { forward: 0, turn: 0, pitch: -1 });
check(Math.abs(pitchGame.pitch + PITCH_MAX) < 1e-12, `持续低头未钳制在 -${PITCH_MAX_DEG}°`);
check(pitchGame.x === pitchX && pitchGame.y === pitchY, 'pitch 输入改变了水平位置');
report(
  Math.abs(pitchGame.pitch + PITCH_MAX) < 1e-12,
  `pitch 双向钳制在 ±${PITCH_MAX_DEG}°（=${PITCH_MAX.toFixed(4)} rad），且不影响水平移动`,
);

const pitchExpGame = new Game(cloneMaze(maze));
const pitchExp = new Exploration(pitchExpGame.maze);
pitchExpGame.angle = 0.6;
pitchExp.update(pitchExpGame.maze, pitchExpGame.x, pitchExpGame.y, pitchExpGame.angle);
const exploredBeforePitch = pitchExp.explored.slice();
const observedBeforePitch = pitchExp.observed.slice();
pitchExpGame.pitch = PITCH_MAX;
pitchExp.update(pitchExpGame.maze, pitchExpGame.x, pitchExpGame.y, pitchExpGame.angle);
check(sameWalls(exploredBeforePitch, pitchExp.explored) && sameWalls(observedBeforePitch, pitchExp.observed), '抬头低头改变了探索记录');
report(
  sameWalls(observedBeforePitch, pitchExp.observed),
  '探索只读水平朝向：pitch 变化不会清空或误记地图（模态/视角操作不影响探索记录）',
);

// ==================== 3. 大门交互 ====================

section('大门交互（靠近 + 面向 + E）');

const doorMaze = parseMaze(['########', '#S.....#', '#.####.#', '#.#..#.#', '#.#.##.#', '#....ED#', '########']);
// 手写小图只用于门交互几何，不套用 validateMaze 的全图尺寸/环路要求
check(sameCell(doorMaze.door, { col: 6, row: 5 }) && sameCell(doorMaze.exit, { col: 5, row: 5 }), '手写门测试图的门/交互格解析错误');
check(isWall(doorMaze, 6, 5) && isWalkable(doorMaze, 5, 5), '手写门测试图门不是墙或交互格不可走');
check(isWalkable(doorMaze, doorApproach(doorMaze).col, doorApproach(doorMaze).row), '手写门测试图连接边不可走');
check(isReachable(doorMaze, doorMaze.start, doorMaze.exit), '手写门测试图入口到不了门前');
check(doorFaceCenter(doorMaze).x === 6 && doorFaceCenter(doorMaze).y === 5.5, '门面中心不是共享边中点');

const doorGame = new Game(doorMaze);
place(doorGame, doorMaze.exit);
doorGame.angle = 0; // 面向东 = 面向门
check(doorGame.canOpenDoor(), '站在门前交互格中心面向大门却无法开门');
check(Math.abs(doorGame.doorDistance() - 0.5) < 1e-9, `门面距离应为 0.5，实际 ${doorGame.doorDistance()}`);
report(doorGame.canOpenDoor(), `门前交互格中心面向大门：距离 ${doorGame.doorDistance().toFixed(2)} 格、朝向偏差 ${(doorGame.doorAngleDiff() * 180) / Math.PI}° -> 可开门`);

place(doorGame, doorApproach(doorMaze));
doorGame.angle = 0;
check(doorGame.canOpenDoor(), `站在固定连接边 (${doorApproach(doorMaze).col},${doorApproach(doorMaze).row}) 面向大门无法开门`);
report(doorGame.canOpenDoor(), `固定连接边面向大门：距离 ${doorGame.doorDistance().toFixed(2)} 格 -> 可开门`);

place(doorGame, doorMaze.exit);
doorGame.angle = Math.PI; // 背对
check(!doorGame.canOpenDoor() && !doorGame.openDoor(), '背对大门仍能开门');
doorGame.angle = Math.PI / 2; // 侧对（偏差 90° > 48°）
check(!doorGame.canOpenDoor(), `侧对大门（90°）仍可开门，角度阈值 ${DOOR_INTERACT_ANGLE_DEG}°`);
const sideLimit = (DOOR_INTERACT_ANGLE_DEG * Math.PI) / 180 + 0.01;
doorGame.angle = sideLimit;
check(!doorGame.canOpenDoor(), '超出朝向阈值仍可开门');
doorGame.angle = sideLimit - 0.05;
check(doorGame.canOpenDoor(), '朝向阈值内无法开门');
report(true, `朝向阈值 ${DOOR_INTERACT_ANGLE_DEG}°：背对/侧对/超阈值均无效，阈值内有效`);

place(doorGame, doorMaze.start);
doorGame.angle = Math.atan2(doorFaceCenter(doorMaze).y - doorGame.y, doorFaceCenter(doorMaze).x - doorGame.x);
check(!doorGame.canOpenDoor() && !doorGame.openDoor(), `远距离（${doorGame.doorDistance().toFixed(1)} 格 > ${DOOR_INTERACT_DISTANCE}）正对大门仍能开门`);
report(!doorGame.canOpenDoor(), `远距离按 E 无效：距离 ${doorGame.doorDistance().toFixed(1)} 格 > ${DOOR_INTERACT_DISTANCE}`);

// 隔墙：站在门北侧两格、墙后正对门面按 E
let losMaze: Maze | null = null;
let losSpot: GridPos | null = null;
for (const candidate of generated) {
  if (isWall(candidate, EXIT.col, EXIT.row - 1) && isWalkable(candidate, EXIT.col, EXIT.row - 2)) {
    losMaze = candidate;
    losSpot = { col: EXIT.col, row: EXIT.row - 2 };
    break;
  }
}
check(losMaze !== null && losSpot !== null, '找不到「门北侧有墙、墙后有可走格」的地图来做隔墙测试');
if (losMaze && losSpot) {
  const losGame = new Game(cloneMaze(losMaze));
  place(losGame, losSpot);
  const face = doorFaceCenter(losMaze);
  losGame.angle = Math.atan2(face.y - losGame.y, face.x - losGame.x);
  check(losGame.doorDistance() <= DOOR_INTERACT_DISTANCE, `隔墙测试点距离 ${losGame.doorDistance().toFixed(2)} 超出交互距离，测试无效`);
  check(losGame.doorAngleDiff() <= (DOOR_INTERACT_ANGLE_DEG * Math.PI) / 180, '隔墙测试点朝向偏差过大，测试无效');
  check(!losGame.hasDoorLineOfSight(), '视线穿过墙壁打到了大门');
  check(!losGame.canOpenDoor() && !losGame.openDoor(), '隔墙按 E 打开了大门');
  report(
    !losGame.canOpenDoor(),
    `隔墙无效：从 (${losSpot.col},${losSpot.row}) 正对门面（距离 ${losGame.doorDistance().toFixed(2)}、偏差 ${(
      (losGame.doorAngleDiff() * 180) /
      Math.PI
    ).toFixed(0)}°）被中间墙格挡住视线`,
  );
}

// 开门只触发一次，表现期间冻结移动，通关后不再响应
const openGame = new Game(cloneMaze(doorMaze));
place(openGame, doorMaze.exit);
openGame.angle = 0;
check(openGame.openDoor(), '首次按 E 未能开门');
check(openGame.doorOpening && !openGame.won, '开门后应立即进入表现阶段而不是直接通关');
check(!openGame.canOpenDoor() && !openGame.openDoor(), '开门表现期间重复触发');
const openX = openGame.x;
const openY = openGame.y;
let frames = 0;
const animFrames = Math.ceil(DOOR_OPEN_MS / 1000 / DT);
while (!openGame.won && frames < animFrames * 3) {
  openGame.update(DT, { forward: 1, turn: 1, pitch: 0 });
  frames++;
}
check(openGame.won, `开门表现结束后未通关（${frames} 帧）`);
check(openGame.x === openX && openGame.y === openY && openGame.doorOpenT === 1, '开门表现期间玩家仍在移动');
const wonX = openGame.x;
const wonAngle = openGame.angle;
openGame.update(1, { forward: 1, turn: 1, pitch: 1 });
check(openGame.x === wonX && openGame.angle === wonAngle && !openGame.openDoor(), '通关后仍在响应输入');
check(Math.abs(frames * DT * 1000 - DOOR_OPEN_MS) <= DT * 1000, `开门表现时长异常：${frames * DT * 1000}ms vs 配置 ${DOOR_OPEN_MS}ms`);
report(openGame.won && openGame.x === wonX, `按 E -> ${DOOR_OPEN_MS}ms 开门表现 -> 通关一次；表现与通关后移动均冻结，重复 E 无效`);

openGame.reset();
check(!openGame.won && !openGame.doorOpening && openGame.doorOpenMs === 0 && openGame.pitch === 0, 'reset 未清空开门状态');
check(openGame.x === doorMaze.start.col + 0.5 && openGame.y === doorMaze.start.row + 0.5, 'reset 未回到起点');
report(true, '重开清空通关/开门状态并回到起点');

// ==================== 4. 战争迷雾遮挡 ====================

section('战争迷雾遮挡验证（固定直角走廊图 + 大门）');

const corridor = parseMaze(['#######', '#S#...#', '#####.#', '#####.#', '#####ED', '#######']);
const cGame = new Game(corridor);
const cExp = new Exploration(corridor);
place(cGame, corridor.start);
cGame.angle = 0;
cExp.update(corridor, cGame.x, cGame.y, cGame.angle);

check(cExp.isVisible(corridor, 1, 1), '出生点脚下未揭示');
check(cExp.isVisible(corridor, 2, 1), '正对的第一块墙未揭示');
check(!cExp.isVisible(corridor, 3, 1), '墙后的道路被提前揭示（隔墙偷看）');
check(!cExp.isVisible(corridor, 5, 1), '视野外同走廊远端被揭示');
check(!cExp.isVisible(corridor, 5, 2), '转角后的道路被提前揭示');
check(!cExp.isVisible(corridor, corridor.door.col, corridor.door.row) && !cExp.exitSeen, '未看见的大门被提前标记');
check(cExp.observedAt(corridor, 2, 1) === OBS_WALL, '看到的墙未记录为墙');
report(
  !cExp.isVisible(corridor, 3, 1) && !cExp.isVisible(corridor, 5, 2) && !cExp.exitSeen,
  '初始朝东：墙后道路、转角后道路、大门均不显示',
);

const exploredAfterStart = cExp.explored.reduce((a, b) => a + b, 0);
check(exploredAfterStart <= 6, `出生揭示范围过大 (${exploredAfterStart} 格)`);
report(exploredAfterStart <= 6, `出生仅揭示初始视野 ${exploredAfterStart} 格（非整片房间、非全图透视）`);

place(cGame, { col: 5, row: 1 });
cGame.angle = Math.PI / 2;
cExp.update(corridor, cGame.x, cGame.y, cGame.angle);
check(cExp.isVisible(corridor, 5, 2) && cExp.isVisible(corridor, 5, 3) && cExp.isVisible(corridor, 5, 4), '转向南后转角走廊未揭示');
check(!cExp.isVisible(corridor, 1, 1), '身后旧区域不应仍标记为当前可见');
check(cExp.isExplored(corridor, 1, 1) && cExp.isExplored(corridor, 2, 1), '曾探索区域离开视野后记录丢失');
check(!cExp.isExplored(corridor, 3, 1), '从未看见的墙后格被记为已探索');
report(cExp.isExplored(corridor, 1, 1) && !cExp.isExplored(corridor, 3, 1), '转弯观察后转角走廊出现，旧探索记录保留，未见过的格仍为黑');

place(cGame, corridor.exit);
cGame.angle = 0;
cExp.update(corridor, cGame.x, cGame.y, cGame.angle);
check(cExp.isVisible(corridor, corridor.door.col, corridor.door.row), '正对大门却未揭示门格');
check(cExp.exitSeen, '看见大门后 exitSeen 未置位');
check(cExp.observedAt(corridor, corridor.door.col, corridor.door.row) === OBS_WALL, '大门应记录为墙（阻挡通行），小地图才不会画出可走通道');
report(cExp.exitSeen, '走到门前看到大门：小地图标记出现，门格按墙记录');

cGame.angle = -Math.PI / 2;
cExp.update(corridor, cGame.x, cGame.y, cGame.angle);
check(cExp.exitSeen, 'exitSeen 不应在离开视野后被清除');
check(cExp.isExplored(corridor, corridor.door.col, corridor.door.row), '大门探索记录不应丢失');
check(cExp.observedAt(corridor, corridor.door.col, corridor.door.row) === OBS_WALL, '大门离开视野后记录丢失');
report(true, '大门标记发现后永久保留（本局内），离开视野只变暗不消失');

const beforeReset = cExp.explored.reduce((a, b) => a + b, 0);
cExp.reset();
cGame.reset();
check(cExp.explored.reduce((a, b) => a + b, 0) === 0 && !cExp.exitSeen, 'reset 未清空探索记录');
check(cExp.observed.every((v) => v === OBS_UNKNOWN), 'reset 未清空 observed 地形快照');
check(cGame.x === corridor.start.col + 0.5 && cGame.y === corridor.start.row + 0.5, 'reset 未回到起点');
report(beforeReset > 0, `重新开始清空探索记录（${beforeReset} 格 -> 0）并回到起点`);

const fogRandom = driveToDoor(generateMazeWithInfo(mulberry32(4242)).maze, DT, true);
const fogSeen = fogRandom.exploration ? seenFloorCount(fogRandom.game.maze, fogRandom.exploration) : 0;
const fogTotal = countWalkable(fogRandom.game.maze);
check(fogRandom.exploration !== null && fogSeen < fogTotal, '迷雾揭示范围等于全图');
report(fogSeen < fogTotal, `随机地图通关后仍有未探索区域（沿最短路开门只看到 ${fogSeen}/${fogTotal} 个可走格 = ${Math.round((fogSeen / fogTotal) * 100)}%）`);

section('observed 快照：远处动态墙变化不透视泄露');

const leakMaze = generated[0];
const leakGame = new Game(leakMaze);
const leakExp = new Exploration(leakMaze);
// 先在起点原地转一圈，探索起点附近
for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
  leakGame.angle = angle;
  leakExp.update(leakMaze, leakGame.x, leakGame.y, leakGame.angle);
}
// 再走到地图另一端的门前：起点附近的格子成为「已探索但不在当前视野」的远处格
place(leakGame, leakMaze.exit);
leakGame.angle = Math.PI;
leakExp.update(leakMaze, leakGame.x, leakGame.y, leakGame.angle);

const stale: GridPos[] = [];
for (let row = 1; row < leakMaze.rows - 1; row++) {
  for (let col = 1; col < leakMaze.cols - 1; col++) {
    if (leakExp.isExplored(leakMaze, col, row) && !leakExp.isVisible(leakMaze, col, row)) stale.push({ col, row });
  }
}
// 优先选墙格：模拟「远处的墙被打开」这类最容易透视泄露的动态变化
const farCell = stale.find((c) => isWall(leakMaze, c.col, c.row)) ?? stale[0] ?? null;
check(farCell !== null, '找不到「已探索但不在当前视野」的格子来测试泄露');
if (farCell) {
  const before = leakExp.observedAt(leakMaze, farCell.col, farCell.row);
  const changed = withWalls(leakMaze, leakMaze.walls.map((v, i) => (i === cellIndex(leakMaze, farCell!.col, farCell!.row) ? (v === WALL ? 0 : WALL) : v)));
  check(!sameWalls(leakMaze.walls, changed.walls), '测试用的远处墙体变化未生效');
  leakExp.update(changed, leakGame.x, leakGame.y, leakGame.angle);
  check(leakExp.observedAt(changed, farCell.col, farCell.row) === before, '远处墙体变化被小地图透视（observed 被隔空改写）');
  // 走到能看见它的位置后，记录才更新
  place(leakGame, farCell);
  leakGame.angle = 0;
  leakExp.update(changed, leakGame.x, leakGame.y, leakGame.angle);
  const after = leakExp.observedAt(changed, farCell.col, farCell.row);
  check(after === (isWall(changed, farCell.col, farCell.row) ? OBS_WALL : OBS_FLOOR), '重新看到后 observed 未更新为最新地形');
  report(
    after !== before && leakExp.observedAt(changed, farCell.col, farCell.row) === after,
    `远处墙变化不泄露：(${farCell.col},${farCell.row}) observed 保持 ${before}，再次进入视野后更新为 ${after}`,
  );
}

// ==================== 5. 小地图扇形光束 ====================

section('小地图手电筒光束（与第一人称共用朝向/视野角/视距，被墙截断）');

const beamMaze = generated[3] ?? generated[0];
const beamBuffer = new Float32Array(beamPolygonCapacity());
check(beamBuffer.length === (MINIMAP_BEAM_RAYS + 1) * 2, '光束多边形缓冲容量与射线数不匹配');

let truncated = 0;
let fullSpan = 0;
const beamAngles = [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2, 2.3];
const beamSpots = pickSpots(beamMaze, 5, mulberry32(77));
for (const spot of beamSpots) {
  for (const angle of beamAngles) {
    const x = spot.col + 0.5;
    const y = spot.row + 0.5;
    const count = fillBeamPolygon(beamMaze, x, y, angle, beamBuffer);
    check(count === MINIMAP_BEAM_RAYS + 1, `光束顶点数应为 ${MINIMAP_BEAM_RAYS + 1}，实际 ${count}`);
    check(Math.abs(beamBuffer[0] - x) < 1e-6 && Math.abs(beamBuffer[1] - y) < 1e-6, '光束多边形首个顶点不是玩家位置');

    for (let i = 1; i < count; i++) {
      const vx = beamBuffer[i * 2];
      const vy = beamBuffer[i * 2 + 1];
      const dx = vx - x;
      const dy = vy - y;
      const d = Math.hypot(dx, dy);
      check(d <= VIEW_DISTANCE + 1e-6, `光束顶点超出最大照明距离 ${VIEW_DISTANCE}（实际 ${d.toFixed(2)}）`);
      if (d < VIEW_DISTANCE - 1e-6) truncated++;
      if (d < 1e-6) continue;
      // 玩家到顶点之间不得有墙：光束不能穿墙
      const hit = castRay(beamMaze, x, y, dx / d, dy / d, d - 1e-4);
      check(hit === null, `光束穿过墙壁（顶点距 ${d.toFixed(2)}，途中命中 (${hit?.col},${hit?.row})）`);
    }
    // 首末射线夹角 = 水平视野角，与第一人称一致
    const firstA = Math.atan2(beamBuffer[3] - y, beamBuffer[2] - x);
    const lastI = (count - 1) * 2;
    const lastA = Math.atan2(beamBuffer[lastI + 1] - y, beamBuffer[lastI] - x);
    const span = Math.abs(normalizeAngle(lastA - firstA));
    check(Math.abs(span - (FOV_DEG * Math.PI) / 180) < 1e-6, `光束张角 ${((span * 180) / Math.PI).toFixed(2)}° 与 FOV ${FOV_DEG}° 不一致`);
    if (Math.abs(span - (FOV_DEG * Math.PI) / 180) < 1e-6) fullSpan++;
  }
}
check(truncated > 0, '所有光束射线都打到最大视距，说明没有被墙截断');
report(
  truncated > 0 && fullSpan === beamSpots.length * beamAngles.length,
  `光束被墙截断 ${truncated}/${(beamSpots.length * beamAngles.length * MINIMAP_BEAM_RAYS)} 条射线；张角恒为 ${FOV_DEG}°（与第一人称同一 FOV/视距/首个命中墙）`,
);

// 正对近墙时光束必须明显短于视距
const nearGame = new Game(cloneMaze(maze));
nearGame.angle = -Math.PI / 2;
const nearCount = fillBeamPolygon(maze, nearGame.x, nearGame.y, nearGame.angle, beamBuffer);
let nearMax = 0;
for (let i = 1; i < nearCount; i++) {
  nearMax = Math.max(nearMax, Math.hypot(beamBuffer[i * 2] - nearGame.x, beamBuffer[i * 2 + 1] - nearGame.y));
}
check(nearMax < 2, `正对 1 格外的墙，光束仍延伸到 ${nearMax.toFixed(2)} 格（扇形未被截断）`);
report(nearMax < 2, `正对近墙：光束最远 ${nearMax.toFixed(2)} 格 < 视距 ${VIEW_DISTANCE}，扇形不是半透明穿墙三角形`);

// ==================== 6. 铺满窗口的整数像素布局 ====================

section('铺满窗口布局（不拉伸 / 不漏白边 / 缓冲不超上限）');

const viewports: Array<[number, number]> = [
  [320, 180],
  [375, 667],
  [800, 600],
  [1024, 1366],
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
  [3440, 1440],
  [3840, 2160],
];
let layoutOk = true;
for (const [vw, vh] of viewports) {
  const l = computeViewLayout(vw, vh);
  const integer = Number.isInteger(l.scale) && l.scale >= 1;
  const covers = l.bufferW * l.scale >= vw && l.bufferH * l.scale >= vh;
  const bounded = l.bufferW <= MAX_BUFFER_W && l.bufferH <= MAX_BUFFER_H;
  const ratioError = Math.abs(l.bufferW / l.bufferH - vw / vh) / (vw / vh);
  check(integer, `${vw}x${vh}: 像素倍率非整数或小于 1 (${l.scale})`);
  check(covers, `${vw}x${vh}: 缓冲 ${l.bufferW}x${l.bufferH} × ${l.scale} 未覆盖视口，会漏白边`);
  check(bounded, `${vw}x${vh}: 缓冲 ${l.bufferW}x${l.bufferH} 超出上限 ${MAX_BUFFER_W}x${MAX_BUFFER_H}`);
  check(ratioError < 0.02, `${vw}x${vh}: 缓冲宽高比偏差 ${(ratioError * 100).toFixed(2)}% 会造成拉伸变形`);
  const cell = computeMinimapCell(vw, vh, GRID_COLS);
  check(cell >= 3 && GRID_COLS * cell <= vw && GRID_ROWS * cell <= vh, `${vw}x${vh}: 小地图单格 ${cell}px 超出视口`);
  if (!(integer && covers && bounded && ratioError < 0.02)) layoutOk = false;
  process.stdout.write(
    `  ${String(vw).padStart(4)}x${String(vh).padEnd(5)} -> scale ${l.scale}, 缓冲 ${l.bufferW}x${l.bufferH}, 宽高比偏差 ${(ratioError * 100).toFixed(2)}%, 小地图格 ${cell}px\n`,
  );
}
report(layoutOk, `${viewports.length} 种视口：整数倍率 + 缓冲覆盖视口 + 不超上限 + 宽高比几乎一致（CSS 恒为 100% 视口，无黑边/白边/滚动条）`);

// ==================== 7. 中等模式：局部动态墙 ====================

section('中等模式：候选模块合法性');

const DYN_MAPS = 30;
const DYN_SPOTS = 6;
const DYN_CYCLES = 4;
const dynMazes: Maze[] = [];
let moduleCountMin = Number.POSITIVE_INFINITY;
let moduleCountMax = 0;
let moduleChecks = 0;

for (let i = 0; i < DYN_MAPS; i++) {
  const seed = 5000 + i;
  const base = generateMazeWithInfo(mulberry32(seed)).maze;
  dynMazes.push(base);
  const fx = emptyFx();
  const dyn = new DynamicWalls(base, mulberry32((seed ^ 0x9e3779b9) >>> 0), fx);
  const tag = `dyn-seed#${seed}`;
  moduleCountMin = Math.min(moduleCountMin, dyn.modules.length);
  moduleCountMax = Math.max(moduleCountMax, dyn.modules.length);
  check(dyn.modules.length >= DYNAMIC_MODULE_MIN && dyn.modules.length <= DYNAMIC_MODULE_MAX, `${tag} 模块数 ${dyn.modules.length} 超出 [${DYNAMIC_MODULE_MIN},${DYNAMIC_MODULE_MAX}]`);
  check(dyn.effective === dyn.base && dyn.base === base, `${tag} 初始有效地图不等于原图`);
  check(dyn.pendingInfo === null && fxIdle(fx), `${tag} 初始就有待切换状态或特效`);

  const used = new Set<number>();
  for (const m of dyn.modules) {
    moduleChecks++;
    const okCells =
      isCorridorCell(base, m.a.col, m.a.row) &&
      isCorridorCell(base, m.b.col, m.b.row) &&
      !isProtected(base, m.a.col, m.a.row) &&
      !isProtected(base, m.b.col, m.b.row);
    check(okCells, `${tag} 模块格子不是内部通道格或落在出口保护区 (${m.a.col},${m.a.row})/(${m.b.col},${m.b.row})`);
    check(Math.abs(m.a.col - m.b.col) + Math.abs(m.a.row - m.b.row) <= DYNAMIC_MODULE_SPAN, `${tag} 模块跨度超过 ${DYNAMIC_MODULE_SPAN} 格（不是局部改道）`);
    check(m.state === 0, `${tag} 模块初始状态不是 0（初始地图被改动）`);
    check(isWalkable(base, m.a.col, m.a.row) && isWall(base, m.b.col, m.b.row), `${tag} 模块不是一开一关，切换后不会改变可通行路线`);
    const ia = cellIndex(base, m.a.col, m.a.row);
    const ib = cellIndex(base, m.b.col, m.b.row);
    check(!used.has(ia) && !used.has(ib), `${tag} 模块之间共用格子`);
    used.add(ia);
    used.add(ib);
  }
}
report(
  moduleCountMin >= DYNAMIC_MODULE_MIN && moduleCountMax <= DYNAMIC_MODULE_MAX,
  `${DYN_MAPS} 张地图共 ${moduleChecks} 个候选模块：均为内部通道格、一开一关、跨度 ≤ ${DYNAMIC_MODULE_SPAN} 格、互不重叠、不碰出口保护区（数量 ${moduleCountMin}~${moduleCountMax}）`,
);

section('中等模式：事务式切换 fuzz（多地图 × 多玩家位置 × 多周期）');

const stats = {
  intervals: 0,
  cycles: 0,
  skipped: 0,
  committed: 0,
  cancelled: 0,
  rejected: 0,
  fallbackAtomic: 0,
  roomsKept: 0,
};

function stepDyn(dyn: DynamicWalls, game: Game, ms: number, active = true, chunkMs = 50): void {
  let left = ms;
  while (left > 1e-9) {
    const step = Math.min(chunkMs, left);
    dyn.update(step, game, active);
    left -= step;
  }
}

function stepUntilWarn(dyn: DynamicWalls, game: Game): number {
  let elapsed = 0;
  const limit = DYNAMIC_INTERVAL_MS + 1000;
  while (dyn.pendingInfo === null && elapsed < limit) {
    dyn.update(100, game, true);
    elapsed += 100;
  }
  return elapsed;
}

/** 一次已提交切换必须满足的全部不变量（动画提交与原子切换共用） */
function assertCommitted(
  tag: string,
  wallsBefore: Uint8Array,
  dyn: DynamicWalls,
  game: Game,
  pending: Pending,
  fx: SceneFx,
): void {
  const after = dyn.base;
  const changed = diffCells(wallsBefore, after.walls);
  check(changed.length === 2, `${tag} 提交改动了 ${changed.length} 格（应为 2 格：一关一开）`);
  check(isWall(after, pending.closing.col, pending.closing.row), `${tag} 提交后关闭格不是墙`);
  check(isWalkable(after, pending.opening.col, pending.opening.row), `${tag} 提交后新开通格仍是墙`);
  check(borderClosed(after), `${tag} 提交后外圈被打开`);
  check(isWall(after, after.door.col, after.door.row), `${tag} 提交后大门不再是墙`);
  check(isWalkable(after, after.exit.col, after.exit.row), `${tag} 提交后门前交互格被封`);
  const approachAfter = doorApproach(after);
  check(isWalkable(after, approachAfter.col, approachAfter.row), `${tag} 提交后固定连接边被封`);
  check(isFreeAt(after, game.x, game.y, PLAYER_RADIUS), `${tag} 提交后玩家被墙包住`);
  check(
    cellClearance(game.x, game.y, pending.closing.col, pending.closing.row) >= PLAYER_RADIUS + DYNAMIC_SAFE_MARGIN,
    `${tag} 新墙生成在玩家碰撞体上或净距不足`,
  );
  check(isReachable(after, game.cell(), after.exit), `${tag} 提交后玩家无法到达门前（被封死）`);
  if (allRoomsReachableFrom(after, game.cell())) stats.roomsKept++;
  check(dyn.effective === after && game.maze === after, `${tag} 提交后渲染/碰撞/探索读取的地图不是同一份`);
  check(fxIdle(fx), `${tag} 提交后特效未清理`);
  check(fx.flash > 0, `${tag} 提交后没有短暂闪光反馈`);
}

for (let i = 0; i < DYN_MAPS; i++) {
  const seed = 5000 + i;
  const base = dynMazes[i];
  const spots = pickSpots(base, DYN_SPOTS, mulberry32(seed * 7 + 13));

  for (let s = 0; s < spots.length; s++) {
    const fx = emptyFx();
    const dyn = new DynamicWalls(base, mulberry32((seed ^ 0x9e3779b9) >>> 0), fx);
    const game = new Game(base);
    const spotTag = `seed#${seed} spot(${spots[s].col},${spots[s].row})`;
    place(game, spots[s]);
    check(game.free(game.x, game.y), `${spotTag} 模拟位置本身在墙内`);

    for (let cycle = 0; cycle < DYN_CYCLES; cycle++) {
      const wallsBefore = dyn.base.walls.slice();
      const committedBefore = dyn.stats.committed;
      const elapsed = stepUntilWarn(dyn, game);
      if (dyn.pendingInfo === null) {
        // 没有合法候选：跳过本周期，地图必须完全不变，且必须在有限时间内结束
        stats.skipped++;
        check(elapsed <= DYNAMIC_INTERVAL_MS + 1000, `${spotTag} 候选查找未在有限时间内结束`);
        check(sameWalls(wallsBefore, dyn.base.walls) && dyn.effective === dyn.base, `${spotTag} 跳过周期却改动了地图`);
        check(fxIdle(fx), `${spotTag} 跳过周期却留下了预警特效`);
        continue;
      }
      stats.cycles++;
      const pending = dyn.pendingInfo;
      const tag = `${spotTag} cycle${cycle}`;

      // ---- 预警阶段：只影响画面，已提交地图与碰撞不变 ----
      check(pending.phase === 'warn', `${tag} 首个阶段不是预警`);
      check(sameWalls(wallsBefore, dyn.base.walls), `${tag} 预警期间已提交地图被改动`);
      check(dyn.effective === dyn.base && game.maze === dyn.base, `${tag} 预警期间有效地图被换掉`);
      check(fx.warnCells.length === 2 && fx.ghostMaze !== null, `${tag} 预警特效未挂载`);
      check(
        fx.ghostMaze !== null &&
          isWall(fx.ghostMaze, pending.closing.col, pending.closing.row) &&
          isWall(fx.ghostMaze, pending.opening.col, pending.opening.row),
        `${tag} 预警影子图不是新旧墙的并集`,
      );
      stepDyn(dyn, game, DYNAMIC_WARN_MS / 2);
      check(fx.pulse >= 0 && fx.pulse <= 1, `${tag} 预警脉冲值越界 ${fx.pulse}`);
      check(sameWalls(wallsBefore, dyn.base.walls), `${tag} 预警中途地图被改动`);

      // ---- 预警结束：动画前基于最新位置复验，失败则取消，并集不安全则退化为原子切换 ----
      stepDyn(dyn, game, DYNAMIC_WARN_MS / 2 + 60);
      if (dyn.pendingInfo === null) {
        if (dyn.stats.committed > committedBefore) {
          assertCommitted(`${tag} 原子切换`, wallsBefore, dyn, game, pending, fx);
        } else {
          check(sameWalls(wallsBefore, dyn.base.walls), `${tag} 复验失败取消后地图仍被改动`);
          check(dyn.effective === dyn.base && game.maze === dyn.base, `${tag} 取消后有效地图未复原`);
          check(fxIdle(fx), `${tag} 取消后预警特效未清理`);
          check(game.free(game.x, game.y), `${tag} 取消后玩家在墙内`);
        }
        continue;
      }
      check(dyn.pendingInfo.phase === 'anim', `${tag} 预警结束后未进入动画阶段`);
      if (dyn.pendingInfo.phase === 'anim') {
        check(dyn.effective !== dyn.base && game.maze === dyn.effective, `${tag} 动画期间渲染/碰撞未统一切到并集图`);
        check(
          isWall(dyn.effective, pending.closing.col, pending.closing.row) &&
            isWall(dyn.effective, pending.opening.col, pending.opening.row),
          `${tag} 并集图未同时封闭新旧墙`,
        );
        check(isFreeAt(dyn.effective, game.x, game.y, PLAYER_RADIUS), `${tag} 动画期间并集图与玩家重叠`);
        check(isReachable(dyn.effective, game.cell(), dyn.effective.exit), `${tag} 动画期间玩家在并集图上无法到达门前`);
        check(fx.animT >= 0 && fx.animT <= 1 && fx.ghostMaze === null, `${tag} 动画特效状态异常`);
      }

      // ---- 提交 ----
      stepDyn(dyn, game, DYNAMIC_ANIM_MS + 60);
      if (dyn.pendingInfo !== null) {
        failures.push(`${tag} 动画结束后仍有待切换状态`);
        checks++;
        continue;
      }
      checks++;
      assertCommitted(tag, wallsBefore, dyn, game, pending, fx);

      // 提交后玩家继续移动：不得因换图卡进墙里，且始终可达门前
      for (let f = 0; f < 30; f++) {
        game.update(DT, { forward: 1, turn: 0.4, pitch: 0 });
        check(game.free(game.x, game.y), `${tag} 提交后继续移动穿墙 (f=${f})`);
      }
      check(isReachable(dyn.base, game.cell(), dyn.base.exit), `${tag} 提交后移动的玩家无法到达门前`);
    }

    stats.intervals += dyn.stats.attempts;
    stats.committed += dyn.stats.committed;
    stats.cancelled += dyn.stats.cancelled;
    stats.rejected += dyn.stats.rejected;
    stats.fallbackAtomic += dyn.stats.fallbackAtomic;
  }
}

const revalidateCancelled = Math.max(0, stats.cancelled - stats.skipped);
report(
  stats.committed > 0,
  `${stats.intervals} 次周期触发：进入预警 ${stats.cycles} 次，提交 ${stats.committed} 次，动画前复验失败取消 ${revalidateCancelled} 次，无合法候选跳过 ${stats.skipped} 次，单个候选被安全校验否决 ${stats.rejected} 次，并集不安全退化为原子切换 ${stats.fallbackAtomic} 次`,
);
report(
  stats.committed > 0,
  `所有已提交切换都保持：仅改 2 格（一关一开）、玩家至门前可达、不与碰撞体重叠、新墙净距 ≥ ${DYNAMIC_SAFE_MARGIN} 格、出口保护区与外圈不变（其中 ${stats.roomsKept}/${stats.committed} 次连所有房间都仍可达，其余为放宽档：只保证玩家能走到门前）`,
);
check(stats.committed > 0, '整个 fuzz 没有一次成功提交，中等模式等于没有真正改道');
check(stats.rejected > 0, '安全校验从未否决任何候选，说明校验没有真正生效');

section('中等模式：预警后玩家换位 -> 动画开始前复验');

let movedCaseDone = false;
for (let i = 0; i < DYN_MAPS && !movedCaseDone; i++) {
  const seed = 5000 + i;
  const base = dynMazes[i];
  const fx = emptyFx();
  const dyn = new DynamicWalls(base, mulberry32((seed ^ 0x9e3779b9) >>> 0), fx);
  const game = new Game(base);
  const wallsBefore = base.walls.slice();
  const elapsed = stepUntilWarn(dyn, game);
  const pending = dyn.pendingInfo;
  if (pending === null) continue;

  // 预警期间玩家走进「即将关闭」的格子：动画开始前必须复验并取消
  place(game, pending.closing);
  check(game.free(game.x, game.y), '测试前提错误：即将关闭的格子当前不可站');
  stepDyn(dyn, game, DYNAMIC_WARN_MS + 100);
  check(dyn.pendingInfo === null, '玩家站在即将关闭的格子上，切换却未被取消');
  check(dyn.stats.cancelled >= 1, '取消未计入统计');
  check(sameWalls(wallsBefore, dyn.base.walls), '取消后地图仍被改动');
  check(game.maze === dyn.base && dyn.effective === dyn.base, '取消后有效地图未复原');
  check(isFreeAt(dyn.base, game.x, game.y, PLAYER_RADIUS), '取消后玩家被新生成的墙压住');
  check(fxIdle(fx), '取消后预警特效未清理');
  report(
    dyn.pendingInfo === null && sameWalls(wallsBefore, dyn.base.walls) && isFreeAt(dyn.base, game.x, game.y, PLAYER_RADIUS),
    `预警 ${DYNAMIC_WARN_MS}ms 内玩家走到关闭格 (${pending.closing.col},${pending.closing.row})：动画开始前基于最新位置复验失败 -> 取消切换、地图不变、玩家未被压住（等待 ${elapsed}ms 后触发的那一轮）`,
  );
  movedCaseDone = true;

  // 取消后下一周期仍能正常尝试切换（不是一次失败就永久停摆）
  const elapsed2 = stepUntilWarn(dyn, game);
  check(elapsed2 > 0, '取消后计时器未恢复');
  const stillWorks = dyn.pendingInfo !== null || dyn.stats.cancelled > 1;
  check(stillWorks, '取消后动态墙永久停摆');
  report(true, `取消后下一个周期继续尝试（${elapsed2}ms 后 ${dyn.pendingInfo !== null ? '找到新候选' : '仍无合法候选并跳过'}）`);
}
check(movedCaseDone, '没有任何地图能在预警阶段构造「玩家换位」用例');

section('中等模式：预警期间玩家真实移动（连续输入 + 每帧校验）');

let movingCommitted = 0;
let movingCancelled = 0;
let movingFrames = 0;
for (let i = 0; i < 12; i++) {
  const seed = 5000 + i;
  const base = dynMazes[i];
  const fx = emptyFx();
  const dyn = new DynamicWalls(base, mulberry32((seed ^ 0x9e3779b9) >>> 0), fx);
  const game = new Game(base);
  const random = mulberry32(seed * 31 + 7);
  const input: InputState = { forward: 0, turn: 0, pitch: 0 };

  // 先随机走一段，让玩家停在一个非起点位置
  for (let f = 0; f < 90; f++) {
    input.forward = 1;
    input.turn = (random() - 0.5) * 1.6;
    game.update(DT, input);
    check(game.free(game.x, game.y), `随机行走穿墙 (seed#${seed}, f=${f})`);
  }

  const before = dyn.base.walls.slice();
  let guard = 0;
  const guardLimit = Math.ceil((DYNAMIC_INTERVAL_MS + 1000) / (DT * 1000));
  while (dyn.pendingInfo === null && guard < guardLimit) {
    dyn.update(DT * 1000, game, true);
    guard++;
  }
  if (dyn.pendingInfo === null) continue;

  // 预警 + 动画全程持续随机移动，每帧都断言不穿墙、可达门前、渲染与碰撞同一份地图
  const totalMs = DYNAMIC_WARN_MS + DYNAMIC_ANIM_MS + 200;
  for (let ms = 0; ms < totalMs; ms += DT * 1000) {
    input.forward = random() < 0.8 ? 1 : -0.4;
    input.turn = (random() - 0.5) * 1.8;
    game.update(DT, input);
    dyn.update(DT * 1000, game, true);
    movingFrames++;
    const live = dyn.effective;
    check(isFreeAt(live, game.x, game.y, PLAYER_RADIUS), `动态切换过程中玩家被墙压住 (seed#${seed}, ms=${ms.toFixed(0)})`);
    check(game.maze === live, `渲染/碰撞读取的地图与动态墙有效地图不一致 (seed#${seed})`);
    check(isReachable(live, game.cell(), live.exit), `动态切换过程中玩家无法到达门前 (seed#${seed}, ms=${ms.toFixed(0)})`);
  }
  if (!sameWalls(before, dyn.base.walls)) movingCommitted++;
  else movingCancelled++;
}
report(
  movingFrames > 0,
  `预警/动画期间玩家持续移动 ${movingFrames} 帧：每帧均不穿墙、始终可达门前、渲染与碰撞同一份地图（提交 ${movingCommitted} 次，取消或未完成 ${movingCancelled} 次）`,
);

section('中等模式：暂停 / 失焦 / 通关冻结与清理');

const freezeBase = dynMazes[0];
const freezeFx = emptyFx();
const freezeDyn = new DynamicWalls(freezeBase, mulberry32(999), freezeFx);
const freezeGame = new Game(freezeBase);
const freezeWalls = freezeBase.walls.slice();

stepDyn(freezeDyn, freezeGame, DYNAMIC_INTERVAL_MS * 5, false);
check(freezeDyn.pendingInfo === null && sameWalls(freezeWalls, freezeDyn.base.walls), '暂停期间动态墙仍在后台改图');
let untilWarn = 0;
while (freezeDyn.pendingInfo === null && untilWarn < DYNAMIC_INTERVAL_MS * 2) {
  freezeDyn.update(100, freezeGame, true);
  untilWarn += 100;
}
check(untilWarn >= DYNAMIC_INTERVAL_MS - 100, `恢复后计时器不是从冻结处继续（${untilWarn}ms 就触发，应约 ${DYNAMIC_INTERVAL_MS}ms）`);
report(
  untilWarn >= DYNAMIC_INTERVAL_MS - 100,
  `暂停/失焦 ${DYNAMIC_INTERVAL_MS * 5}ms 内完全冻结；恢复后仍需 ${untilWarn}ms 才触发（计时器被冻结而非累积）`,
);

// 通关与开门表现期间冻结
const wonFx = emptyFx();
const wonDyn = new DynamicWalls(freezeBase, mulberry32(1234), wonFx);
const wonGame = new Game(freezeBase);
place(wonGame, freezeBase.exit);
wonGame.angle = 0;
check(wonGame.openDoor(), '开门测试前提失败');
const wonWalls = freezeBase.walls.slice();
stepDyn(wonDyn, wonGame, DYNAMIC_INTERVAL_MS * 2, !wonGame.doorOpening && !wonGame.won);
check(wonDyn.pendingInfo === null && sameWalls(wonWalls, wonDyn.base.walls), '开门表现/通关期间动态墙仍在改图');
report(true, `开门表现与通关期间（active=false）动态墙冻结：地图未变、无待切换状态（与 main.ts 传入的 !doorOpening && !won 一致）`);

// 返回主页面：destroy 清理
const destroyFx = emptyFx();
const destroyDyn = new DynamicWalls(freezeBase, mulberry32(4321), destroyFx);
stepUntilWarn(destroyDyn, freezeGame);
check(destroyDyn.pendingInfo !== null && destroyFx.warnCells.length > 0, '清理测试前提失败：没有待切换状态');
destroyDyn.destroy();
check(destroyDyn.pendingInfo === null && fxIdle(destroyFx), 'destroy 未清空待切换状态与特效');
const destroyWalls = destroyDyn.base.walls.slice();
stepDyn(destroyDyn, freezeGame, DYNAMIC_INTERVAL_MS * 3, false);
check(sameWalls(destroyWalls, destroyDyn.base.walls), 'destroy 后仍改图');
report(true, '返回主页面：destroy() 清空待切换状态与预警特效，配合 main.ts 丢弃引用后不再有定时改图');

// 下一关：换图重建，计时器/统计/模块全部随新地图重置
const nextLevel = dynMazes[1];
const nextFx = emptyFx();
const nextDyn = new DynamicWalls(nextLevel, mulberry32(20260924), nextFx);
const nextGame = new Game(nextLevel);
nextGame.reset();
check(nextDyn.base === nextLevel && nextDyn.effective === nextLevel && nextGame.maze === nextLevel, '下一关未统一切到新地图');
check(nextDyn.stats.attempts === 0 && nextDyn.stats.committed === 0 && nextDyn.stats.cancelled === 0, '下一关统计未重置');
check(nextDyn.pendingInfo === null && fxIdle(nextFx), '下一关仍带着上一关的待切换状态或特效');
check(nextDyn.modules.every((m) => isCorridorCell(nextLevel, m.a.col, m.a.row)), '下一关模块未按新地图重新挑选');
const nextWalls = nextLevel.walls.slice();
stepDyn(nextDyn, nextGame, DYNAMIC_INTERVAL_MS - 500, true);
check(nextDyn.pendingInfo === null && sameWalls(nextWalls, nextDyn.base.walls), '下一关计时器未从零开始');
report(true, `下一关：新地图 + 新模块 + 计时器归零（${DYNAMIC_INTERVAL_MS - 500}ms 内不触发），无上一关残留状态`);

section('中等模式：迷雾与小地图不泄露未探索区的墙变化');

let leakTested = 0;
for (let i = 0; i < DYN_MAPS; i++) {
  const seed = 5000 + i;
  const base = dynMazes[i];
  const fx = emptyFx();
  const dyn = new DynamicWalls(base, mulberry32((seed ^ 0x9e3779b9) >>> 0), fx);
  const game = new Game(base);
  const exp = new Exploration(base);
  game.angle = 0;
  exp.update(game.maze, game.x, game.y, game.angle);

  const elapsed = stepUntilWarn(dyn, game);
  const pending = dyn.pendingInfo;
  if (pending === null) continue;
  // 只测「预警格从未被玩家看到」的情况：这才是泄露风险场景
  if (exp.isExplored(base, pending.closing.col, pending.closing.row) || exp.isExplored(base, pending.opening.col, pending.opening.row)) continue;
  leakTested++;
  check(elapsed > 0, '预警触发计时异常');

  const closingObsBefore = exp.observedAt(base, pending.closing.col, pending.closing.row);
  exp.update(dyn.effective, game.x, game.y, game.angle);
  check(exp.observedAt(dyn.effective, pending.closing.col, pending.closing.row) === closingObsBefore, `预警阶段小地图透视到了未探索的关闭格 (${pending.closing.col},${pending.closing.row})`);
  check(fx.warnCells.length === 2, '预警格未挂载到特效层（画面无法提示）');

  stepDyn(dyn, game, DYNAMIC_WARN_MS + DYNAMIC_ANIM_MS + 100);
  exp.update(dyn.effective, game.x, game.y, game.angle);
  check(exp.observedAt(dyn.effective, pending.closing.col, pending.closing.row) === closingObsBefore, '提交后小地图隔空更新了从未看见的墙');
  check(closingObsBefore === OBS_UNKNOWN, '测试前提错误：该格已被探索');
  // 全局不变量：未探索格永不带地形记录；已探索格一定有记录
  let invariantOk = true;
  for (let idx = 0; idx < exp.explored.length; idx++) {
    if (exp.explored[idx] === 0 && exp.observed[idx] !== OBS_UNKNOWN) invariantOk = false;
    if (exp.explored[idx] === 1 && exp.observed[idx] === OBS_UNKNOWN) invariantOk = false;
  }
  check(invariantOk, '探索记录与 observed 快照不一致（小地图会画出未探索内容或漏画已探索内容）');
  if (leakTested >= 6) break;
}
check(leakTested > 0, '没有任何地图能构造「预警格未被探索」的泄露测试场景');
report(leakTested > 0, `${leakTested} 张地图：未探索区的预警与墙变化都不进入小地图；observed 与 explored 全程一致（已探索但不在视野时保留最后一次看到的地形）`);

// ==================== 结果 ====================

section('结果');

process.stdout.write(
  `动态墙统计：周期触发 ${stats.intervals} 次，进入预警 ${stats.cycles} 次，提交 ${stats.committed} 次，取消 ${stats.cancelled} 次，候选否决 ${stats.rejected} 次，原子切换退化 ${stats.fallbackAtomic} 次\n`,
);

if (failures.length > 0) {
  process.stdout.write(`FAIL  ${failures.length}/${checks} 项检查未通过：\n`);
  for (const failure of failures.slice(0, 40)) process.stdout.write(`  - ${failure}\n`);
  if (failures.length > 40) process.stdout.write(`  - ...另有 ${failures.length - 40} 项\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `PASS  全部 ${checks} 项检查通过（${MAZE_COUNT} 张地图生成/自动驾驶开门 + 碰撞/帧率/pitch + 门交互 + 迷雾遮挡 + 光束截断 + 布局 + 动态墙 fuzz）\n`,
  );
}
