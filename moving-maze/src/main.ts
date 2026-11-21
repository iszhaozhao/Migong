import { Music } from './audio.ts';
import {
  BASE_RENDER_H,
  BASE_RENDER_W,
  MAX_FRAME_DELTA_MS,
  MENU_SPIN_RAD_PER_SEC,
  MOUSE_PITCH_PER_PX,
  MOUSE_SMOOTH_SEC,
  MOUSE_YAW_PER_PX,
  MUSIC_STORAGE_KEY,
} from './config.ts';
import { DynamicWalls } from './dynamic.ts';
import { Exploration, OBS_FLOOR } from './exploration.ts';
import { clearFx, type SceneFx } from './fx.ts';
import { clamp, Game, normalizeAngle, PITCH_MAX, type InputState } from './game.ts';
import { computeMinimapCell, computeViewLayout } from './layout.ts';
import { countWalkable, generateMaze, isWalkable, type Maze } from './maze.ts';
import { mulberry32, randomSeed } from './random.ts';
import { renderMinimap, renderView, type ViewSize } from './render.ts';

type Difficulty = 'easy' | 'medium' | 'hard';
type Phase = 'menu' | 'playing' | 'paused' | 'won';

const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '困难' };
// 单次鼠标事件累积上限：卡顿后一次性涌入的大位移不会让视角猛甩
const MAX_PENDING_TURN = 0.6;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少页面元素 #${id}`);
  return el as T;
}

const viewCanvas = byId<HTMLCanvasElement>('view');
const viewContext = viewCanvas.getContext('2d');
if (!viewContext) throw new Error('Canvas 2D context is unavailable');
const viewCtx: CanvasRenderingContext2D = viewContext;
viewCtx.imageSmoothingEnabled = false;

const mapCanvas = byId<HTMLCanvasElement>('minimap');
const mapContext = mapCanvas.getContext('2d');
if (!mapContext) throw new Error('Minimap 2D context is unavailable');
const mapCtx: CanvasRenderingContext2D = mapContext;
mapCtx.imageSmoothingEnabled = false;

const minimapEl = mapCanvas;
const hudEl = byId<HTMLDivElement>('hud');
const levelLabelEl = byId<HTMLElement>('level-label');
const timeEl = byId<HTMLElement>('time');
const exploredEl = byId<HTMLElement>('explored');
const helpEl = byId<HTMLParagraphElement>('help');
const hintEl = byId<HTMLParagraphElement>('hint');
const promptEl = byId<HTMLParagraphElement>('prompt');
const menuEl = byId<HTMLDivElement>('screen-menu');
const diffPanelEl = byId<HTMLDivElement>('diff-panel');
const btnDifficulty = byId<HTMLButtonElement>('btn-difficulty');
const btnQuick = byId<HTMLButtonElement>('btn-quick');
const pauseEl = byId<HTMLDivElement>('overlay-pause');
const pauseSubEl = byId<HTMLElement>('pause-sub');
const resumeBtn = byId<HTMLButtonElement>('resume');
const pauseHomeBtn = byId<HTMLButtonElement>('pause-home');
const wonEl = byId<HTMLDivElement>('overlay-won');
const wonSubEl = byId<HTMLElement>('won-sub');
const nextLevelBtn = byId<HTMLButtonElement>('next-level');
const wonHomeBtn = byId<HTMLButtonElement>('won-home');
const musicBtn = byId<HTMLButtonElement>('music-toggle');
const fullscreenBtn = byId<HTMLButtonElement>('fullscreen');
const restartBtn = byId<HTMLButtonElement>('restart');
const homeBtn = byId<HTMLButtonElement>('home');

// ==================== 状态 ====================

const counters = { listeners: 0, frames: 0 };

function listen(target: EventTarget, type: string, handler: EventListener): void {
  target.addEventListener(type, handler);
  counters.listeners++;
}

function makeMaze(seed: number): Maze {
  return generateMaze(mulberry32(seed));
}

const view: ViewSize = { w: BASE_RENDER_W, h: BASE_RENDER_H };
const fx: SceneFx = { warnCells: [], ghostMaze: null, pulse: -1, closing: [], opening: [], animT: -1, flash: -1 };
const session = { difficulty: 'easy' as Difficulty, level: 1, seed: 0 };

const game = new Game(makeMaze(randomSeed()));
let exploration = new Exploration(game.maze);
let dyn: DynamicWalls | null = null;
let mapCell = 6;

let phase: Phase = 'menu';
let locked = false;
const held = new Set<string>();
let pendingYaw = 0;
let pendingPitch = 0;
let lastFrameTime = performance.now();

