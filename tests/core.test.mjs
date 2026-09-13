import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isVideo, isImage, concurrencyOptions, defaultVideoOptions, defaultImageOptions,
  estimateCost, buildVideoPayload, buildImagePayload, extractTaskIds,
  hamsterModelName, VIDEO_ROUTES, mapUpstreamModels, mediaLimitError, publicText,
} from '../public/core.mjs';

const VIDEO = {
  id: 'sd2_9img_full', type: 'video', billing: 'per_second',
  resolutions: ['720p'], ratios: ['9:16', '16:9'], durations: [5, 10, 15],
  default_ratio: '16:9', default_resolution: '720p', default_duration_seconds: 10,
  price_per_second_by_resolution_credits: { '720p': 14.4 },
  concurrency_options: [1, 2, 4],
};
const VIDEO_FIXED = {
  id: 'sd2_value', type: 'video', billing: 'per_generation',
  resolutions: ['720p', '1080p'], ratios: ['16:9'], durations: [5],
  price_by_resolution_credits: { '720p': 40, '1080p': 80 }, price_credits: 40,
};
const IMAGE = {
  id: 'gpt-image2', type: 'image', billing: 'per_generation',
  aspect_ratios: ['auto', '1:1', '16:9'], quality_options: ['high', 'medium', 'low'],
  price_credits: 0.8,
};

test('isVideo / isImage 类型判断', () => {
  assert.equal(isVideo(VIDEO), true);
  assert.equal(isImage(IMAGE), true);
  assert.equal(isImage(VIDEO), false);
});

test('defaultVideoOptions 取默认值', () => {
  assert.deepEqual(defaultVideoOptions(VIDEO), { ratio: '16:9', resolution: '720p', duration: 10, reference: 'all' });
});

test('defaultImageOptions 取默认值', () => {
  assert.deepEqual(defaultImageOptions(IMAGE), { aspect_ratio: 'auto', quality: 'high' });
});

test('defaultImageOptions 优先使用模型声明的默认值', () => {
  assert.deepEqual(defaultImageOptions({
    aspect_ratios: ['1:1', '9:16'], default_aspect_ratio: '9:16',
    quality_options: ['low', 'high'], default_quality: 'high',
  }), { aspect_ratio: '9:16', quality: 'high' });
});

test('estimateCost 按秒计费', () => {
  assert.equal(estimateCost(VIDEO, { resolution: '720p', duration: 10 }), 144);
});

test('estimateCost 按次计费按画质取价', () => {
  assert.equal(estimateCost(VIDEO_FIXED, { resolution: '1080p' }), 80);
  assert.equal(estimateCost(VIDEO_FIXED, { resolution: '720p' }), 40);
});

test('estimateCost 图片按次计费', () => {
  assert.equal(estimateCost(IMAGE, {}), 0.8);
});

test('buildVideoPayload 组装字段', () => {
  const p = buildVideoPayload({
    model: VIDEO, prompt: 'hi', ratio: '9:16', resolution: '720p', duration: 5,
    reference: 'all', concurrency: 1, images: ['https://x/1.jpg'],
  });
  assert.equal(p.model, 'sd2_9img_full');
  assert.equal(p.reference, 'all');
  assert.deepEqual(p.images, ['https://x/1.jpg']);
  assert.deepEqual(p.videos, []);
});

test('buildImagePayload 组装字段', () => {
  const p = buildImagePayload({
    model: IMAGE, prompt: 'hi', aspect_ratio: '16:9', quality: 'low', concurrency: 2, images: ['https://x/a.jpg'],
  });
  assert.equal(p.model, 'gpt-image2');
  assert.equal(p.quality, 'low');
  assert.equal(p.concurrency, 2);
});

test('extractTaskIds 从 tasks 数组提取', () => {
  assert.deepEqual(extractTaskIds({ tasks: [{ task_id: 'a' }, { task_id: 'b' }] }), ['a', 'b']);
});

test('extractTaskIds 回退到 data.task_id', () => {
  assert.deepEqual(extractTaskIds({ data: { task_id: 'single' } }), ['single']);
});

test('concurrencyOptions 缺省回退', () => {
  assert.deepEqual(concurrencyOptions({}), [1, 2, 4]);
});

