// 纯逻辑模块：不依赖 DOM / fetch，可在浏览器与 Node 中运行，便于单测。

export function isVideo(model) {
  return model?.type === 'video' || model?.category === 'video';
}
export function isImage(model) {
  return model?.type === 'image' || model?.category === 'image';
}

export const OFFICIAL_VIDEO_ROUTE = {
  id: 'official_backup_480p', name: '官方备选线路-480P', type: 'video', provider: 'official',
  max_images: 9, max_videos: 3, max_audios: 3, max_media_files: 15,
  resolutions: ['480p'], default_resolution: '480p',
  ratios: ['16:9','9:16','1:1','3:4','4:3','21:9'],
  durations: Array.from({length:27},(_,i)=>i+4), default_duration_seconds: 4,
  concurrency_options: [1], billing: 'per_second', display_price_yuan_per_second: 0.55,
  summary: '9图 / 3视频 / 3音频 · 0.55元/秒 · 素材临时转存',
};

export function hamsterModelName(model) {
  if (/^(main-(video|image)-[a-z0-9]+|backup-video-480)$/.test(model?.id || '')) return String(model.name || '仓鼠线路');
  if (model?.id === OFFICIAL_VIDEO_ROUTE.id) return OFFICIAL_VIDEO_ROUTE.name;
  return /^仓鼠线路[一二三四五六\d]+$/.test(model?.name || '') ? model.name : '仓鼠线路';
}
export function mapUpstreamModels(models) {
  return (Array.isArray(models) ? models : []).filter(m => m?.enabled !== false && /^(main-(video|image)-[a-z0-9]+|backup-video-480)$/.test(m?.id || ''));
}
export function publicText(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s<>"']+/gi, '服务地址')
    .replace(/running\s*hub|三宝(?:影像工坊)?|sanbao(?:beauty)?|video\s*fee|packy|canseedream|resend|seedance(?:2026)?|火山方舟|方舟|volcengine|veadk|hailuo|doubao|cloudflare|\bR2\b|gpt[- ]?image\S*|(?:sd_|image_)\w+|ep-[\w-]+|(?:sk|ark)-[\w-]+/gi, '仓鼠服务');
}
// A declared per-kind capability can exceed the relay's effective aggregate cap.
// Older relay catalogues omit max_media_total; their execution contract caps at 20.
export function mediaCapabilities(model) {
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:undefined;
  const total=[count(model?.max_media_total),count(model?.max_media_files),model?.billing_mode==='relay'?20:undefined].filter(value=>value!==undefined);
  return {image:count(model?.max_images),video:isImage(model)?0:count(model?.max_videos),audio:isImage(model)?0:count(model?.max_audios),total:total.length?Math.min(...total):undefined};
}
export function modelMediaSummary(model) {
  if(!model)return '';
  const limits=mediaCapabilities(model),effective=kind=>Math.min(limits[kind]??0,limits.total??Infinity);
  return `${effective('image')}图 / ${effective('video')}视频 / ${effective('audio')}音频${limits.total===undefined?'':` · 合计最多 ${limits.total} 个`}`;
}
export const supportsImageMarks=model=>Boolean(model)&&!mediaLimitError(model,[{kind:'image'},{kind:'image'}]);
export function mediaLimitError(model, media = []) {
  if (!model) return '请先选择线路';
  const counts = { image: 0, video: 0, audio: 0 };
  for (const item of media) counts[item.kind] = (counts[item.kind] || 0) + 1;
  const limits=mediaCapabilities(model);
  const labels = { image: '图片', video: '视频', audio: '音频' };
  for (const kind of Object.keys(labels)) {
    const limit = limits[kind];
    if (Number.isFinite(limit) && counts[kind] > limit) {
      return limit === 0 ? `${hamsterModelName(model)}不支持${labels[kind]}素材，请移除后再生成` : `${hamsterModelName(model)}最多支持${limit}个${labels[kind]}素材`;
    }
  }
  if (limits.total!==undefined && media.length > limits.total) return `${hamsterModelName(model)}素材总数最多${limits.total}个，请在上传前减少素材`;
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
  const ratio = model?.default_aspect_ratio || first(model?.aspect_ratios, 'auto');
  const sizes = imageSizesForRatio(model, ratio);
  return {
    aspect_ratio: ratio,
    ...(sizes.length ? {size:sizes.includes(model?.default_size)?model.default_size:sizes[0]} : {}),
    quality: model?.default_quality || first(model?.quality_options, 'high'),
  };
}

