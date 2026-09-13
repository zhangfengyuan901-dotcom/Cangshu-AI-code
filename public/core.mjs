// 纯逻辑模块：不依赖 DOM / fetch，可在浏览器与 Node 中运行，便于单测。

export function isVideo(model) {
  return model?.type === 'video' || model?.category === 'video';
}
export function isImage(model) {
  return model?.type === 'image' || model?.category === 'image';
}

export const VIDEO_ROUTES = [
  { id: 'hailuo_h3_2k_line2', name: 'MinimaxH3', max_images: 9, max_videos: 3, max_audios: 3, max_media_files: 12, resolutions: ['2k'], default_resolution: '2k', summary: '9图 / 3视频 / 3音频 · 合计最多12个 · 2K' },
  { id: 'wan30_720p_real', name: 'WAN3.0', max_images: 10, max_videos: 5, max_audios: 5, max_media_files: 20, resolutions: ['720p'], default_resolution: '720p', summary: '10图 / 5视频 / 5音频 · 支持真人素材' },
  { id: 'sd2_limited_line3', name: 'seedance2.0', max_images: 9, max_videos: 3, max_audios: 3, max_media_files: 15, resolutions: ['720p'], default_resolution: '720p', summary: '9图 / 3视频 / 3音频 · 支持真人素材' },
  { id: 'sd25_30img_special', name: 'seedance2.5', max_images: 30, max_videos: 0, max_audios: 0, max_media_files: 30, resolutions: ['720p'], default_resolution: '720p', summary: '最多30张图片 · 不支持视频和音频素材' },
];
export const IMAGE_ROUTES = [
  { id: 'image_2_5_flare', name: 'Image 2.5 Flare' },
  { id: 'image_2_5_sunburst', name: 'Image 2.5 Sunburst' },
];
export function hamsterModelName(model) {
  const route = [...VIDEO_ROUTES, ...IMAGE_ROUTES].find((r) => r.id === model?.id);
  if (route) return route.name;
  return /^仓鼠线路[一二三四五六\d]+$/.test(model?.name || '') ? model.name : '仓鼠线路';
}
export function mapUpstreamModels(models) {
  const usable = (Array.isArray(models) ? models : []).filter((m) => m?.id && m.enabled !== false);
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
  for (const model of VIDEO_ROUTES) text = text.split(model.id).join(model.name);
  return text.replace(/https?:\/\/[^\s<>"']+/gi, '服务地址')
    .replace(/running\s*hub|三宝(?:影像工坊)?|sanbao(?:beauty)?|火山方舟|方舟|volcengine|veadk|hailuo|doubao|gpt[- ]?image\S*/gi, '仓鼠服务');
}
export function mediaLimitError(model, media = []) {
  if (!model) return '请先选择线路';
  const counts = { image: 0, video: 0, audio: 0 };
  for (const item of media) counts[item.kind] = (counts[item.kind] || 0) + 1;
  const fields = { image: 'max_images', video: 'max_videos', audio: 'max_audios' };
  const labels = { image: '图片', video: '视频', audio: '音频' };
  for (const [kind, field] of Object.entries(fields)) {
    const limit = isImage(model) && kind !== 'image' ? 0 : model[field];
    if (Number.isFinite(limit) && counts[kind] > limit) {
      return limit === 0 ? `${hamsterModelName(model)}不支持${labels[kind]}素材，请移除后再生成` : `${hamsterModelName(model)}最多支持${limit}个${labels[kind]}素材`;
    }
  }
  if (Number.isFinite(model.max_media_files) && media.length > model.max_media_files) return `${hamsterModelName(model)}素材总数最多${model.max_media_files}个`;
  return '';
}

export function concurrencyOptions(model) {
  const opts = model?.concurrency_options;
  return Array.isArray(opts) && opts.length ? opts : [1, 2, 4];
}

function first(arr, fallback) {
  return Array.isArray(arr) && arr.length ? arr[0] : fallback;
}

export function defaultVideoOptions(model) {
  return {
    ratio: model?.default_ratio || first(model?.ratios, '16:9'),
    resolution: model?.default_resolution || first(model?.resolutions, '720p'),
    duration: Number.isFinite(model?.default_duration_seconds)
      ? model.default_duration_seconds
      : first(model?.durations, 5),
    reference: 'all',
  };
}

export function defaultImageOptions(model) {
  return {
    aspect_ratio: model?.default_aspect_ratio || first(model?.aspect_ratios, 'auto'),
    quality: model?.default_quality || first(model?.quality_options, 'high'),
  };
}

export function estimateCost(model, { resolution, duration } = {}) {
  if (!model) return 0;
  let cost = 0;
  if (model.billing === 'per_second') {
    const byRes = model.price_per_second_by_resolution_credits;
    const unit = (byRes && typeof byRes === 'object')
      ? Number(byRes[resolution] ?? model.price_per_second_credits ?? model.price_credits ?? 0)
      : Number(model.price_per_second_credits ?? model.price_credits ?? 0);
    cost = unit * Number(duration || 0);
  } else {
    const byRes = model.price_by_resolution_credits;
    const unit = (byRes && typeof byRes === 'object' && Object.keys(byRes).length)
      ? Number(byRes[resolution] ?? model.price_credits ?? 0)
      : Number(model.price_credits ?? 0);
    cost = unit;
  }
  return Math.round(cost * 100) / 100;
}

export function buildVideoPayload({ model, prompt, ratio, resolution, duration, reference, concurrency, images = [], videos = [], audios = [] }) {
  return { model: model.id, prompt, ratio, resolution, duration, concurrency, reference, images, videos, audios };
}

export function buildImagePayload({ model, prompt, aspect_ratio, quality, concurrency, images = [] }) {
  return { model: model.id, prompt, aspect_ratio, images, quality, concurrency };
}

export function extractTaskIds(payload) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const ids = tasks.map((t) => t?.task_id ?? t?.taskId ?? t?.id).filter(Boolean);
  if (ids.length) return ids;
  const single = payload?.data?.task_id ?? payload?.data?.taskId ?? payload?.data?.id
    ?? payload?.task_id ?? payload?.taskId ?? payload?.id;
  return single ? [single] : [];
}