function loadMusicPref(): boolean {
  try {
    const value = window.localStorage.getItem(MUSIC_STORAGE_KEY);
    return value === null ? true : value === '1';
  } catch {
    return true;
  }
}

function saveMusicPref(on: boolean): void {
  try {
    window.localStorage.setItem(MUSIC_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // 隐私模式下 localStorage 可能不可用：只影响偏好记忆
  }
}

const music = new Music(loadMusicPref());

// ==================== 画面布局：铺满窗口 ====================

function layout(): void {
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);

  // 整数像素倍率：缓冲 = 视口 / scale，CSS 尺寸 = 100% 视口。
  // 既不拉伸旧画面，也不留黑边/白边/滚动条，像素边缘保持清晰。
  const next = computeViewLayout(vw, vh);
  view.w = next.bufferW;
  view.h = next.bufferH;
  if (viewCanvas.width !== next.bufferW || viewCanvas.height !== next.bufferH) {
    viewCanvas.width = next.bufferW;
    viewCanvas.height = next.bufferH;
    viewCtx.imageSmoothingEnabled = false;
  }

  const maze = game.maze;
  mapCell = computeMinimapCell(vw, vh, maze.cols);
  const mw = maze.cols * mapCell;
  const mh = maze.rows * mapCell;
  if (mapCanvas.width !== mw || mapCanvas.height !== mh) {
    mapCanvas.width = mw;
    mapCanvas.height = mh;
    mapCtx.imageSmoothingEnabled = false;
  }
}

// ==================== 相位切换 ====================

function setVisible(el: HTMLElement, visible: boolean): void {
  if (el.hidden === visible) el.hidden = !visible;
}

function syncScreens(): void {
  const inGame = phase !== 'menu';
  setVisible(menuEl, phase === 'menu');
  setVisible(pauseEl, phase === 'paused');
  setVisible(wonEl, phase === 'won');
  setVisible(hudEl, inGame);
  setVisible(minimapEl, inGame);
  setVisible(helpEl, inGame);
  setVisible(restartBtn, inGame);
  setVisible(homeBtn, inGame);
  setVisible(hintEl, phase === 'playing' && !locked);
  levelLabelEl.textContent = `第 ${session.level} 关 · ${DIFFICULTY_LABEL[session.difficulty]}`;
  viewCanvas.style.cursor = phase === 'playing' && !locked ? 'crosshair' : 'default';
}

function clearInput(): void {
  held.clear();
  pendingYaw = 0;
  pendingPitch = 0;
}

function requestLock(): void {
  if (typeof viewCanvas.requestPointerLock !== 'function') return;
  try {
    const result = viewCanvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    // 浏览器拒绝锁定（例如刚按过 Esc）时保持未锁定，键盘操作仍然可玩
  }
}

function releaseLock(): void {
  if (document.pointerLockElement === viewCanvas) document.exitPointerLock();
}

/**
 * 清理本局：动态墙计时器与待切换状态、特效、输入。
 * keepLock 为 true 时不释放鼠标锁定 —— 换关/重开时若释放，浏览器随后派发的
 * pointerlockchange 会把刚进入的 playing 相位误判成「鼠标被释放」而立刻暂停。
 */
function teardownRun(keepLock: boolean): void {
  if (dyn) {
    dyn.destroy();
    dyn = null;
  }
  clearFx(fx);
  clearInput();
  if (!keepLock) releaseLock();
}

function startRun(difficulty: Difficulty, level: number, seed: number): void {
  teardownRun(true);
  session.difficulty = difficulty;
  session.level = level;
  session.seed = seed;

  const maze = makeMaze(seed);
  game.setMaze(maze);
  game.reset();
  exploration = new Exploration(maze);
  if (difficulty === 'medium') {
    // 动态墙使用与地图不同的随机流，换关时随种子一起重置
    dyn = new DynamicWalls(maze, mulberry32((seed ^ 0x9e3779b9) >>> 0), fx);
  }

  phase = 'playing';
  lastFrameTime = performance.now();
  layout();
  syncScreens();
  syncHud();
  music.onUserStart();
}

function enterMenu(): void {
  teardownRun(false);
  session.difficulty = 'easy';
  session.level = 1;
  session.seed = 0;
  diffPanelEl.hidden = true;
  btnDifficulty.setAttribute('aria-expanded', 'false');

  // 主页面背景：一张演示地图 + 缓慢自转的镜头
  const maze = makeMaze(randomSeed());
  game.setMaze(maze);
  game.reset();
  exploration = new Exploration(maze);
  phase = 'menu';
  layout();
  syncScreens();
}

function pause(reason: string): void {
  if (phase !== 'playing') return;
  phase = 'paused';
  clearInput();
  pauseSubEl.textContent = reason;
  releaseLock();
  syncScreens();
}

