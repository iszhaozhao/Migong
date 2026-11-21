import { BASE_RENDER_H, BASE_RENDER_W, MAX_BUFFER_H, MAX_BUFFER_W, MINIMAP_TARGET_CSS } from './config.ts';

export type ViewLayout = { scale: number; bufferW: number; bufferH: number };

/**
 * 铺满窗口的整数像素布局：CSS 尺寸恒为视口 100%，低分辨率缓冲 = ceil(视口 / scale)。
 * scale 取整数倍率，保证像素边缘清晰、不拉伸；缓冲按视口宽高比计算，保证无黑边/白边。
 * 缓冲上限由 MAX_BUFFER_* 约束，避免超大窗口把填充率拉爆。
 */
export function computeViewLayout(viewW: number, viewH: number): ViewLayout {
  const vw = Math.max(1, viewW);
  const vh = Math.max(1, viewH);
  let scale = Math.max(1, Math.round(Math.min(vw / BASE_RENDER_W, vh / BASE_RENDER_H)));
  scale = Math.max(scale, Math.ceil(Math.max(vw / MAX_BUFFER_W, vh / MAX_BUFFER_H)));
  return {
    scale,
    bufferW: Math.max(1, Math.ceil(vw / scale)),
    bufferH: Math.max(1, Math.ceil(vh / scale)),
  };
}

/** 小地图单格边长：目标约 MINIMAP_TARGET_CSS，随窗口收缩，且至少 3px 才能看清墙 */
export function computeMinimapCell(viewW: number, viewH: number, cols: number): number {
  const vw = Math.max(1, viewW);
  const vh = Math.max(1, viewH);
  const target = Math.max(96, Math.min(MINIMAP_TARGET_CSS, Math.floor(vw * 0.26), Math.floor(vh * 0.34)));
  return Math.max(3, Math.floor(target / cols));
}
