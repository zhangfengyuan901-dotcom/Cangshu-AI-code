// Bundled by build-plugins.cjs after a reviewed public model-catalog snapshot.
// Task Plugin API v1, New API v1.0.0-rc.41. No network or secrets in plugin source.
const MODELS = Object.keys(SPEC.models);
const STATUSES = { queued: 'QUEUED', processing: 'IN_PROGRESS', running: 'IN_PROGRESS', succeeded: 'SUCCESS', failed: 'FAILURE' };
export const meta = {
  apiVersion: 1, key: SPEC.key, name: SPEC.name, version: '0.3.0',
  author: { name: 'PIKNO' }, baseUrl: SPEC.baseUrl, auth: 'api_key',
  description: { en: 'Video-only asynchronous tasks. Images are routed separately through PackyAPI.', zh: '仅视频异步任务；图片由独立 PackyAPI 渠道处理。' },
  models: MODELS, fetchMode: 'per_task',
  protocols: ['openai_video'],
  routes: [
    { method: 'POST', path: '/' + SPEC.key + '/tasks', type: 'submit', decode: 'create', render: 'result', models: MODELS },
    { method: 'GET', path: '/' + SPEC.key + '/tasks/:task_id', type: 'query', render: 'result' },
  ],
  usageSchema: {
    requests: { type: 'number', unit: 'count', description: { en: 'Video generation unit price', zh: '视频生成单价' } },
    seconds: { type: 'number', unit: 'second', description: { en: 'Video generation unit price', zh: '视频生成单价' } },
    image_count: { type: 'number', unit: 'count', description: { en: 'Image generation unit price', zh: '图片生成单价' } },
    reference_images: { type: 'number', unit: 'count', description: { en: 'Reference image unit price', zh: '参考图片单价' } },
    resolution: { enum: ['unspecified', 'auto', '480p', '720p', '1080p', '1k', '2k', '4k'] },
    quality: { enum: ['unspecified', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
    variant: { enum: ['unspecified', 'Flare', 'Sunburst'] },
  },
};

function modelConfig(model) {
  if (!Object.prototype.hasOwnProperty.call(SPEC.models, model)) throw new Error('Unsupported model; use the PIKNO model catalog');
  return SPEC.models[model];
}
function normalize(input, model) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A JSON object is required');
  const config = modelConfig(model);
  if (config.kind !== 'video') throw new Error('This provider plugin supports video only');
  const allowed = SPEC.fields[config.kind];
  for (const key of Object.keys(input)) {
    if (key !== 'model' && allowed.indexOf(key) < 0) throw new Error('Unsupported request field: ' + key);
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('prompt must be non-empty');
  if (input.prompt.length > (config.maxPrompt || 10000)) throw new Error('prompt exceeds the model limit');
  for (const key of ['n', 'concurrency', 'number_of_runs']) {
    if (input[key] !== undefined && input[key] !== 1) throw new Error('Pilot integration supports one output per task; ' + key + ' must be 1');
  }
  const body = {};
  for (const key of allowed) if (input[key] !== undefined) body[key] = input[key];
  if (config.kind === 'video') {
    if (!Number.isInteger(body.duration) || body.duration < 1 || body.duration > 30) throw new Error('An explicit integer duration from 1 to 30 seconds is required');
    if (config.durations.length && config.durations.indexOf(body.duration) < 0) throw new Error('duration is not available for this model');
    if (typeof body.resolution !== 'string') throw new Error('An explicit resolution is required for video');
  }
  if (body.resolution !== undefined) {
    if (typeof body.resolution !== 'string') throw new Error('resolution must be a string');
    const match = config.resolutions.find(value => value.toLowerCase() === body.resolution.toLowerCase());
    if (!match) throw new Error('resolution is not available for this model');
    body.resolution = match;
  } else if (config.defaultResolution) body.resolution = config.defaultResolution;
  if (body.quality === undefined && config.defaultQuality) body.quality = config.defaultQuality;
  if (body.quality !== undefined && config.qualities.indexOf(body.quality) < 0) throw new Error('quality is not available for this model');
  if (body.variant === undefined && config.variant) body.variant = config.variant;
  if (body.variant !== undefined && (!config.variants || config.variants.indexOf(body.variant) < 0)) throw new Error('variant is not available for this model');
  const ratio = body.aspect_ratio || body.ratio;
  if (ratio !== undefined && config.ratios.length && config.ratios.indexOf(ratio) < 0) throw new Error('aspect ratio is not available for this model');
  for (const field of ['images', 'image_urls', 'videos', 'video_urls', 'audios', 'audio_urls']) {
    if (body[field] === undefined) continue;
    if (!Array.isArray(body[field])) throw new Error(field + ' must be an array');
    const kind = field.indexOf('image') === 0 ? 'image' : field.indexOf('video') === 0 ? 'video' : 'audio';
    if (body[field].length > config.limits[kind]) throw new Error(field + ' exceeds the model limit');
    for (const item of body[field]) {
      const value = typeof item === 'string' ? item : item && (item.url || item.data_url);
      if (typeof value !== 'string' || !/^(https?:\/\/|data:image\/)/.test(value)) throw new Error('Reference media must be a public HTTP(S) URL or image data URL');
      if (SPEC.provider === 'canseedream' && kind !== 'image' && (!item || typeof item !== 'object' || typeof item.durationSeconds !== 'number' || !Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0)) throw new Error('Audio/video references require url and positive durationSeconds');
    }
  }
  const imageCount = (body.images || body.image_urls || []).length;
  if (config.minImages && imageCount < config.minImages) throw new Error('This model requires reference images');
  if (body.images && body.image_urls) throw new Error('Use only one reference image field');
  if (SPEC.provider === 'sanbao') {
    body.model = config.upstreamModel;
    body.concurrency = 1;
  } else if (config.kind === 'video') {
    body.model = 'video'; body.provider_route = config.route;
    if (config.line) body.provider_line = config.line;
    body.number_of_runs = 1; body.enhance = false;
  } else {
    body.model = config.upstreamModel; body.n = 1;
  }
  return { config, body, imageCount };
}
function endpoint(ctx, config) {
  if (ctx.baseUrl.replace(/\/+$/, '') !== SPEC.baseUrl) throw new Error('Channel Base URL must match the reviewed provider origin');
  return SPEC.baseUrl + config.path;
}
function bearer(ctx) {
  const value = String(ctx.authHeader || ctx.apiKey || '').trim();
  if (!value) throw new Error('Channel API key is required');
  return /^Bearer\s+/i.test(value) ? value : 'Bearer ' + value;
}
function envelope(body) {
  if (!body || typeof body !== 'object') return {};
  return body.data && !Array.isArray(body.data) ? body.data : body;
}
function submission(body) {
  if (!body || typeof body !== 'object') throw new Error('Upstream returned no task object');
  const data = envelope(body);
  const tasks = data.tasks || body.tasks;
  if (tasks !== undefined) {
    if (!Array.isArray(tasks) || tasks.length !== 1) throw new Error('Unexpected upstream task count; do not resubmit, inspect the provider task log');
    return tasks[0];
  }
  return data;
}
function media(data) {
  const content = data.content || data;
  const found = [];
  function add(value, type) {
    if (typeof value === 'string' && /^https?:\/\//.test(value) && !found.some(item => item.url === value)) found.push({ type, url: value });
  }
  add(content.image_url, 'image'); add(content.video_url, 'video');
  if (Array.isArray(content.images)) for (const item of content.images) add(typeof item === 'string' ? item : item.url, 'image');
  return found;
}
function reason(data) {
  const error = data.error;
  return (typeof error === 'string' ? error : error && error.message) || 'Upstream task failed';
}
export const native = {
  create(ctx) {
    if (ctx.body.kind !== 'json') throw new Error('Only JSON requests are supported');
    const input = ctx.body.value;
    normalize(input, input && input.model);
    return { kind: 'submit', model: input.model, requestBody: input };
  },
  result(ctx, task) {
    const data = envelope(task.data);
    return {
      id: task.task_id, status: task.status, progress: task.progress || '0%',
      outputs: task.status === 'SUCCESS' ? media(data) : [],
      error: task.status === 'FAILURE' ? (task.fail_reason || reason(data)) : null,
      link_expires_in: typeof data.link_expires_in === 'number' ? data.link_expires_in : null,
    };
  },
};
// Host-owned /v1/videos uses the same normalized driver and billing facts as
// native routes. Do not accept metadata overrides or silently discard fields.
export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (!ctx.body || ctx.body.kind !== 'json') throw new Error('PIKNO video API requires a JSON body; file upload is not supported');
      const input = ctx.body.value;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A JSON object is required');
      const allowed = ['model', 'prompt', 'seconds', 'resolution', 'aspect_ratio', 'image_urls', 'video_urls', 'audio_urls', 'generate_audio'];
      for (const field of Object.keys(input)) if (allowed.indexOf(field) < 0) throw new Error('Unsupported video field: ' + field);
      if (input.model !== ctx.model) throw new Error('Model must match the requested model');
      let seconds = input.seconds;
      if (typeof seconds === 'string' && /^[1-9][0-9]?$/.test(seconds)) seconds = Number(seconds);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('seconds must be an integer from 1 to 30');
      const body = { model: ctx.model, prompt: input.prompt, duration: seconds, resolution: input.resolution };
      if (SPEC.provider === 'sanbao') {
        if (input.generate_audio !== undefined) throw new Error('generate_audio is not supported by this model');
        if (input.aspect_ratio !== undefined) body.ratio = input.aspect_ratio;
        for (const pair of [['image_urls', 'images'], ['video_urls', 'videos'], ['audio_urls', 'audios']]) {
          if (input[pair[0]] !== undefined) body[pair[1]] = input[pair[0]];
        }
      } else {
        for (const field of ['aspect_ratio', 'image_urls', 'video_urls', 'audio_urls', 'generate_audio']) {
          if (input[field] !== undefined) body[field] = input[field];
        }
        if (body.generate_audio !== undefined && typeof body.generate_audio !== 'boolean') throw new Error('generate_audio must be boolean');
      }
      normalize(body, ctx.upstreamModel || ctx.model);
      return { kind: 'submit', model: ctx.model, requestBody: body };
    },
    render(ctx, task) {
      const result = native.result(ctx, task);
      // Host supplies canonical id, model, status, progress and timestamps.
      return { outputs: result.outputs, error: result.error, link_expires_in: result.link_expires_in };
    },
  },
};
export function listArtifacts(task) {
  return task.status === 'SUCCESS' && media(envelope(task.data)).some(item => item.type === 'video')
    ? [{ key: 'video', type: 'video', mimeType: 'video/mp4' }] : [];
}
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== 'video') throw new Error('artifact_not_found');
  const video = media(envelope(ctx.data)).find(item => item.type === 'video');
  if (!video || !/^https:\/\//.test(video.url)) throw new Error('artifact_not_found');
  if (!ctx.clientRequest || ['GET', 'HEAD'].indexOf(ctx.clientRequest.method) < 0) throw new Error('Unsupported content method');
  // The host enforces task ownership and SSRF policy; media hosts never receive
  // the upstream API key or the customer's Authorization header.
  return { url: video.url, method: ctx.clientRequest.method, credentialless: true };
}
export function buildSubmitRequest(ctx) {
  const normalized = normalize(ctx.requestBody, ctx.upstreamModel || ctx.model);
  const headers = { Authorization: bearer(ctx), 'Content-Type': 'application/json' };
  if (SPEC.provider === 'canseedream') {
    if (!ctx.publicTaskId) throw new Error('A durable gateway task ID is required');
    headers['Idempotency-Key'] = 'pikno-' + ctx.publicTaskId;
  }
  return { url: endpoint(ctx, normalized.config), method: 'POST', headers, body: normalized.body };
}
export function parseSubmitResponse(ctx, response) {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('Upstream rejected submission (HTTP ' + response.statusCode + '); do not blindly retry');
  const data = submission(response.body);
  const id = data.id || data.task_id || data.taskId;
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Upstream task ID missing; check provider history before retrying');
  return { taskId: id, taskData: { data }, state: { config: modelConfig(ctx.upstreamModel || ctx.model) } };
}
export function buildQueryRequest(ctx) {
  const config = ctx.state && ctx.state.config || modelConfig(ctx.upstreamModel || ctx.model);
  // Paths are fixed from our catalog, never accepted from a client or provider response.
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(config.path) || config.path.indexOf('..') >= 0) throw new Error('Invalid stored query path');
  return { url: endpoint(ctx, config) + '/' + encodeURIComponent(ctx.taskId), method: 'GET', headers: { Authorization: bearer(ctx) } };
}
export function parseTaskResult(ctx, body) {
  const data = envelope(body);
  const status = Object.prototype.hasOwnProperty.call(STATUSES, data.status) ? STATUSES[data.status] : 'UNKNOWN';
  if (status === 'SUCCESS' && !media(data).length) throw new Error('Upstream reported success without a result URL');
  const result = { status };
  if (typeof data.progress === 'number' && Number.isFinite(data.progress)) result.progress = Math.max(0, Math.min(100, data.progress)) + '%';
  if (status === 'FAILURE') result.reason = reason(data).slice(0, 500);
  return result;
}
export function extractUsage(ctx) {
  const normalized = normalize(ctx.requestBody, ctx.upstreamModel || ctx.model);
  return {
    requests: 1, seconds: normalized.config.kind === 'video' ? normalized.body.duration : 0,
    image_count: normalized.config.kind === 'image' ? 1 : 0,
    reference_images: normalized.imageCount,
    resolution: (normalized.body.resolution || 'unspecified').toLowerCase(),
    quality: normalized.body.quality || 'unspecified', variant: normalized.body.variant || 'unspecified',
  };
}