function resume(): void {
  if (phase !== 'paused') return;
  phase = 'playing';
  lastFrameTime = performance.now();
  syncScreens();
  requestLock();
}

function onWin(): void {
  phase = 'won';
  clearInput();
  releaseLock();
  wonSubEl.textContent = `第 ${session.level} 关 · ${DIFFICULTY_LABEL[session.difficulty]} · 用 ${formatSeconds(
    game.elapsedMs,
  )} 打开大门，探索了 ${exploredPercent()}% 的迷宫。`;
  syncScreens();
  nextLevelBtn.focus();
}

// ==================== HUD ====================

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function exploredPercent(): number {
  // 统计基准用已提交地图：动画期间的并集图会让百分比抖动
  const maze = dyn ? dyn.base : game.maze;
  let total = 0;
  let seen = 0;
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (!isWalkable(maze, col, row)) continue;
      total++;
      if (exploration.observed[row * maze.cols + col] === OBS_FLOOR) seen++;
    }
  }
  if (total === 0) return 0;
  return Math.min(100, Math.round((seen / total) * 100));
}

function syncHud(): void {
  const time = formatSeconds(game.elapsedMs);
  if (timeEl.textContent !== time) timeEl.textContent = time;
  const percent = `${exploredPercent()}%`;
  if (exploredEl.textContent !== percent) exploredEl.textContent = percent;

  const showPrompt = phase === 'playing' && !game.doorOpening && !game.won && game.canOpenDoor();
  setVisible(promptEl, showPrompt);
}

// ==================== 输入 ====================

function inputState(): InputState {
  const forward =
    (held.has('w') || held.has('arrowup') ? 1 : 0) + (held.has('s') || held.has('arrowdown') ? -1 : 0);
  const turn =
    (held.has('d') || held.has('arrowright') ? 1 : 0) + (held.has('a') || held.has('arrowleft') ? -1 : 0);
  return { forward, turn, pitch: 0 };
}

function applyMouseLook(dtSec: number): void {
  if (pendingYaw === 0 && pendingPitch === 0) return;
  // 指数平滑，与帧率无关：鼠标转向顺滑但不拖影
  const k = 1 - Math.exp(-dtSec / MOUSE_SMOOTH_SEC);
  game.angle = normalizeAngle(game.angle + pendingYaw * k);
  game.pitch = clamp(game.pitch + pendingPitch * k, -PITCH_MAX, PITCH_MAX);
  pendingYaw *= 1 - k;
  pendingPitch *= 1 - k;
  if (Math.abs(pendingYaw) < 1e-6) pendingYaw = 0;
  if (Math.abs(pendingPitch) < 1e-6) pendingPitch = 0;
}

function onKeyDown(event: KeyboardEvent): void {
  const key = event.key.toLowerCase();
  if (key.startsWith('arrow') || key === ' ') event.preventDefault();

  if (key === 'm') {
    toggleMusic();
    return;
  }
  if (key === 'escape') {
    if (phase === 'playing') pause('Esc 释放鼠标后暂停');
    return;
  }
  if (event.repeat) {
    if (phase === 'playing') held.add(key);
    return;
  }
  if (phase === 'menu') {
    if (key === 'enter') startRun('easy', 1, randomSeed());
    return;
  }
  if (phase !== 'playing') return;

  if (key === 'e') {
    game.openDoor();
    return;
  }
  if (key === 'r') {
    startRun(session.difficulty, session.level, session.seed);
    return;
  }
  if (key === 'n') {
    startRun(session.difficulty, session.level, randomSeed());
    return;
  }
  held.add(key);
}

function onKeyUp(event: KeyboardEvent): void {
  held.delete(event.key.toLowerCase());
}

function onMouseMove(event: MouseEvent): void {
  if (!locked || phase !== 'playing' || game.doorOpening) return;
  pendingYaw = clamp(pendingYaw + event.movementX * MOUSE_YAW_PER_PX, -MAX_PENDING_TURN, MAX_PENDING_TURN);
  pendingPitch = clamp(pendingPitch - event.movementY * MOUSE_PITCH_PER_PX, -MAX_PENDING_TURN, MAX_PENDING_TURN);
}

function onPointerLockChange(): void {
  locked = document.pointerLockElement === viewCanvas;
  if (!locked && phase === 'playing') {
    pause('鼠标已释放 · 点击继续探索');
    return;
  }
  syncScreens();
}

function toggleMusic(): void {
  if (!music.available) return;
  music.setEnabled(!music.enabled);
  saveMusicPref(music.enabled);
  syncMusicButton();
}

