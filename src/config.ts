export const ROOMS_X = 10;
export const ROOMS_Y = 7;

export const GRID_COLS = ROOMS_X * 2 + 1;
export const GRID_ROWS = ROOMS_Y * 2 + 1;

export type GridPos = { col: number; row: number };

export const START: GridPos = { col: 1, row: 1 };

// 右下角房间格：GRID_COLS - 2 = 19, GRID_ROWS - 2 = 13
export const EXIT: GridPos = { col: GRID_COLS - 2, row: GRID_ROWS - 2 };

// 第一人称视野：视野角与可见距离（格），主画面与小地图探索共用
export const FOV_DEG = 65;
export const VIEW_DISTANCE = 6;

// 低分辨率离屏渲染尺寸，等比放大显示
export const RENDER_W = 320;
export const RENDER_H = 180;

// 探索射线数量（覆盖整个 FOV）
export const EXPLORE_RAY_COUNT = 160;

// 运动：世界单位为格，速率按秒计算，与帧率无关
export const MOVE_SPEED = 3.2;
export const TURN_SPEED = 2.8;
export const PLAYER_RADIUS = 0.25;
export const MAX_FRAME_DELTA_MS = 100;
export const MAX_SUBSTEP_DISTANCE = 0.08;

// 小地图目标 CSS 尺寸（会按窗口适配）
export const MINIMAP_TARGET_CSS = 220;

// 墙体程序化砖纹
export const BRICK_ROWS = 4;
export const BRICK_COLS = 4;

export const WALL_RGB: readonly [number, number, number] = [110, 104, 142];
export const WALL_SIDE_SHADE = 0.72;
export const FLOOR_RGB: readonly [number, number, number] = [54, 50, 72];

export const COLORS = {
  page: '#000000',
  accent: '#ffc857',
  hud: '#8a86a0',
  hudDim: '#55516b',
  panel: '#101018',
  panelBorder: '#26263a',
  minimapFrame: '#1c1c26',
  mapFloorDim: '#20202b',
  mapWallDim: '#34343f',
  mapFloorLit: '#3f3f56',
  mapWallLit: '#5b5b74',
  mapPlayer: '#ffffff',
} as const;
