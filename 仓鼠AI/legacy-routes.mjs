// Internal legacy routing only. Never served to the browser.
import {isImage,OFFICIAL_VIDEO_ROUTE} from './public/core.mjs';
export * from './public/core.mjs';
export const VIDEO_ROUTES = [
  { id: 'sd_2_5_once_720p', name: 'SD2.5-按次-720P', max_images: 30, max_videos: 10, max_audios: 10, max_media_files: 50, resolutions: ['720p'], default_resolution: '720p', ratios: ['16:9','9:16','1:1','3:4','4:3','21:9'], durations: Array.from({length:27},(_,i)=>i+4), billing: 'per_generation', display_price_yuan: 15, summary: '30图 / 10视频 / 10音频 · 15元/次 · 原生支持真人' },
  { id: 'sd_2_5_once_line3', name: 'SD2.5-按次-线路3', max_images: 30, max_videos: 10, max_audios: 10, max_media_files: 50, resolutions: ['480p','720p'], default_resolution: '720p', ratios: ['16:9','9:16','1:1','3:4','4:3','21:9'], durations: Array.from({length:27},(_,i)=>i+4), billing: 'per_generation', display_price_yuan: 15, summary: '30图 / 10视频 / 10音频 · 15元/次' },
  { id: 'sd_2_5_900_30s', name: 'SD2.5-9图-30秒', max_images: 9, max_videos: 0, max_audios: 0, max_media_files: 9, resolutions: ['720p'], default_resolution: '720p', ratios: ['16:9','9:16','1:1','3:4','4:3','21:9'], durations: [30], default_duration_seconds: 30, billing: 'per_generation', display_price_yuan: 6, summary: '9图 / 0视频 / 0音频 · 固定30秒 · 6元/次 · 支持真人' },
];
export const IMAGE_ROUTES = [
  { id: 'image_2_5_flare', name: 'Image 2.5 Flare' },
  { id: 'image_2_5_sunburst', name: 'Image 2.5 Sunburst' },
  { id: 'gpt-image2', name: 'gpt-image2' },
  { id: 'gpt-image2-1K', name: 'gpt-image2-1K' },
  { id: 'gpt-image2-2K', name: 'gpt-image2-2K' },
  { id: 'gpt-image2-4K', name: 'gpt-image2-4K' },
];
export function hamsterModelName(model) {
  if(/^(main-(video|image)-[a-z0-9]+|backup-video-480)$/.test(model?.id||''))return model.name||'仓鼠线路';
  const route = [...VIDEO_ROUTES, OFFICIAL_VIDEO_ROUTE, ...IMAGE_ROUTES].find((r) => r.id === model?.id);
  if (route) return route.name;
  return /^仓鼠线路[一二三四五六\d]+$/.test(model?.name || '') ? model.name : '仓鼠线路';
}
export function mapUpstreamModels(models) {
  const usable = (Array.isArray(models) ? models : []).filter((m) => m?.id && m.enabled !== false);
  const wallet=usable.filter(m=>/^(main-(video|image)-[a-z0-9]+|backup-video-480)$/.test(m.id));
  if(wallet.length)return wallet;
  const video = VIDEO_ROUTES.flatMap((route) => {
    const model = usable.find((m) => m.id === route.id);
    return model ? [{ ...model, ...route, type: 'video', description: route.summary }] : [];
  });
  const images = IMAGE_ROUTES.flatMap((route) => {
    const model = usable.find((m) => m.id === route.id && isImage(m));
    return model ? [{ ...model, name: model.name || route.name, description: model.description || 'Image 2.5 图片生成' }] : [];
  });
  return [...video, ...images];
}
export function publicText(value) {
  let text = String(value ?? '');
  for (const model of [...VIDEO_ROUTES, OFFICIAL_VIDEO_ROUTE]) text = text.split(model.id).join(model.name);
  return text.replace(/https?:\/\/[^\s<>"']+/gi, '服务地址')
    .replace(/running\s*hub|三宝(?:影像工坊)?|sanbao(?:beauty)?|video\s*fee|packy|canseedream|resend|seedance(?:2026)?|火山方舟|方舟|volcengine|veadk|hailuo|doubao|cloudflare|\bR2\b|gpt[- ]?image\S*/gi, '仓鼠服务');
}