function syncMusicButton(): void {
  const label = !music.available ? '音乐不可用' : music.enabled ? '音乐开' : '音乐关';
  if (musicBtn.textContent !== label) musicBtn.textContent = label;
  musicBtn.disabled = !music.available;
  musicBtn.setAttribute('aria-pressed', String(music.enabled));
}

function toggleFullscreen(): void {
  try {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  } catch {
    // 全屏被拒绝时忽略，画面仍然铺满视口
  }
}

// ==================== 主循环 ====================

function frame(now: number): void {
  requestAnimationFrame(frame);
  counters.frames++;
  const dtMs = Math.min(Math.max(now - lastFrameTime, 0), MAX_FRAME_DELTA_MS);
  lastFrameTime = now;
  const dtSec = dtMs / 1000;

  if (phase === 'playing') {
    applyMouseLook(dtSec);
    game.update(dtSec, inputState());
    // 暂停 / 失焦 / 通关 / 开门表现期间，动态墙计时与动画一律冻结
    if (dyn) dyn.update(dtMs, game, !game.doorOpening && !game.won);
    exploration.update(game.maze, game.x, game.y, game.angle);
    if (game.won) onWin();
  } else if (phase === 'menu') {
    game.angle = normalizeAngle(game.angle + dtSec * MENU_SPIN_RAD_PER_SEC);
    exploration.update(game.maze, game.x, game.y, game.angle);
  }

  renderView(viewCtx, game, view, fx);
  if (phase !== 'menu') renderMinimap(mapCtx, game.maze, exploration, game, mapCell, fx);
  syncHud();
}

// ==================== 绑定（全部只注册一次） ====================

listen(window, 'keydown', onKeyDown as EventListener);
listen(window, 'keyup', onKeyUp as EventListener);
listen(window, 'resize', () => layout());
listen(window, 'blur', () => {
  if (phase === 'playing') pause('窗口失焦 · 点击继续探索');
});
listen(document, 'visibilitychange', () => {
  music.setHidden(document.hidden);
  if (document.hidden && phase === 'playing') pause('页面隐藏 · 点击继续探索');
});
listen(document, 'mousemove', onMouseMove as EventListener);
listen(document, 'pointerlockchange', onPointerLockChange);
listen(document, 'fullscreenchange', () => {
  fullscreenBtn.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
  layout();
});

// 只有点击游戏画面才锁定鼠标；点击 UI 按钮不会触发移动或抢回鼠标
listen(viewCanvas, 'click', () => {
  if (phase === 'playing' && !locked) requestLock();
});

listen(btnQuick, 'click', () => startRun('easy', 1, randomSeed()));
listen(btnDifficulty, 'click', () => {
  const open = diffPanelEl.hidden;
  diffPanelEl.hidden = !open;
  btnDifficulty.setAttribute('aria-expanded', String(open));
});
for (const button of Array.from(diffPanelEl.querySelectorAll<HTMLButtonElement>('button[data-diff]'))) {
  listen(button, 'click', () => {
    const difficulty = button.dataset.diff as Difficulty | undefined;
    // 困难模式本次只做「开发中」占位：按钮禁用，且不进入没有士兵的假困难模式
    if (difficulty === undefined || difficulty === 'hard' || button.disabled) return;
    startRun(difficulty, 1, randomSeed());
  });
}

listen(resumeBtn, 'click', () => resume());
listen(pauseHomeBtn, 'click', () => enterMenu());
listen(nextLevelBtn, 'click', () => startRun(session.difficulty, session.level + 1, randomSeed()));
listen(wonHomeBtn, 'click', () => enterMenu());
listen(restartBtn, 'click', () => startRun(session.difficulty, session.level, session.seed));
listen(homeBtn, 'click', () => enterMenu());
listen(musicBtn, 'click', () => toggleMusic());
listen(fullscreenBtn, 'click', () => toggleFullscreen());

// ==================== 启动 ====================

syncMusicButton();
fullscreenBtn.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
enterMenu();
requestAnimationFrame(frame);

if (new URLSearchParams(window.location.search).has('qa')) {
  (window as unknown as Record<string, unknown>).__qa = {
    get phase() {
      return phase;
    },
    get locked() {
      return locked;
    },
    get session() {
      return { ...session };
    },
    get view() {
      return { ...view };
    },
    get exploration() {
      return exploration;
    },
    get dyn() {
      return dyn;
    },
    get heldKeys() {
      return [...held];
    },
    game,
    fx,
    music,
    counters,
    startRun,
    enterMenu,
    pause,
    resume,
    toggleMusic,
    requestLock,
    countWalkable,
    PITCH_MAX,
  };
}
