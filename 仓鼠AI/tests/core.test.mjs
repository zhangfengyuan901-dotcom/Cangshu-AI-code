import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isVideo, isImage, concurrencyOptions, defaultVideoOptions, defaultImageOptions, closestImageRatio,
  estimateCost, buildVideoPayload, buildImagePayload, extractTaskIds,
  hamsterModelName, VIDEO_ROUTES, OFFICIAL_VIDEO_ROUTE, IMAGE_ROUTES, mapUpstreamModels, mediaLimitError, publicText, buildOfficialVideoProviderPayload,
} from '../legacy-routes.mjs';

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

test('图片修改默认沿用最接近原图的画幅', () => {
  assert.equal(closestImageRatio(942,1672,['auto','1:1','9:16','16:9']),'9:16');
  assert.equal(closestImageRatio(1600,900,['auto','1:1','9:16','16:9']),'16:9');
  assert.equal(closestImageRatio(1000,1000,['auto','1:1','9:16']),'1:1');
  assert.equal(closestImageRatio(1000,1000,['auto']),'auto');
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
  assert.equal(hamsterModelName({ id: 'sd_2_5_once_720p' }), 'SD2.5-按次-720P');
  assert.equal(hamsterModelName({ id: 'sd_2_5_once_line3' }), 'SD2.5-按次-线路3');
  assert.equal(hamsterModelName({ id: 'sd_2_5_900_30s' }), 'SD2.5-9图-30秒');
  assert.equal(hamsterModelName({ id: 'official_backup_480p' }), '官方备选线路-480P');
  assert.equal(hamsterModelName({ id: 'image_2_5_flare' }), 'Image 2.5 Flare');
  assert.equal(hamsterModelName({ id: 'model-c', name: '仓鼠-SD2.5' }), '仓鼠线路');
});
test('官方备选线路固定480P并按0.55元每秒展示', () => {
  assert.equal(OFFICIAL_VIDEO_ROUTE.id,'official_backup_480p');
  assert.deepEqual(OFFICIAL_VIDEO_ROUTE.resolutions,['480p']);
  assert.equal(OFFICIAL_VIDEO_ROUTE.display_price_yuan_per_second,0.55);
  assert.deepEqual([OFFICIAL_VIDEO_ROUTE.max_images,OFFICIAL_VIDEO_ROUTE.max_videos,OFFICIAL_VIDEO_ROUTE.max_audios],[9,3,3]);
});
test('官方视频请求转换为上游 content 并显式标注素材角色', () => {
  const payload=buildOfficialVideoProviderPayload({prompt:'测试',ratio:'9:16',resolution:'480p',duration:5,reference:'startEnd',
    images:[{url:'https://r2.example/first.png'},{url:'https://r2.example/last.png'}],
    videos:[{url:'https://r2.example/reference.mp4'}],audios:[{url:'https://r2.example/reference.mp3'}]},'internal-provider-model');
  assert.deepEqual(payload,{model:'internal-provider-model',duration:5,resolution:'480p',ratio:'9:16',content:[
    {type:'text',text:'测试'},
    {type:'image_url',role:'first_frame',image_url:{url:'https://r2.example/first.png'}},
    {type:'image_url',role:'last_frame',image_url:{url:'https://r2.example/last.png'}},
    {type:'video_url',role:'reference_video',video_url:{url:'https://r2.example/reference.mp4'}},
    {type:'audio_url',role:'reference_audio',audio_url:{url:'https://r2.example/reference.mp3'}},
  ]});
});
test('只保留三条视频线路，按指定顺序并标注对外按次价格', () => {
  const models = mapUpstreamModels([
    { id: 'removed', type: 'video' },
    ...[...VIDEO_ROUTES].reverse().map((r) => ({ id: r.id, type: 'video', name: '上游名称', max_images: 99, price_credits: 23 })),
    IMAGE, { id:'image_2_5_flare',name:'Image 2.5 Flare',type:'image',quality_options:['auto'],default_quality:'auto' },
  ]);
  assert.deepEqual(models.filter(isVideo).map((m) => m.id), VIDEO_ROUTES.map((r) => r.id));
  assert.equal(models[0].price_credits, 23);
  assert.deepEqual(models.filter(isVideo).map((m) => m.display_price_yuan), [15,15,6]);
  assert.equal(models[0].max_images, 30);
  assert.equal(defaultVideoOptions(models[0]).resolution, '720p');
  assert.equal(defaultVideoOptions(models[2]).duration, 30);
  assert.equal(models.filter(isImage).length, 2);
  assert.equal(models.filter(isImage)[0].name, 'Image 2.5 Flare');
  assert.equal(defaultImageOptions(models.filter(isImage)[0]).quality, 'auto');
  assert.equal(mapUpstreamModels([{ ...VIDEO_ROUTES[0], enabled: false }]).length, 0);
});
test('三条线路素材边界：两条全参线路与固定30秒图片线路', () => {
  const media = (image, video, audio) => ['image', 'video', 'audio'].flatMap((kind, i) => Array.from({ length: [image, video, audio][i] }, () => ({kind})));
  for (const route of VIDEO_ROUTES.slice(0,2)) {
    assert.equal(mediaLimitError(route, media(30, 10, 10)), '');
    assert.match(mediaLimitError(route, media(31, 0, 0)), /最多支持30/);
    assert.match(mediaLimitError(route, media(0, 11, 0)), /最多支持10/);
    assert.match(mediaLimitError(route, media(30, 10, 11)), /最多支持10/);
  }
  assert.equal(mediaLimitError(VIDEO_ROUTES[2], media(9, 0, 0)), '');
  assert.match(mediaLimitError(VIDEO_ROUTES[2], media(10, 0, 0)), /最多支持9/);
  assert.match(mediaLimitError(VIDEO_ROUTES[2], media(1, 1, 0)), /不支持视频/);
  assert.match(mediaLimitError(VIDEO_ROUTES[2], media(1, 0, 1)), /不支持音频/);
});
test('系统错误显示隐藏服务商与地址', () => {
  const msg = publicText('RunningHub 三宝 VideoFee Seedance Cloudflare R2 方舟 sd_2_5_once_720p https://www.runninghub.cn/error');
  assert.doesNotMatch(msg, /runninghub|三宝|videofee|seedance|cloudflare|\br2\b|方舟|hailuo|https:/i);
  assert.match(msg, /SD2\.5-按次-720P/);
  assert.doesNotMatch(publicText('seedance2.0不支持此配置'), /seedance/i);
});

test('图片列表开放三宝当前全部六条线路，保留顺序与上游参数', () => {
  const upstream=IMAGE_ROUTES.map((route,index)=>({
    id:route.id,type:'image',name:route.name,price_credits:.7+index/10,
    max_images:route.id.startsWith('gpt-')?5:9,
  }));
  const models=mapUpstreamModels([...upstream.reverse(),{id:'unknown-image',type:'image',name:'Unknown'}]);
  assert.deepEqual(models.map(m=>m.id),IMAGE_ROUTES.map(route=>route.id));
  assert.equal(models.length,6);
  assert.equal(models[0].max_images,9);
  assert.equal(models[2].max_images,5);
  assert.equal(models[5].name,'gpt-image2-4K');
});