export function imageSizeRatio(size) {
  if (size === 'auto') return 'auto';
  if (!/^[1-9]\d{2,3}x[1-9]\d{2,3}$/.test(String(size))) return '';
  const [width,height]=size.split('x').map(Number);
  let a=width,b=height;while(b){[a,b]=[b,a%b];}
  return `${width/a}:${height/a}`;
}

export function imageSizesForRatio(model, ratio) {
  return (Array.isArray(model?.size_options)?model.size_options:[]).filter(size=>imageSizeRatio(size)===ratio);
}

export function closestImageRatio(width, height, ratios = []) {
  if (!(width > 0 && height > 0)) return '';
  const candidates = ratios.map(value => {
    const match = String(value).match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    return match ? { value, ratio:Number(match[1])/Number(match[2]) } : null;
  }).filter(item => item && Number.isFinite(item.ratio) && item.ratio > 0);
  if (!candidates.length) return ratios.includes('auto') ? 'auto' : '';
  return candidates.reduce((best,item) => Math.abs(Math.log(item.ratio/(width/height))) < Math.abs(Math.log(best.ratio/(width/height))) ? item : best).value;
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
  return { model: model.id, ...(model.price_version !== undefined ? {price_version:model.price_version}:{}), prompt, ratio, resolution, duration, concurrency, reference, images, videos, audios };
}

export function buildOfficialVideoProviderPayload(payload = {}, providerModelId = '') {
  const urlOf = value => String(typeof value === 'string' ? value : value?.url || '').trim();
  const content = [{ type: 'text', text: String(payload.prompt || '').trim() }];
  for (const [index, image] of (Array.isArray(payload.images) ? payload.images : []).entries()) {
    const role = payload.reference === 'startEnd' && index < 2 ? (index === 0 ? 'first_frame' : 'last_frame') : 'reference_image';
    content.push({ type: 'image_url', role, image_url: { url: urlOf(image) } });
  }
  for (const video of (Array.isArray(payload.videos) ? payload.videos : [])) {
    content.push({ type: 'video_url', role: 'reference_video', video_url: { url: urlOf(video) } });
  }
  for (const audio of (Array.isArray(payload.audios) ? payload.audios : [])) {
    content.push({ type: 'audio_url', role: 'reference_audio', audio_url: { url: urlOf(audio) } });
  }
  return {
    model: providerModelId,
    duration: Number(payload.duration),
    resolution: OFFICIAL_VIDEO_ROUTE.default_resolution,
    ratio: payload.ratio,
    content,
  };
}

export function buildImagePayload({ model, prompt, aspect_ratio, size, quality, concurrency, images = [] }) {
  return { model: model.id, ...(model.price_version !== undefined ? {price_version:model.price_version}:{}), prompt, aspect_ratio, ...(size?{size}:{}), images, quality, concurrency };
}

export function buildImageEditPrompt(instruction, hasMarks) {
  const request = String(instruction || '').trim();
  if (!request) throw new Error('请输入修改要求');
  const references = hasMarks
    ? '@图片1是原图，也是唯一的画面、人物和风格基准。@图片2是手绘标注图，仅用来定位需要修改的区域；彩色手绘线条只是编辑指示，不属于画面内容，最终结果中不得出现标记。'
    : '@图片1是原图，也是唯一的画面、人物和风格基准。';
  return `对已有图片做局部修改，不要重新设计整张图。${references}\n修改要求：${request}\n只改变修改要求涉及的内容；其余人物身份、服装、构图、背景、光线和画幅尽量保持与原图一致。`;
}

export function extractTaskIds(payload) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const ids = tasks.map((t) => t?.task_id ?? t?.taskId ?? t?.id).filter(Boolean);
  if (ids.length) return ids;
  const single = payload?.data?.task_id ?? payload?.data?.taskId ?? payload?.data?.id
    ?? payload?.task_id ?? payload?.taskId ?? payload?.id;
  return single ? [single] : [];
}
