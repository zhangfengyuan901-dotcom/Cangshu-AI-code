'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Catalog HTTP ' + response.status);
  return response.json();
}
async function main() {
  const snapshot = process.argv.includes('--from-snapshot') ? JSON.parse(fs.readFileSync(path.join(root, 'plugins/generated/catalog.json'), 'utf8')) : null;
  const csdHealthFile = process.env.CSD_HEALTH_SNAPSHOT;
  const csdHealthSnapshot = csdHealthFile ? JSON.parse(fs.readFileSync(csdHealthFile, 'utf8')) : null;
  const [sanbao, csd] = snapshot ? [{ data: snapshot.sanbao }, csdHealthSnapshot || { defaults: snapshot.canseedream }] : await Promise.all([
    get('https://sanbaobeauty.com/api/public/openapi-models'), get('https://see.ximeiedu.org/health'),
  ]);
  const common = { qualities: [], resolutions: [], ratios: [], durations: [], limits: { image: 0, video: 0, audio: 0 } };
  const specs = [
    { provider: 'sanbao', key: 'pikno-sanbao', name: 'PIKNO 三宝', baseUrl: 'https://sanbaobeauty.com', models: {}, fields: {
      video: ['prompt', 'ratio', 'resolution', 'duration', 'reference', 'images', 'videos', 'audios', 'concurrency'],
    } },
    { provider: 'canseedream', key: 'pikno-canseedream', name: 'PIKNO CanSeeDream', baseUrl: 'https://see.ximeiedu.org', models: {}, fields: {
      video: ['prompt', 'image_urls', 'audio_urls', 'video_urls', 'duration', 'resolution', 'aspect_ratio', 'generate_audio', 'number_of_runs'],
    } },
  ];
  if (!Array.isArray(sanbao.data) || !Array.isArray(csd.defaults?.videoProviders)) throw new Error('Unrecognized provider catalog');
  for (const item of sanbao.data) {
    if (item.type !== 'video') continue;
    if (!['image', 'video'].includes(item.type) || !/^[A-Za-z0-9_-]+$/.test(item.id)) throw new Error('Unexpected Sanbao model');
    specs[0].models['sanbao/' + item.id] = {
      ...common, kind: item.type, upstreamModel: item.id,
      path: '/openapi/v1/' + (item.type === 'video' ? 'videos' : 'images'),
      qualities: item.type === 'image' ? ['low', 'medium', 'high'] : [],
      defaultQuality: item.type === 'image' ? 'high' : undefined,
      resolutions: item.resolutions || [], ratios: item.ratios || item.aspect_ratio_values || item.aspect_ratios || [],
      durations: item.durations || [], minImages: item.required_images || item.min_images || 0,
      limits: { image: item.max_images || item.required_images || 0, video: item.max_videos || 0, audio: item.max_audios || 0 },
    };
  }
  for (const item of csd.defaults.videoProviders) {
    if (!/^[A-Za-z0-9_-]+$/.test(item.id)) throw new Error('Unexpected CanSeeDream line');
    specs[1].models['canseedream/video/' + item.id] = {
      ...common, kind: 'video', path: '/api/v3/contents/generations/tasks',
      route: item.providerRoute || item.id, line: item.providerLine,
      resolutions: item.allowedResolutions || [], ratios: item.limits?.allowedRatios || [],
      durations: item.allowedDurations || [Number(item.durationSeconds || item.duration)], maxPrompt: item.maxPromptCharacters || 10000,
      limits: { image: item.limits?.maxImages || 0, video: item.limits?.maxVideos || 0, audio: item.limits?.maxAudio || 0 },
    };
  }
  const dir = path.join(root, 'plugins', 'generated');
  fs.mkdirSync(dir, { recursive: true });
  const runtime = fs.readFileSync(path.join(root, 'plugins', 'runtime.js'), 'utf8');
  for (const spec of specs) {
    fs.writeFileSync(path.join(dir, spec.key + '.js'), '// Generated; edit runtime.js and build-plugins.cjs, then rebuild and test.\nconst SPEC = ' + JSON.stringify(spec, null, 2) + ';\n' + runtime);
    console.log(spec.key + ': ' + Object.keys(spec.models).length + ' catalog models (not live-call verified)');
  }
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), specs, sanbao: sanbao.data, canseedream: csd.defaults }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
