import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../website/public/index.html', import.meta.url), 'utf8');

test('首页移除整组视频栏目与弹窗，保留十张图片案例及原素材文件', () => {
  assert.doesNotMatch(page, /data-video=|video-case-grid|video-case-card|video-case-dialog|<video\b|ugc-case-\d{2}\.(?:mp4|webp)/);
  assert.doesNotMatch(page, /美区 TikTok AI 达人带货|点击封面播放视频|厨房收纳 · 场景演示|水龙头配件 · 产品演示|厨房收纳 · 达人展示|水龙头配件 · 情景演绎/);
  const images = [...page.matchAll(/data-case="(\/assets\/case-\d{2}\.jpg)"/g)].map(match => match[1]);
  assert.deepEqual(images, Array.from({ length: 10 }, (_, index) => `/assets/case-${String(index + 1).padStart(2, '0')}.jpg`));
  assert.match(page, /class="case-grid"/);
  assert.match(page, /class="case-dialog"/);
  for (const image of images) {
    const file = new URL('../website/public' + image, import.meta.url);
    assert.ok(existsSync(file) && statSync(file).size > 0, image);
  }
  for (let number = 1; number <= 4; number++) {
    for (const extension of ['mp4', 'webp']) {
      const asset = `ugc-case-${String(number).padStart(2, '0')}.${extension}`;
      const path = new URL(`../website/public/assets/${asset}`, import.meta.url);
      assert.ok(existsSync(path) && statSync(path).size > 0, `${asset} 应存在且非空`);
    }
  }
});
