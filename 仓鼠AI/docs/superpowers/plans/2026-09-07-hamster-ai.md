# 仓鼠AI（Hamster AI）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地运行的图片/视频生成客户端，复刻 sanbaobeauty.com 的生成功能，用户填入 API Key 后直连三宝影像工坊 OpenAPI。

**Architecture:** 零依赖 Node 服务（静态托管 + `/api/* → /openapi/v1/*` 透明代理）+ 浏览器单页应用（原生 JS）。前端逻辑拆成纯函数模块 `core.js`（可单测）+ UI 模块 `app.js`。

**Tech Stack:** Node.js ≥18（内置 `http`/`fs`/`fetch`/`node:test`），原生 ES Module，无任何 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-07-sanbao-ai-studio-design.md`

## Global Constraints

- 非 git 仓库：计划中「Commit」步骤一律改为「验证」步骤，不执行 git 提交。
- 零依赖：不得引入任何 npm 包；`package.json` 的 `dependencies` 必须为空。
- `"type": "module"`（全项目 ESM），`public/*.js` 用 ES Module。
- 产品名「仓鼠AI」，logo 标记「仓」，主色暖橙（`--accent: #ff9a3d`），暗色主题，界面文案中文。
- 服务默认端口 `8787`，可用 `PORT` 环境变量覆盖；上游默认 `https://sanbaobeauty.com`，可用 `UPSTREAM` 覆盖（供测试 mock）。
- API Key 只存浏览器 `localStorage`（键 `hamster_api_key`），服务端不落盘。
- 任务历史存 `localStorage`（键 `hamster_history`，最多 200 条）。
- 测试用 Node 内置 `node --test tests/`。

---

## 文件结构

```
苏雨的AI/
  package.json        # type:module，scripts: start/test
  server.js           # 零依赖服务：createApp() + 静态托管 + /api 代理；入口自动开浏览器
  README.md           # 使用说明
  public/
    index.html        # SPA 骨架（4 个视图 + composer + 任务流 + 菜单/Toast 容器）
    styles.css        # 暗色主题（暖橙 accent）
    core.js           # 纯逻辑（无 DOM/fetch），可单测
    app.js            # UI/状态/请求/轮询/历史（import core.js）
  tests/
    core.test.js      # 核心逻辑单测
    server.test.js    # 服务代理集成测
```

---

## Task 1: 零依赖 Node 服务（静态托管 + /api 透明代理）

**Files:**
- Create: `package.json`
- Create: `server.js`
- Create: `public/index.html`（占位，Task 3 替换为完整版）
- Create: `tests/server.test.js`

**Interfaces:**
- Produces: `export function createApp({ upstream, publicDir } = {})` 返回 `http.Server`；默认 `upstream = 'https://sanbaobeauty.com'`，`publicDir = <root>/public`。入口逻辑用 `import.meta.url === pathToFileURL(process.argv[1]).href` 判断是否直接运行，直接运行时监听 `PORT||8787` 并自动开浏览器。

- [ ] **Step 1: 写失败测试**

创建 `tests/server.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => resolve(Buffer.concat(c)));
  });
}

test('serves / as index.html', async () => {
  const app = createApp();
  const port = await listen(app);
  const res = await fetch(`http://localhost:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<title>/);
  app.close();
});

test('proxies POST /api/videos to upstream /openapi/v1/videos with auth+body', async () => {
  const upstream = http.createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization, body: body.toString() }));
  });
  const upPort = await listen(upstream);

  const app = createApp({ upstream: `http://localhost:${upPort}` });
  const port = await listen(app);

  const res = await fetch(`http://localhost:${port}/api/videos`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk_test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', prompt: 'hi' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.url, '/openapi/v1/videos');
  assert.equal(data.method, 'POST');
  assert.equal(data.auth, 'Bearer sk_test');
  assert.equal(data.body, '{"model":"x","prompt":"hi"}');
  app.close();
  upstream.close();
});

test('proxies upload query string through to upstream', async () => {
  const upstream = http.createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, ct: req.headers['content-type'], body: body.toString() }));
  });
  const upPort = await listen(upstream);
  const app = createApp({ upstream: `http://localhost:${upPort}` });
  const port = await listen(app);
  const res = await fetch(`http://localhost:${port}/api/uploads/raw?kind=image&fileName=a.jpg`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk_test', 'content-type': 'image/jpeg' },
    body: new Uint8Array([1, 2, 3]),
  });
  const data = await res.json();
  assert.equal(data.url, '/openapi/v1/uploads/raw?kind=image&fileName=a.jpg');
  assert.equal(data.ct, 'image/jpeg');
  app.close();
  upstream.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/server.test.js`
Expected: FAIL（`Cannot find module '../server.js'`）

- [ ] **Step 3: 创建 package.json**

```json
{
  "name": "hamster-ai",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test": "node --test tests/"
  },
  "engines": { "node": ">=18" }
}
```

- [ ] **Step 4: 创建占位 public/index.html**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>仓鼠AI</title>
  </head>
  <body>loading</body>
</html>
```

- [ ] **Step 5: 实现 server.js**

```js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_UPSTREAM = 'https://sanbaobeauty.com';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}

function serveStatic(req, res, publicDir, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }
  const filePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.normalize(path.join(publicDir, filePath));
  if (!full.startsWith(publicDir)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleProxy(req, res, upstream, url) {
  const rest = url.pathname.replace(/^\/api/, '');
  const target = upstream + '/openapi/v1' + rest + url.search;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length'].includes(k)) continue;
    headers[k] = v;
  }
  const body = await readBody(req);
  const upstreamRes = await fetch(target, { method: req.method, headers, body });
  const buffer = Buffer.from(await upstreamRes.arrayBuffer());
  const resHeaders = {};
  for (const [k, v] of upstreamRes.headers) {
    if (['content-length', 'connection', 'transfer-encoding'].includes(k)) continue;
    resHeaders[k] = v;
  }
  res.writeHead(upstreamRes.status, resHeaders);
  res.end(buffer);
}

export function createApp({ upstream = DEFAULT_UPSTREAM, publicDir = PUBLIC_DIR } = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      handleProxy(req, res, upstream, url).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'proxy error', detail: String(err) }));
      });
    } else {
      serveStatic(req, res, publicDir, url.pathname);
    }
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.log('请手动打开浏览器访问:', url); });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = Number(process.env.PORT || 8787);
  const app = createApp();
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`仓鼠AI 本地服务已启动: ${url}`);
    openBrowser(url);
  });
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test tests/server.test.js`
Expected: PASS（3 个测试）

- [ ] **Step 7: 验证**

Run: `node server.js`，看到「仓鼠AI 本地服务已启动」，浏览器自动打开；访问 `http://localhost:8787/` 显示占位页。`Ctrl+C` 退出。

---

## Task 2: 纯逻辑模块 core.js + 单测

**Files:**
- Create: `public/core.js`
- Create: `tests/core.test.js`

**Interfaces:**
- Produces（Task 4 依赖这些具名导出）：
  - `isVideo(model): boolean`、`isImage(model): boolean`
  - `concurrencyOptions(model): number[]`（缺省 `[1,2,4]`）
  - `defaultVideoOptions(model): {ratio,resolution,duration}`
  - `defaultImageOptions(model): {aspect_ratio,quality}`
  - `estimateCost(model, {resolution,duration}): number`（保留 2 位小数）
  - `buildVideoPayload({model,prompt,ratio,resolution,duration,reference,concurrency,images,videos,audios}): object`
  - `buildImagePayload({model,prompt,aspect_ratio,quality,concurrency,images}): object`
  - `extractTaskIds(createResponse): string[]`

- [ ] **Step 1: 写失败测试**

创建 `tests/core.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isVideo, isImage, concurrencyOptions, defaultVideoOptions, defaultImageOptions,
  estimateCost, buildVideoPayload, buildImagePayload, extractTaskIds,
} from '../public/core.js';

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
  assert.deepEqual(defaultVideoOptions(VIDEO), { ratio: '16:9', resolution: '720p', duration: 10 });
});

test('defaultImageOptions 取默认值', () => {
  assert.deepEqual(defaultImageOptions(IMAGE), { aspect_ratio: 'auto', quality: 'high' });
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/core.test.js`
Expected: FAIL（`Cannot find module '../public/core.js'`）

- [ ] **Step 3: 实现 core.js**

```js
// 纯逻辑模块：不依赖 DOM / fetch，可在浏览器与 Node 中运行，便于单测。

export function isVideo(model) {
  return model?.type === 'video' || model?.category === 'video';
}
export function isImage(model) {
  return model?.type === 'image' || model?.category === 'image';
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
  };
}

export function defaultImageOptions(model) {
  return {
    aspect_ratio: first(model?.aspect_ratios, 'auto'),
    quality: 'high',
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
  const single = payload?.data?.task_id ?? payload?.data?.taskId
    ?? payload?.task_id ?? payload?.taskId ?? payload?.id;
  return single ? [single] : [];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/core.test.js`
Expected: PASS（11 个测试）

- [ ] **Step 5: 验证**

Run: `node --test tests/`
Expected: Task 1 + Task 2 全部通过。

---

## Task 3: 界面骨架 index.html + styles.css

**Files:**
- Modify: `public/index.html`（完整替换占位）
- Create: `public/styles.css`

**Interfaces:**
- Produces（Task 4 依赖这些 DOM id / data 属性，必须一一对应）：
  - 视图容器 `.view[data-panel="generate|models|history|account"]`；导航 `.rail-item[data-view=...]`；logo `.logo`
  - 生成：`#generationForm` `#prompt` `#imageFile` `#videoFile` `#audioFile` `#mediaList` `#typeLabel` `#modelLabel` `#referenceLabel` `#specLabel` `#concurrencyLabel` `#costPreview` `#taskFeed`
  - 菜单锚点按钮 `[data-menu="type|model|reference|spec|concurrency"]`
  - 模型库 `#modelGrid`；历史 `#historyList`；账户 `#apiKeyInput` `#saveKeyButton` `#accountStatus` `#accountBalance` `#creditValue` `#creditButton`
  - 全局 `#toast`

- [ ] **Step 1: 写完整 index.html**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>仓鼠AI</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="app">
      <aside class="rail">
        <button class="logo" data-view="generate" aria-label="仓鼠AI"><span class="logo-mark">仓</span></button>
        <nav class="rail-nav">
          <button class="rail-item active" data-view="generate"><span class="rail-icon">✦</span><span>生成</span></button>
          <button class="rail-item" data-view="models"><span class="rail-icon">▦</span><span>模型库</span></button>
          <button class="rail-item" data-view="history"><span class="rail-icon">🕘</span><span>历史</span></button>
          <button class="rail-item" data-view="account"><span class="rail-icon">⚙</span><span>账户</span></button>
        </nav>
        <div class="rail-bottom">
          <button id="creditButton" class="credit-card"><span>⚡<b id="creditValue">--</b></span><strong>余额</strong></button>
        </div>
      </aside>

      <section class="view active" data-panel="generate">
        <h1 class="stage-title">每一个好创意都让人惊喜</h1>
        <form id="generationForm" class="composer">
          <div class="prompt-wrap">
            <textarea id="prompt" maxlength="6000" placeholder="今天我们要创作什么"></textarea>
            <div class="media-tray">
              <label class="media-tile" data-kind="image"><input id="imageFile" type="file" accept="image/png,image/jpeg,image/webp" multiple /><span>+</span><small>图片</small></label>
              <label class="media-tile" data-kind="video"><input id="videoFile" type="file" accept="video/mp4,video/webm" multiple /><span>+</span><small>视频</small></label>
              <label class="media-tile" data-kind="audio"><input id="audioFile" type="file" accept="audio/*" multiple /><span>+</span><small>音频</small></label>
              <div id="mediaList" class="media-list" hidden></div>
            </div>
          </div>
          <div class="composer-tools">
            <div class="tool-group">
              <button type="button" class="tool-pill" data-menu="type"><span id="typeLabel">视频生成</span><span class="chevron">▾</span></button>
              <button type="button" class="tool-pill" data-menu="model"><span id="modelLabel">暂无模型</span><span class="chevron">▾</span></button>
              <button type="button" class="tool-pill" data-menu="reference" id="referencePill"><span id="referenceLabel">全能参考</span><span class="chevron">▾</span></button>
              <button type="button" class="tool-pill" data-menu="spec"><span id="specLabel">--</span><span class="chevron">▾</span></button>
              <button type="button" class="tool-pill" data-menu="concurrency"><span id="concurrencyLabel">1x</span><span class="chevron">▾</span></button>
            </div>
            <div class="submit-group">
              <span class="cost">⚡<b id="costPreview">0</b></span>
              <button class="send-button" type="submit" aria-label="发送">↑</button>
            </div>
          </div>
        </form>
        <div id="taskFeed" class="task-feed"></div>
      </section>

      <section class="view" data-panel="models">
        <h1 class="view-title">模型库</h1>
        <div id="modelGrid" class="model-grid"></div>
      </section>

      <section class="view" data-panel="history">
        <h1 class="view-title">历史</h1>
        <div id="historyList" class="history-list"></div>
      </section>

      <section class="view" data-panel="account">
        <h1 class="view-title">账户</h1>
        <div class="account-card">
          <label>API Key<input id="apiKeyInput" type="password" placeholder="sk_sanbao_xxxxxxxx" autocomplete="off" /></label>
          <button id="saveKeyButton" class="plain-button" type="button">保存并连接</button>
          <p id="accountStatus" class="hint"></p>
        </div>
        <div class="account-card">
          <strong>余额</strong>
          <p>⚡ <b id="accountBalance">--</b> 积分</p>
        </div>
      </section>
    </main>

    <div id="toast" class="toast"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: 写完整 styles.css**

```css
:root {
  --bg: #0e0d0b;
  --panel: #1d1a16;
  --panel-2: #262119;
  --line: #2e2a22;
  --text: #f5efe6;
  --text-dim: #9a9284;
  --accent: #ff9a3d;
  --accent-2: #ffb45e;
  --danger: #ff5f56;
  --ok: #57d97c;
  --radius: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: radial-gradient(1200px 600px at 70% -10%, #2a1d10 0%, var(--bg) 55%);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
.app { display: flex; height: 100vh; }

.rail { width: 72px; flex: 0 0 72px; display: flex; flex-direction: column; align-items: center; padding: 14px 0; gap: 8px; background: rgba(20,18,15,.7); border-right: 1px solid var(--line); }
.logo { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, var(--accent), #f2711c); color: #241307; font-weight: 800; font-size: 20px; display: flex; align-items: center; justify-content: center; border: none; cursor: pointer; }
.rail-nav { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; flex: 1; }
.rail-item { width: 56px; padding: 8px 0; display: flex; flex-direction: column; align-items: center; gap: 4px; background: none; border: none; color: var(--text-dim); cursor: pointer; border-radius: 12px; font-size: 11px; }
.rail-item:hover { color: var(--text); background: var(--panel); }
.rail-item.active { color: var(--accent-2); background: var(--panel); }
.rail-icon { font-size: 18px; line-height: 1; }
.rail-bottom { margin-top: auto; }
.credit-card { display: flex; flex-direction: column; align-items: center; gap: 2px; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 12px; padding: 8px 10px; cursor: pointer; font-size: 11px; }
.credit-card b { color: var(--accent-2); }

.view { display: none; flex: 1; overflow-y: auto; padding: 40px 48px; }
.view.active { display: block; }
.stage-title { font-size: 34px; font-weight: 800; margin: 20px 0 32px; }
.view-title { font-size: 26px; font-weight: 800; margin: 8px 0 24px; }

.composer { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; max-width: 900px; }
#prompt { width: 100%; min-height: 120px; background: transparent; border: none; resize: vertical; outline: none; color: var(--text); font-size: 16px; font-family: inherit; }
#prompt::placeholder { color: var(--text-dim); }
.media-tray { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 0 4px; border-top: 1px solid var(--line); margin-top: 6px; }
.media-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 56px; height: 56px; border: 1px dashed var(--line); border-radius: 10px; color: var(--text-dim); cursor: pointer; font-size: 11px; gap: 2px; }
.media-tile:hover { border-color: var(--accent); color: var(--accent-2); }
.media-tile span { font-size: 18px; line-height: 1; }
.media-tile input { display: none; }
.media-list { display: flex; gap: 8px; flex-wrap: wrap; }
.media-chip { display: flex; align-items: center; gap: 6px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font-size: 12px; max-width: 240px; }
.media-chip img { width: 28px; height: 28px; object-fit: cover; border-radius: 5px; flex: 0 0 auto; }
.media-chip .chip-kind { flex: 0 0 auto; }
.media-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.media-chip .rm { cursor: pointer; color: var(--text-dim); border: none; background: none; }
.media-chip .rm:hover { color: var(--danger); }

.composer-tools { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; flex-wrap: wrap; gap: 10px; }
.tool-group { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.tool-pill { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 999px; padding: 8px 14px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.tool-pill:hover { border-color: var(--accent); }
.tool-pill .chevron { color: var(--text-dim); font-size: 10px; }
.submit-group { display: flex; align-items: center; gap: 12px; }
.cost { color: var(--text-dim); font-size: 13px; }
.cost b { color: var(--accent-2); }
.send-button { width: 46px; height: 46px; border-radius: 50%; border: none; background: linear-gradient(135deg, var(--accent), #f2711c); color: #241307; font-size: 20px; cursor: pointer; }
.send-button:disabled { opacity: .5; cursor: not-allowed; }

.menu-popover { position: fixed; z-index: 50; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 8px; min-width: 200px; max-height: 60vh; overflow-y: auto; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: none; background: none; color: var(--text); border-radius: 8px; cursor: pointer; font-size: 13px; text-align: left; }
.menu-item:hover { background: var(--panel-2); }
.menu-item.selected { color: var(--accent-2); }
.menu-item .sub { margin-left: auto; color: var(--text-dim); font-size: 12px; }
.menu-section-title { padding: 8px 10px 4px; font-size: 11px; color: var(--text-dim); letter-spacing: .5px; }

.task-feed { display: flex; flex-direction: column; gap: 12px; margin-top: 24px; max-width: 900px; }
.task-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
.task-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.task-status { font-size: 12px; padding: 3px 10px; border-radius: 999px; }
.task-status.queued { background: #3a3520; color: #e6c85c; }
.task-status.processing { background: #3a2c1a; color: var(--accent-2); }
.task-status.succeeded { background: #17301f; color: var(--ok); }
.task-status.failed { background: #3a1d1a; color: var(--danger); }
.task-model { color: var(--text-dim); font-size: 13px; }
.task-prompt { color: var(--text); font-size: 14px; margin: 8px 0; white-space: pre-wrap; }
.progress-wrap { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; margin: 8px 0; }
.progress-bar { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .3s; }
.task-result img, .task-result video { max-width: 100%; max-height: 360px; border-radius: 10px; margin-top: 8px; }
.task-actions { margin-top: 8px; }
.link-button { display: inline-block; background: var(--panel-2); border: 1px solid var(--line); color: var(--accent-2); border-radius: 8px; padding: 6px 12px; text-decoration: none; font-size: 13px; margin-right: 8px; }
.task-error { color: var(--danger); font-size: 13px; margin-top: 8px; }

.model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.model-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
.model-card h3 { margin: 0 0 4px; font-size: 15px; }
.model-card code { font-size: 12px; color: var(--text-dim); }
.model-desc { color: var(--text-dim); font-size: 13px; margin: 8px 0; }
.model-meta { font-size: 12px; color: var(--text-dim); line-height: 1.7; }
.model-meta b { color: var(--text); }
.model-price { margin-top: 10px; font-size: 13px; color: var(--accent-2); }

.history-list { display: flex; flex-direction: column; gap: 12px; max-width: 900px; }
.empty-hint { color: var(--text-dim); text-align: center; padding: 60px 0; }

.account-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; max-width: 560px; margin-bottom: 16px; }
.account-card label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--text-dim); }
.account-card input { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 12px; color: var(--text); font-size: 14px; }
.plain-button { margin-top: 12px; background: linear-gradient(135deg, var(--accent), #f2711c); border: none; color: #241307; border-radius: 10px; padding: 10px 18px; cursor: pointer; font-size: 14px; font-weight: 600; }
.hint { color: var(--text-dim); font-size: 13px; margin-top: 10px; }
.hint.error { color: var(--danger); }
.hint.ok { color: var(--ok); }

.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 10px; padding: 12px 20px; font-size: 14px; opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 100; }
.toast.show { opacity: 1; }

@media (max-width: 720px) {
  .rail { display: none; }
  .view { padding: 20px; }
}
```

- [ ] **Step 3: 验证**

Run: `node server.js` → 打开 `http://localhost:8787/`，确认暗色界面、左侧导航、composer、四视图切换正常（无 JS 交互，仅静态布局）。`Ctrl+C` 退出。

---

## Task 4: 前端逻辑 app.js

**Files:**
- Create: `public/app.js`

**Interfaces:**
- Consumes: `core.js` 全部具名导出；Task 3 定义的全部 DOM id/data 属性。
- Produces: 无对外导出（副作用入口，`init()` 自动执行）。

- [ ] **Step 1: 写完整 app.js**

```js
import {
  isVideo, isImage, concurrencyOptions, defaultVideoOptions, defaultImageOptions,
  estimateCost, buildVideoPayload, buildImagePayload, extractTaskIds,
} from './core.js';

const API_BASE = '/api';
const KEY_STORAGE = 'hamster_api_key';
const HISTORY_STORAGE = 'hamster_history';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const REFERENCE_OPTIONS = [
  { value: 'all', label: '全能参考' },
  { value: 'startEnd', label: '首尾帧' },
  { value: 'face', label: '人物一致' },
];
const QUALITY_OPTIONS = ['high', 'medium', 'low'];
const STATUS_LABEL = { queued: '排队中', processing: '生成中', succeeded: '已完成', failed: '失败' };

const state = {
  apiKey: '',
  models: [],
  type: 'video',
  model: null,
  options: {},
  concurrency: 1,
  media: [],
  tasks: [],
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nowISO() { return new Date().toISOString(); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function request(path, { method = 'GET', json, raw, contentType, headers = {} } = {}) {
  const opts = { method, headers: { Authorization: `Bearer ${state.apiKey}`, ...headers } };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (raw !== undefined) {
    opts.headers['Content-Type'] = contentType || 'application/octet-stream';
    opts.body = raw;
  }
  const res = await fetch(API_BASE + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.error || data?.detail || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
function handleError(e) {
  if (e?.status === 401) toast('API Key 无效，请到「账户」页重新填写');
  else if (e?.status === 402) toast('积分余额不足，请充值');
  else if (e?.status === 429) toast('请求过于频繁，请稍后重试');
  else if (e?.status === 413) toast('素材文件过大');
  else if (e?.status === 502) toast('模型服务异常，请稍后重试');
  else toast(e?.message || '请求失败');
}

// ---- 账户 ----
function extractCredits(me) {
  const d = me?.data ?? me;
  for (const k of ['credits', 'balance', 'credit', 'points']) {
    if (d && d[k] !== undefined && d[k] !== null) return d[k];
  }
  return '--';
}
async function loadAccount() {
  if (!state.apiKey) { renderAccount(null, null); return; }
  try { renderAccount(await request('/me'), null); }
  catch (e) { renderAccount(null, e); }
}
function renderAccount(me, err) {
  const credits = me ? extractCredits(me) : '--';
  $('#accountBalance').textContent = credits;
  $('#creditValue').textContent = credits;
  const s = $('#accountStatus');
  if (me) { s.textContent = '连接成功'; s.className = 'hint ok'; }
  else { s.textContent = err ? (err.status === 401 ? 'API Key 无效' : err.message) : '请填写 API Key 后保存'; s.className = 'hint' + (err ? ' error' : ''); }
}

// ---- 模型 ----
function videoModels() { return state.models.filter(isVideo); }
function imageModels() { return state.models.filter(isImage); }
function modelsOfType() { return state.type === 'video' ? videoModels() : imageModels(); }

async function loadModels() {
  if (!state.apiKey) { state.models = []; }
  else {
    try { state.models = ((await request('/models'))?.data || []).filter((m) => m && m.id); }
    catch (e) { state.models = []; handleError(e); }
  }
  renderModelLibrary();
  pickDefaultModel();
  renderComposer();
}
function pickDefaultModel() {
  const list = modelsOfType();
  if (!list.length) { state.model = null; state.options = {}; return; }
  if (!state.model || state.model.id !== list.find((m) => m.id === state.model.id)?.id) {
    state.model = list[0];
  }
  state.options = state.type === 'video' ? defaultVideoOptions(state.model) : defaultImageOptions(state.model);
}
function renderComposer() {
  const m = state.model;
  if (!m) { $('#modelLabel').textContent = '暂无模型'; $('#specLabel').textContent = '--'; $('#costPreview').textContent = '0'; return; }
  $('#modelLabel').textContent = m.name || m.id;
  if (state.type === 'video') {
    $('#referenceLabel').textContent = REFERENCE_OPTIONS.find((r) => r.value === state.options.reference)?.label || '全能参考';
    $('#specLabel').textContent = `${state.options.ratio} · ${state.options.resolution} · ${state.options.duration}s`;
    $('#costPreview').textContent = String(estimateCost(m, { resolution: state.options.resolution, duration: state.options.duration }) * state.concurrency);
  } else {
    $('#specLabel').textContent = `${state.options.aspect_ratio} · ${state.options.quality}`;
    $('#costPreview').textContent = String(estimateCost(m, {}) * state.concurrency);
  }
  $('#concurrencyLabel').textContent = state.concurrency + 'x';
}
function setType(type) {
  state.type = type;
  $('#typeLabel').textContent = type === 'video' ? '视频生成' : '图片生成';
  $('#referencePill').style.display = type === 'video' ? '' : 'none';
  $$('.media-tile[data-kind]').forEach((el) => {
    el.style.display = type === 'video' || el.dataset.kind === 'image' ? '' : 'none';
  });
  if (type === 'image') state.media = state.media.filter((m) => m.kind === 'image');
  pickDefaultModel();
  renderMedia();
  renderComposer();
}
function setModel(model) {
  state.model = model;
  state.options = state.type === 'video' ? defaultVideoOptions(model) : defaultImageOptions(model);
  renderComposer();
}

// ---- 菜单 ----
let menuEl = null;
function openMenu(anchor, items) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'menu-popover';
  for (const it of items) {
    if (it.type === 'title') { const t = document.createElement('div'); t.className = 'menu-section-title'; t.textContent = it.label; menuEl.appendChild(t); continue; }
    const b = document.createElement('button');
    b.className = 'menu-item' + (it.selected ? ' selected' : '');
    b.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.sub ? `<span class="sub">${escapeHtml(it.sub)}</span>` : ''}`;
    b.addEventListener('click', () => { closeMenu(); it.onSelect(); });
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
  const r = anchor.getBoundingClientRect();
  menuEl.style.top = (r.bottom + 6) + 'px';
  menuEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + 'px';
  document.addEventListener('click', onDocClick, true);
}
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } document.removeEventListener('click', onDocClick, true); }
function onDocClick(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }

function typeMenu(anchor) {
  openMenu(anchor, [
    { label: '视频生成', selected: state.type === 'video', onSelect: () => setType('video') },
    { label: '图片生成', selected: state.type === 'image', onSelect: () => setType('image') },
  ]);
}
function modelMenu(anchor) {
  openMenu(anchor, modelsOfType().map((m) => ({
    label: m.name || m.id, sub: m.id, selected: state.model?.id === m.id, onSelect: () => setModel(m),
  })));
}
function referenceMenu(anchor) {
  if (!state.model) { toast('请先选择模型'); return; }
  openMenu(anchor, REFERENCE_OPTIONS.map((r) => ({
    label: r.label, selected: state.options.reference === r.value,
    onSelect: () => { state.options.reference = r.value; renderComposer(); },
  })));
}
function specMenu(anchor) {
  const m = state.model; if (!m) { toast('请先选择模型'); return; }
  if (state.type === 'video') {
    openMenu(anchor, [
      { type: 'title', label: '比例' },
      ...(m.ratios || []).map((v) => ({ label: v, selected: state.options.ratio === v, onSelect: () => { state.options.ratio = v; renderComposer(); } })),
      { type: 'title', label: '画质' },
      ...(m.resolutions || []).map((v) => ({ label: v, selected: state.options.resolution === v, onSelect: () => { state.options.resolution = v; renderComposer(); } })),
      { type: 'title', label: '时长（秒）' },
      ...(m.durations || []).map((v) => ({ label: `${v}s`, selected: state.options.duration === v, onSelect: () => { state.options.duration = v; renderComposer(); } })),
    ]);
  } else {
    openMenu(anchor, [
      { type: 'title', label: '比例' },
      ...(m.aspect_ratios || []).map((v) => ({ label: v, selected: state.options.aspect_ratio === v, onSelect: () => { state.options.aspect_ratio = v; renderComposer(); } })),
      { type: 'title', label: '质量' },
      ...QUALITY_OPTIONS.map((v) => ({ label: v, selected: state.options.quality === v, onSelect: () => { state.options.quality = v; renderComposer(); } })),
    ]);
  }
}
function concurrencyMenu(anchor) {
  const opts = concurrencyOptions(state.model);
  openMenu(anchor, opts.map((n) => ({ label: `${n}x`, selected: state.concurrency === n, onSelect: () => { state.concurrency = n; renderComposer(); } })));
}

// ---- 素材 ----
function mimeFor(name, type) {
  if (type) return type;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
  return map[ext] || 'application/octet-stream';
}
async function uploadFile(file, kind) {
  const buf = await file.arrayBuffer();
  const res = await request(`/uploads/raw?kind=${encodeURIComponent(kind)}&fileName=${encodeURIComponent(file.name)}`, {
    method: 'POST', raw: buf, contentType: mimeFor(file.name, file.type),
  });
  return res?.file?.url;
}
async function handleFiles(files, kind) {
  if (!state.apiKey) { toast('请先在「账户」页填写 API Key'); return; }
  for (const file of files) {
    try {
      const url = await uploadFile(file, kind);
      state.media.push({ kind, url, name: file.name, local: URL.createObjectURL(file) });
      renderMedia();
    } catch (e) { handleError(e); }
  }
}
function removeMedia(idx) { state.media.splice(idx, 1); renderMedia(); }
function renderMedia() {
  const list = $('#mediaList');
  list.innerHTML = state.media.map((m, i) => {
    const thumb = m.kind === 'image' ? `<img src="${m.local || m.url}" alt="" />` : `<span class="chip-kind">${m.kind === 'video' ? '🎞' : '🎵'}</span>`;
    return `<div class="media-chip">${thumb}<span>${escapeHtml(m.name)}</span><button type="button" class="rm" data-i="${i}">×</button></div>`;
  }).join('');
  list.querySelectorAll('.rm').forEach((b) => b.addEventListener('click', () => removeMedia(Number(b.dataset.i))));
  list.hidden = !state.media.length;
}

// ---- 生成 ----
function groupMedia() {
  const out = { image: [], video: [], audio: [] };
  for (const m of state.media) out[m.kind].push(m.url);
  return out;
}
async function onSubmit(e) {
  e.preventDefault();
  if (!state.apiKey) { toast('请先在「账户」页填写 API Key'); return; }
  if (!state.model) { toast('请选择模型'); return; }
  const prompt = $('#prompt').value.trim();
  if (!prompt) { toast('请输入提示词'); return; }
  const media = groupMedia();
  const isVideoTask = state.type === 'video';
  const payload = isVideoTask
    ? buildVideoPayload({ model: state.model, prompt, ...state.options, concurrency: state.concurrency, images: media.image, videos: media.video, audios: media.audio })
    : buildImagePayload({ model: state.model, prompt, ...state.options, concurrency: state.concurrency, images: media.image });
  const path = isVideoTask ? '/videos' : '/images';
  const headers = isVideoTask ? { 'Idempotency-Key': crypto.randomUUID() } : {};
  const sendBtn = $('.send-button');
  sendBtn.disabled = true;
  try {
    const created = await request(path, { method: 'POST', json: payload, headers });
    const ids = extractTaskIds(created);
    for (const id of ids) {
      const task = { id, type: state.type, modelId: state.model.id, modelName: state.model.name, prompt, status: 'queued', progress: 1, createdAt: nowISO(), result: null, error: '' };
      state.tasks.unshift(task);
      pollTask(task);
    }
    $('#prompt').value = '';
    renderTaskFeed();
  } catch (err) { handleError(err); }
  finally { sendBtn.disabled = false; }
}
async function pollTask(task) {
  const path = `/${task.type === 'video' ? 'videos' : 'images'}/${task.id}`;
  let delay = 2000;
  for (;;) {
    await sleep(delay);
    let data;
    try { data = (await request(path))?.data; }
    catch (e) { task.status = 'failed'; task.error = e.message; renderTaskFeed(); persistTerminal(task); return; }
    if (!data) continue;
    task.status = data.status || task.status;
    task.progress = Number.isFinite(data.progress) ? data.progress : task.progress;
    if (task.status === 'succeeded') {
      task.result = { image_url: data.image_url, video_url: data.video_url, download_url: data.download_url, link_expires_in: data.link_expires_in };
      task.cost = data.cost;
      renderTaskFeed(); persistTerminal(task); return;
    }
    if (task.status === 'failed') { task.error = data.error || '生成失败'; renderTaskFeed(); persistTerminal(task); return; }
    renderTaskFeed();
    delay = Math.min(delay + 1000, 5000);
  }
}

// ---- 任务流 & 历史 ----
function resultHtml(t) {
  if (!t.result) return '';
  const media = t.type === 'video' && t.result.video_url
    ? `<video src="${t.result.video_url}" controls></video>`
    : t.result.image_url ? `<img src="${t.result.image_url}" alt="" />` : '';
  const dl = t.result.download_url ? `<div class="task-actions"><a class="link-button" href="${t.result.download_url}" target="_blank" download>下载</a></div>` : '';
  return media + dl;
}
function renderTaskFeed() {
  const feed = $('#taskFeed');
  if (!state.tasks.length) { feed.innerHTML = ''; return; }
  feed.innerHTML = state.tasks.map((t) => {
    const pct = t.progress ?? 0;
    const bar = (t.status === 'processing' || t.status === 'queued') ? `<div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>` : '';
    return `<div class="task-card">
      <div class="task-head"><span class="task-status ${t.status}">${STATUS_LABEL[t.status] || t.status}</span><span class="task-model">${escapeHtml(t.modelName || t.modelId)}</span></div>
      <div class="task-prompt">${escapeHtml(t.prompt)}</div>
      ${bar}
      ${t.error ? `<div class="task-error">${escapeHtml(t.error)}</div>` : ''}
      <div class="task-result">${resultHtml(t)}</div>
    </div>`;
  }).join('');
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_STORAGE) || '[]'); } catch { return []; }
}
function persistTerminal(task) {
  const history = loadHistory();
  const rec = { id: task.id, type: task.type, modelName: task.modelName, prompt: task.prompt, status: task.status, result: task.result, error: task.error, cost: task.cost, createdAt: task.createdAt };
  const idx = history.findIndex((h) => h.id === task.id);
  if (idx >= 0) history[idx] = rec; else history.unshift(rec);
  localStorage.setItem(HISTORY_STORAGE, JSON.stringify(history.slice(0, 200)));
}
function renderHistory() {
  const history = loadHistory();
  const el = $('#historyList');
  if (!history.length) { el.innerHTML = '<div class="empty-hint">暂无历史记录</div>'; return; }
  el.innerHTML = history.map((h) => {
    return `<div class="task-card">
      <div class="task-head"><span class="task-status ${h.status}">${STATUS_LABEL[h.status] || h.status}</span><span class="task-model">${escapeHtml(h.modelName || '')}</span>${h.cost != null ? `<span class="task-model">⚡${h.cost}</span>` : ''}</div>
      <div class="task-prompt">${escapeHtml(h.prompt)}</div>
      ${h.error ? `<div class="task-error">${escapeHtml(h.error)}</div>` : ''}
      <div class="task-result">${resultHtml(h)}</div>
    </div>`;
  }).join('');
}

// ---- 模型库 ----
function mediaLimitText(m) {
  const parts = [];
  if (Number(m.max_images) > 0) parts.push(`图≤${m.max_images}`);
  if (Number(m.max_videos) > 0) parts.push(`视频≤${m.max_videos}`);
  if (Number(m.max_audios) > 0) parts.push(`音频≤${m.max_audios}`);
  if (Number(m.max_image_size_mb) > 0) parts.push(`图≤${m.max_image_size_mb}MB`);
  return parts.join('，') || '-';
}
function renderModelLibrary() {
  const el = $('#modelGrid');
  if (!state.models.length) { el.innerHTML = '<div class="empty-hint">暂无可用模型（请先在「账户」页填写 API Key）</div>'; return; }
  el.innerHTML = state.models.map((m) => {
    const billing = m.billing === 'per_second' ? '按秒计费' : '按次计费';
    const price = m.billing === 'per_second'
      ? (Object.entries(m.price_per_second_by_resolution_credits || {}).map(([k, v]) => `${k}:${v}/s`).join(' · ') || `${m.price_per_second_credits ?? '-'}/s`)
      : (Object.entries(m.price_by_resolution_credits || {}).map(([k, v]) => `${k}:${v}`).join(' · ') || `${m.price_credits ?? '-'}`);
    const spec = isVideo(m)
      ? `<div><b>画质</b> ${(m.resolutions || []).join(' / ')}</div><div><b>比例</b> ${(m.ratios || []).join(' / ')}</div><div><b>时长</b> ${(m.durations || []).join(' / ')} 秒</div>`
      : `<div><b>比例</b> ${(m.aspect_ratios || []).join(' / ')}</div><div><b>质量</b> ${(m.quality_options || []).join(' / ')}</div>`;
    return `<div class="model-card">
      <h3>${escapeHtml(m.name || m.id)}</h3>
      <code>${escapeHtml(m.id)}</code>
      <div class="model-desc">${escapeHtml(m.description || '')}</div>
      <div class="model-meta">
        <div><b>类型</b> ${isVideo(m) ? '视频' : '图片'} · <b>计费</b> ${billing}</div>
        ${spec}
        <div><b>素材</b> ${mediaLimitText(m)}</div>
      </div>
      <div class="model-price">⚡ ${price} 积分</div>
    </div>`;
  }).join('');
}

// ---- 视图 & 初始化 ----
function switchView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.panel === name));
  $$('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') renderHistory();
  if (name === 'account') loadAccount();
  if (name === 'models') renderModelLibrary();
}
function bindEvents() {
  $$('.rail-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('.logo').addEventListener('click', () => switchView('generate'));
  $('[data-menu="type"]').addEventListener('click', (e) => typeMenu(e.currentTarget));
  $('[data-menu="model"]').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('[data-menu="reference"]').addEventListener('click', (e) => referenceMenu(e.currentTarget));
  $('[data-menu="spec"]').addEventListener('click', (e) => specMenu(e.currentTarget));
  $('[data-menu="concurrency"]').addEventListener('click', (e) => concurrencyMenu(e.currentTarget));
  $('#imageFile').addEventListener('change', (e) => handleFiles(e.target.files, 'image'));
  $('#videoFile').addEventListener('change', (e) => handleFiles(e.target.files, 'video'));
  $('#audioFile').addEventListener('change', (e) => handleFiles(e.target.files, 'audio'));
  $('#generationForm').addEventListener('submit', onSubmit);
  $('#saveKeyButton').addEventListener('click', saveKey);
  $('#creditButton').addEventListener('click', () => switchView('account'));
}
async function saveKey() {
  state.apiKey = $('#apiKeyInput').value.trim();
  if (!state.apiKey) { toast('请输入 API Key'); return; }
  localStorage.setItem(KEY_STORAGE, state.apiKey);
  await loadAccount();
  await loadModels();
}
async function init() {
  state.apiKey = localStorage.getItem(KEY_STORAGE) || '';
  $('#apiKeyInput').value = state.apiKey;
  bindEvents();
  switchView('generate');
  renderMedia();
  renderTaskFeed();
  if (state.apiKey) { await loadAccount(); await loadModels(); }
  else { pickDefaultModel(); renderComposer(); }
}
init();
```

- [ ] **Step 2: 语法冒烟检查**

Run: `node --check public/app.js`
Expected: 无输出（语法正确）

- [ ] **Step 3: 端到端手工验证**

Run: `node server.js` → 打开浏览器 → 账户页填 Key → 保存 → 返回生成页：
1. 模型下拉出现视频/图片模型；切换「图片生成」后规格变为比例·质量、参考素材只剩图片
2. 上传一张图片 → 素材托盘出现缩略图
3. 填提示词 → 发送 → 任务流出现「排队中/生成中」进度条 → 完成后展示结果并可下载
4. 「历史」页出现刚才的任务；刷新页面历史仍在
5. 填错 Key 时「账户」页提示「API Key 无效」

---

## Task 5: README + 收尾清理 + 全量验证

**Files:**
- Create: `README.md`
- Delete: `docs_src.html`、`index_src.html`、`models_public.json`（规划阶段临时抓取的源文件）

- [ ] **Step 1: 写 README.md**

```markdown
# 仓鼠AI（Hamster AI）

本地运行的图片 / 视频生成客户端，直连「三宝影像工坊」OpenAPI。填入 API Key 即可使用。

## 快速开始

要求：Node.js ≥ 18（本机已装即可）。

```bash
node server.js
# 或
npm start
```

启动后自动打开浏览器（默认 http://localhost:8787）。

## 使用步骤

1. 左侧「账户」→ 填入 API Key（`sk_sanbao_...`）→ 保存并连接
2. 回到「生成」：输入提示词、上传参考素材、选择模型/比例/时长 → 发送
3. 任务完成后在任务流中预览并下载；「历史」页可回看

## 说明

- API Key 仅保存在浏览器 localStorage，只发往 sanbaobeauty.com
- 本地服务为透明代理，将 `/api/*` 转发到 `https://sanbaobeauty.com/openapi/v1/*`
- 端口可用环境变量 `PORT` 覆盖：`PORT=9999 node server.js`

## 测试

```bash
npm test   # node --test tests/
```
```

- [ ] **Step 2: 删除临时抓取文件**

Run: `rm -f docs_src.html index_src.html models_public.json`

- [ ] **Step 3: 全量验证**

Run: `npm test`
Expected: 全部 PASS（server 3 个 + core 11 个）

Run: `node server.js` → 手工走一遍 Task 4 的端到端清单。

---

## 自审记录

- **Spec 覆盖：** 图片+视频生成（Task 4 onSubmit/生成流程）✓ · 模型库（Task 4 renderModelLibrary）✓ · 余额（Task 4 loadAccount）✓ · 历史持久化（Task 4 persistTerminal/renderHistory）✓ · 上传素材（Task 4 uploadFile）✓ · 积分预估（Task 2 estimateCost）✓ · CORS 代理（Task 1 handleProxy）✓ · 错误处理（Task 4 handleError）✓ · 品牌「仓鼠AI」暖橙暗色（Task 3）✓。
- **占位符：** 无 TBD/TODO。
- **类型一致性：** `core.js` 导出名与 `app.js` import 一致；`createApp({upstream,publicDir})` 签名与测试一致；DOM id 与 Task 3 HTML、Task 4 JS 一一对应。
