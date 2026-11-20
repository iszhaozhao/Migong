import { MAX_FRAME_DELTA_MS, MINIMAP_TARGET_CSS, RENDER_H, RENDER_W } from './config.ts';
import { Exploration } from './exploration.ts';
import { Game, type InputState } from './game.ts';
import { isWalkable, type Maze } from './maze.ts';
import { renderMinimap, renderView } from './render.ts';

const viewCanvas = document.getElementById('view') as HTMLCanvasElement;
const viewContext = viewCanvas.getContext('2d');
if (!viewContext) throw new Error('Canvas 2D context is unavailable');
const viewCtx: CanvasRenderingContext2D = viewContext;
viewCanvas.width = RENDER_W;
viewCanvas.height = RENDER_H;
viewCtx.imageSmoothingEnabled = false;

const mapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
const mapContext = mapCanvas.getContext('2d');
if (!mapContext) throw new Error('Minimap 2D context is unavailable');
const mapCtx: CanvasRenderingContext2D = mapContext;

const timeEl = document.getElementById('time') as HTMLElement;
const exploredEl = document.getElementById('explored') as HTMLElement;
const overlayEl = document.getElementById('overlay') as HTMLElement;
const overlaySubEl = document.getElementById('overlay-sub') as HTMLElement;
const againBtn = document.getElementById('again') as HTMLButtonElement;
const restartBtn = document.getElementById('restart') as HTMLButtonElement;
const newMazeBtn = document.getElementById('new-maze') as HTMLButtonElement;

const game = new Game();
let exploration = new Exploration(game.maze);
let mapCell = 8;
let totalWalkable = countWalkable(game.maze);

const held = new Set<string>();
let paused = false;
let overlayVisible = false;
let lastFrameTime = performance.now();

function countWalkable(maze: Maze): number {
  let total = 0;
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (isWalkable(maze, col, row)) total++;
    }
  }
  return total;
}

function inputState(): InputState {
  const forward =
    (held.has('w') || held.has('arrowup') ? 1 : 0) + (held.has('s') || held.has('arrowdown') ? -1 : 0);
  const turn =
    (held.has('d') || held.has('arrowright') ? 1 : 0) + (held.has('a') || held.has('arrowleft') ? -1 : 0);
  return { forward, turn };
}

function layout(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fit = Math.min(vw / RENDER_W, vh / RENDER_H);
  const scale = fit >= 1 ? Math.floor(fit) : fit;
  viewCanvas.style.width = `${Math.floor(RENDER_W * scale)}px`;
  viewCanvas.style.height = `${Math.floor(RENDER_H * scale)}px`;

  const target = Math.max(110, Math.min(MINIMAP_TARGET_CSS, Math.floor(vw * 0.26), Math.floor(vh * 0.32)));
  mapCell = Math.max(3, Math.floor(target / game.maze.cols));
  mapCanvas.width = game.maze.cols * mapCell;
  mapCanvas.height = game.maze.rows * mapCell;
  mapCtx.imageSmoothingEnabled = false;
  document.documentElement.style.setProperty('--map-w', `${mapCanvas.width}px`);
}

function clearKeys(): void {
  held.clear();
}

function setPaused(next: boolean): void {
  paused = next;
  if (next) clearKeys();
  else lastFrameTime = performance.now();
}

function restart(): void {
  game.reset();
  exploration.reset();
}

function newMaze(): void {
  game.newMaze();
  exploration = new Exploration(game.maze);
  totalWalkable = countWalkable(game.maze);
  layout();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key.startsWith('Arrow') || event.key === ' ') event.preventDefault();
  const key = event.key.toLowerCase();
  if (event.repeat) return;
  if (key === 'r') {
    restart();
    return;
  }
  if (key === 'n') {
    newMaze();
    return;
  }
  held.add(key);
}

function onKeyUp(event: KeyboardEvent): void {
  held.delete(event.key.toLowerCase());
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function syncHud(): void {
  let exploredWalkable = 0;
  const { maze } = game;
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (isWalkable(maze, col, row) && exploration.explored[row * maze.cols + col] === 1) exploredWalkable++;
    }
  }
  const time = formatSeconds(game.elapsedMs);
  const percent = `${Math.round((exploredWalkable / totalWalkable) * 100)}%`;
  if (timeEl.textContent !== time) timeEl.textContent = time;
  if (exploredEl.textContent !== percent) exploredEl.textContent = percent;
}

function syncOverlay(): void {
  if (game.won && !overlayVisible) {
    overlayVisible = true;
    overlaySubEl.textContent = `用 ${formatSeconds(game.elapsedMs)} 找到出口，探索了 ${exploredEl.textContent} 的迷宫。`;
    overlayEl.hidden = false;
    againBtn.focus();
    return;
  }
  if (!game.won && overlayVisible) {
    overlayVisible = false;
    overlayEl.hidden = true;
    if (overlayEl.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }
}

function frame(now: number): void {
  const deltaMs = Math.min(Math.max(now - lastFrameTime, 0), MAX_FRAME_DELTA_MS);
  lastFrameTime = now;

  if (!paused && !game.won) {
    game.update(deltaMs / 1000, inputState());
    exploration.update(game.maze, game.x, game.y, game.angle);
  }

  renderView(viewCtx, game);
  renderMinimap(mapCtx, game.maze, exploration, game, mapCell);
  syncHud();
  syncOverlay();
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => setPaused(true));
window.addEventListener('focus', () => setPaused(false));
document.addEventListener('visibilitychange', () => setPaused(document.hidden));
window.addEventListener('resize', layout);

restartBtn.addEventListener('click', restart);
newMazeBtn.addEventListener('click', newMaze);
againBtn.addEventListener('click', newMaze);

if (new URLSearchParams(window.location.search).has('qa')) {
  (window as unknown as Record<string, unknown>).__qa = { game, get exploration() { return exploration; } };
}

layout();
renderView(viewCtx, game);
renderMinimap(mapCtx, game.maze, exploration, game, mapCell);
syncHud();
requestAnimationFrame(frame);
