export type GridPos = { col: number; row: number };

// ==================== 地图尺寸与关键点 ====================

export const ROOMS_X = 10;
export const ROOMS_Y = 7;

export const GRID_COLS = ROOMS_X * 2 + 1;
export const GRID_ROWS = ROOMS_Y * 2 + 1;

export const START: GridPos = { col: 1, row: 1 };

// 门前交互格：终点房间格 (19,13)，玩家站在这里（或其来路）面向东开门
export const EXIT: GridPos = { col: GRID_COLS - 2, row: GRID_ROWS - 2 };
// 大门所在的墙面格：东边界墙 (20,13)。门是墙面上的特殊墙，始终阻挡通行
export const DOOR: GridPos = { col: GRID_COLS - 1, row: EXIT.row };
// 门的固定连接边：交互格西侧通道格，必须始终可走，动态墙不得触碰
export const DOOR_APPROACH: GridPos = { col: EXIT.col - 1, row: EXIT.row };

// ==================== 地图生成：环路与重试 ====================

export const LOOPS_MIN = 5;
export const LOOPS_MAX = 9;
export const PATH_LEN_MIN = 30;
export const PATH_LEN_MAX = 62;
export const GEN_MAX_TRIES = 40;

// ==================== 视野与投影 ====================

export const FOV_DEG = 65;
export const VIEW_DISTANCE = 6;

// 抬头/低头上限（度）。射线投射伪 3D 只能移动地平线，角度过大就会露出没有内容的空洞
export const PITCH_MAX_DEG = 14;

// ==================== 渲染尺寸（铺满窗口） ====================

// 参考尺寸：只用于推导整数像素倍率，不再是固定画面大小
export const BASE_RENDER_W = 320;
export const BASE_RENDER_H = 180;
// 缓冲上限：超高分屏下自动加大倍率，避免逐列射线数量失控
export const MAX_BUFFER_W = 480;
export const MAX_BUFFER_H = 300;

// ==================== 光照（手电筒） ====================

export const LIGHT_DIST_POWER = 1.35;
// 视野中央与边缘的亮度比：逐列按与视线夹角衰减
export const LIGHT_EDGE_GAIN = 0.4;
export const LIGHT_EDGE_POWER = 1.7;
// 屏幕暗角强度（叠加在墙面照明之上，不代替它）
export const VIGNETTE_ALPHA = 0.42;
export const FLOOR_GAIN = 0.9;

// ==================== 探索与小地图 ====================

export const EXPLORE_RAY_COUNT = 160;
// 小地图扇形光束的射线数：与第一人称共用 FOV / 视距 / 首个命中墙
export const MINIMAP_BEAM_RAYS = 64;
export const MINIMAP_TARGET_CSS = 180;

// ==================== 运动与碰撞 ====================

export const MOVE_SPEED = 3.2;
export const TURN_SPEED = 2.8;
export const PLAYER_RADIUS = 0.25;
export const MAX_FRAME_DELTA_MS = 100;
export const MAX_SUBSTEP_DISTANCE = 0.08;

// ==================== 鼠标视角 ====================

export const MOUSE_YAW_PER_PX = 0.0032;
export const MOUSE_PITCH_PER_PX = 0.0026;
// 平滑时间常数（秒）：越小越跟手，越大越顺滑
export const MOUSE_SMOOTH_SEC = 0.035;

// ==================== 大门交互 ====================

// 到门面的最大距离与最大朝向偏差，隔墙或远距离按 E 无效
export const DOOR_INTERACT_DISTANCE = 2.4;
export const DOOR_INTERACT_ANGLE_DEG = 48;
export const DOOR_OPEN_MS = 720;

// ==================== 中等模式：局部动态墙 ====================

export const DYNAMIC_INTERVAL_MS = 12000;
export const DYNAMIC_WARN_MS = 2000;
export const DYNAMIC_ANIM_MS = 500;
// 预警脉冲周期（毫秒）
export const DYNAMIC_PULSE_MS = 420;
export const DYNAMIC_MODULE_MIN = 2;
export const DYNAMIC_MODULE_MAX = 3;
// 一个模块的两格最大曼哈顿距离：保证只在局部改道
export const DYNAMIC_MODULE_SPAN = 4;
// 新墙与玩家碰撞体的最小净距（格）
export const DYNAMIC_SAFE_MARGIN = 0.35;
// 提交后的短暂视觉闪光，不影响碰撞
export const DYNAMIC_FLASH_MS = 260;

// ==================== 音频 ====================

export const MUSIC_VOLUME = 0.05;
export const MUSIC_FADE_SEC = 1.2;
export const MUSIC_STORAGE_KEY = 'moving-maze:music';

// ==================== 主页面 ====================

// 主页面背景演示镜头的自转速度（弧度/秒）
export const MENU_SPIN_RAD_PER_SEC = 0.22;

// ==================== 墙体纹理与配色 ====================

export const BRICK_ROWS = 4;
export const BRICK_COLS = 4;

// 门纹理的像素量化格数：与屏幕分辨率无关，保持像素风
export const DOOR_TEX_U = 28;
export const DOOR_TEX_V = 34;

export const WALL_RGB: readonly [number, number, number] = [110, 104, 142];
export const WALL_SIDE_SHADE = 0.72;
export const FLOOR_RGB: readonly [number, number, number] = [54, 50, 72];

export const DOOR_FRAME_RGB: readonly [number, number, number] = [58, 51, 80];
export const DOOR_PANEL_RGB: readonly [number, number, number] = [122, 88, 48];
export const DOOR_PANEL_DARK: readonly [number, number, number] = [74, 53, 28];
export const DOOR_SEAM_RGB: readonly [number, number, number] = [255, 233, 168];
export const DOOR_HANDLE_RGB: readonly [number, number, number] = [206, 196, 150];
export const DOOR_LIGHT_RGB: readonly [number, number, number] = [255, 246, 214];
// 动态墙预警/生长边缘的高亮色
export const WARN_RGB: readonly [number, number, number] = [255, 122, 92];

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
  mapBeam: 'rgba(255,226,160,0.13)',
  mapWarn: '#ff7a5c',
  warn: '#ff7a5c',
  doorPrompt: '#ffe9a8',
} as const;
