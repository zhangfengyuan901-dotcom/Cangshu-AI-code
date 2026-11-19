import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../website/public/index.html', import.meta.url), 'utf8');

test('首页优先展示四条可播放的美区带货视频，保留原有图片案例', () => {
  const videoCases = [...page.matchAll(/data-video="(\/assets\/ugc-case-\d{2}\.mp4)"/g)].map(match => match[1]);
  assert.deepEqual(videoCases, [1, 2, 3, 4].map(number => `/assets/ugc-case-${String(number).padStart(2, '0')}.mp4`));
  assert.ok(page.indexOf('class="video-case-grid"') < page.indexOf('class="case-grid"'));
  assert.equal([...page.matchAll(/data-case="\/assets\/case-\d{2}\.jpg"/g)].length, 10);
  assert.match(page, /AI 创作案例/);
  assert.match(page, /class="video-case-dialog"/);
  for (const video of videoCases) {
    const filename = video.split('/').pop();
    const poster = filename.replace('.mp4', '.webp');
    for (const asset of [filename, poster]) {
      const path = new URL(`../website/public/assets/${asset}`, import.meta.url);
      assert.ok(existsSync(path) && statSync(path).size > 0, `${asset} 应存在且非空`);
    }
  }
  assert.doesNotMatch(page, /[a-f0-9]{32}\.mp4/i);
});
