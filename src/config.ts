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

// 墙体大块石面：错缝大石砖 + 墙基 + 石梁，少量大色面 + 低对比接缝
export const BRICK_ROWS = 2;
export const BRICK_COLS = 2;

// 古老地宫秘境：深暖岩顶、灰褐石墙、极弱暗金边缘、暗赭石灰地面
export const CEILING_RGB: readonly [number, number, number] = [38, 31, 25];
export const WALL_RGB: readonly [number, number, number] = [118, 106, 90];
export const WALL_SIDE_SHADE = 0.72;
export const WALL_EDGE_RGB: readonly [number, number, number] = [164, 134, 78];
export const FLOOR_RGB: readonly [number, number, number] = [70, 56, 44];
export const EXIT_GLOW_RGB: readonly [number, number, number] = [255, 200, 87];

// 场景基层：视距外/极远处的深暖底色，拱顶横向石梁色
export const SCENE_DEEP_RGB: readonly [number, number, number] = [16, 12, 9];
export const SCENE_BEAM_RGB: readonly [number, number, number] = [58, 49, 39];

// 大型装饰：石色/符文暗金/晶石淡青，密度上限与出现概率（路口另有组合逻辑）
export const DECOR_STONE_RGB: readonly [number, number, number] = [126, 112, 94];
export const DECOR_RUNE_RGB: readonly [number, number, number] = [150, 122, 72];
export const DECOR_CRYSTAL_RGB: readonly [number, number, number] = [122, 166, 160];
export const DECOR_LIMITS: Readonly<Record<'pillar' | 'altar' | 'stele' | 'rune' | 'crystal', number>> = {
  pillar: 26,
  altar: 14,
  stele: 12,
  rune: 16,
  crystal: 4,
};
export const DECOR_CHANCE: Readonly<Record<'pillar' | 'altar' | 'stele' | 'rune' | 'crystal', number>> = {
  pillar: 0.5,
  altar: 0.45,
  stele: 0.4,
  rune: 0.4,
  crystal: 0.07,
};

export const COLORS = {
  page: '#000000',
  accent: '#ffc857',
  hud: '#a89c86',
  hudDim: '#6b6252',
  panel: '#16110c',
  panelBorder: '#3a3126',
  minimapFrame: '#241f18',
  mapFloorDim: '#262019',
  mapWallDim: '#3b342a',
  mapFloorLit: '#4c4132',
  mapWallLit: '#6d6049',
  mapPlayer: '#ffffff',
} as const;