test('模型展示名使用指定视频名称和 Image 2.5 原名称', () => {
  assert.equal(hamsterModelName({ id: 'hailuo_h3_2k_line2', name: 'Hailuo-H3' }), 'MinimaxH3');
  assert.equal(hamsterModelName({ id: 'image_2_5_flare' }), 'Image 2.5 Flare');
  assert.equal(hamsterModelName({ id: 'sd2_limited_line3' }), 'seedance2.0');
  assert.equal(hamsterModelName({ id: 'sd25_30img_special' }), 'seedance2.5');
  assert.equal(hamsterModelName({ id: 'wan30_720p_real' }), 'WAN3.0');
  assert.equal(hamsterModelName({ id: 'model-c', name: '仓鼠-SD2.5' }), '仓鼠线路');
});
test('只保留四条视频线路，按指定顺序且保留上游价格', () => {
  const models = mapUpstreamModels([
    { id: 'removed', type: 'video' },
    ...[...VIDEO_ROUTES].reverse().map((r) => ({ id: r.id, type: 'video', name: '上游名称', max_images: 99, price_credits: 23 })),
    IMAGE, { id:'image_2_5_flare',name:'Image 2.5 Flare',type:'image',quality_options:['auto'],default_quality:'auto' },
  ]);
  assert.deepEqual(models.filter(isVideo).map((m) => m.id), VIDEO_ROUTES.map((r) => r.id));
  assert.equal(models[0].price_credits, 23);
  assert.equal(models[0].max_images, 9);
  assert.equal(defaultVideoOptions(models[0]).resolution, '2k');
  assert.equal(models.filter(isImage).length, 1);
  assert.equal(models.filter(isImage)[0].name, 'Image 2.5 Flare');
  assert.equal(defaultImageOptions(models.filter(isImage)[0]).quality, 'auto');
  assert.equal(mapUpstreamModels([{ ...VIDEO_ROUTES[0], enabled: false }]).length, 0);
});
test('四条线路素材边界：单类、总数及零视频音频', () => {
  const media = (image, video, audio) => ['image', 'video', 'audio'].flatMap((kind, i) => Array.from({ length: [image, video, audio][i] }, () => ({kind})));
  assert.equal(mediaLimitError(VIDEO_ROUTES[0], media(9, 3, 0)), '');
  assert.match(mediaLimitError(VIDEO_ROUTES[0], media(9, 3, 1)), /总数最多12/);
  assert.match(mediaLimitError(VIDEO_ROUTES[0], media(10, 0, 0)), /最多支持9/);
  assert.equal(mediaLimitError(VIDEO_ROUTES[1], media(10, 5, 5)), '');
  assert.match(mediaLimitError(VIDEO_ROUTES[1], media(10, 6, 0)), /最多支持5/);
  assert.equal(mediaLimitError(VIDEO_ROUTES[2], media(9, 3, 3)), '');
  assert.match(mediaLimitError(VIDEO_ROUTES[2], media(9, 3, 4)), /最多支持3/);
  assert.equal(mediaLimitError(VIDEO_ROUTES[3], media(30, 0, 0)), '');
  assert.match(mediaLimitError(VIDEO_ROUTES[3], media(31, 0, 0)), /最多支持30/);
  assert.match(mediaLimitError(VIDEO_ROUTES[3], media(1, 1, 0)), /不支持视频/);
  assert.match(mediaLimitError(VIDEO_ROUTES[3], media(1, 0, 1)), /不支持音频/);
});
test('系统错误显示隐藏服务商与地址', () => {
  const msg = publicText('RunningHub 三宝 方舟 hailuo_h3_2k_line2 https://www.runninghub.cn/error');
  assert.doesNotMatch(msg, /runninghub|三宝|方舟|hailuo|https:/i);
  assert.match(msg, /MinimaxH3/);
  assert.equal(publicText('seedance2.0不支持此配置'), 'seedance2.0不支持此配置');
});

test('图片列表仅允许 Image 2.5 两个子型号，保留原名与参数', () => {
  const models=mapUpstreamModels([
    IMAGE,{id:'image_2_5_flare',type:'image',name:'Image 2.5 Flare',price_credits:.7},
    {id:'image_2_5_sunburst',type:'image',name:'Image 2.5 Sunburst',max_images:9},
    {id:'unknown-image',type:'image',name:'Unknown'},
  ]);
  assert.deepEqual(models.map(m=>m.name),['Image 2.5 Flare','Image 2.5 Sunburst']);
  assert.equal(models[0].price_credits,.7);
  assert.equal(models[1].max_images,9);
});
