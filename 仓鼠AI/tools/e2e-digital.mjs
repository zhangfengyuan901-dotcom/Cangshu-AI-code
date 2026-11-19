/**
 * 数字人功能端到端测试（真实浏览器 + mock 掉上游接口）。
 *
 * 依赖：npm i --no-save playwright   （使用系统已装的 Chrome，无需下载浏览器）
 * 运行：node tools/e2e-digital.mjs
 */
import { chromium } from 'playwright';
import { createApp } from '../server.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'tmp-fixtures');

let failures = 0;
function check(name, cond, extra = '') {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ' — ' + extra : ''}`);
}

const MODELS = {
  object: 'list',
  data: [
    { id: 'sd2_value', name: 'SD2.0高性价比版', type: 'video', billing: 'per_generation',
      resolutions: ['720p'], ratios: ['16:9'], durations: [5], price_credits: 40,
      default_ratio: '16:9', default_resolution: '720p', default_duration_seconds: 5,
      concurrency_options: [1, 2, 4], max_images: 9, max_image_size_mb: 20 },
    { id: 'gpt-image2', name: 'gpt-image2', type: 'image', billing: 'per_generation',
      aspect_ratios: ['auto', '1:1'], quality_options: ['high', 'medium', 'low'],
      price_credits: 0.8, concurrency_options: [1, 2, 4], max_images: 5 },
  ],
};

async function main() {
  const app = createApp({ configPath: path.join(FIX, 'e2e-config.json') });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const port = app.address().port;
  const BASE = `http://127.0.0.1:${port}`;
  console.log(`server on ${BASE}\n`);

  const browser = await chromium.launch({ channel: 'chrome' });

  // ---- 0. 未配置数字人 Key 时的表现（独立页面，避免影响后续用例） ----
  {
    const p0 = await browser.newPage();
    await p0.route('**/api/config', (r) => r.fulfill({ json: { configured: false, rhConfigured: false } }));
    await p0.route('**/api/public-models', (r) => r.fulfill({ json: MODELS }));
    await p0.goto(BASE, { waitUntil: 'networkidle' });
    await p0.click('[data-view="digital"]');
    await p0.waitForTimeout(250);
    check('未配置 Key 时提交按钮禁用', await p0.locator('#dhSubmit').isDisabled());
    const h = await p0.locator('#dhHint').innerText();
    check('未配置 Key 时提示去账户页填写', h.includes('数字人') && h.includes('账户'), h);
    await p0.click('[data-view="depth"]');
    check('未配置共用 Key 时深度视频按钮禁用', await p0.locator('#depthSubmit').isDisabled());
    await p0.click('[data-view="reverse"]');
    check('未配置共用 Key 时视频反推按钮禁用', await p0.locator('#reverseSubmit').isDisabled());
    await p0.close();
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  let rhRunPayload = null;
  let rhRunUrl = '';
  let savePayload = null;

  // ---- mock 所有外部接口 ----
  await page.route('**/api/config', (r) => r.fulfill({ json: { configured: true, rhConfigured: true } }));
  await page.route('**/api/public-models', (r) => r.fulfill({ json: MODELS }));
  await page.route('**/api/me', (r) => r.fulfill({ json: { data: { credits: 128.5 } } }));
  await page.route('**/api/models', (r) => r.fulfill({ json: MODELS }));
  await page.route('**/api/uploads/raw**', (r) => r.fulfill({
    json: { file: { url: 'https://example.com/dragged.png', kind: 'image', contentType: 'image/png', size: 4 } },
  }));
  await page.route('**/api/save-result', async (r) => {
    savePayload = JSON.parse(r.request().postData() || '{}');
    return r.fulfill({ json: { ok: true, fileName: '仓鼠-result.mp4', localPath: 'C:\\Desktop\\仓鼠AI生成结果\\仓鼠-result.mp4' } });
  });
  await page.route('**/rh/media/upload/binary', (r) => r.fulfill({
    json: { code: 0, message: 'success', data: { type: 'image', download_url: 'mock.png', fileName: 'openapi/mock-upload.png', size: '123' } },
  }));
  await page.route('**/rh/run/ai-app/**', async (r) => {
    rhRunUrl = r.request().url();
    rhRunPayload = JSON.parse(r.request().postData() || '{}');
    const taskId = rhRunUrl.endsWith('/2094793773539741698') ? 'TASK_REVERSE_1' : 'TASK_E2E_1';
    return r.fulfill({ json: { taskId, status: 'RUNNING', errorCode: '', errorMessage: '', results: null } });
  });
  await page.route('**/rh/query', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const reverse = body.taskId === 'TASK_REVERSE_1';
    return r.fulfill({ json: {
      taskId: body.taskId, status: 'SUCCESS', errorCode: '', errorMessage: '',
      usage: { consumeCoins: reverse ? '1' : '12' },
      results: reverse
        ? [{ url: null, nodeId: '51', outputType: 'txt', text: '一只仓鼠在暖色工作室中缓慢转身，镜头平稳推进。' }]
        : [{ url: 'https://example.com/out.mp4', nodeId: '2', outputType: 'mp4', text: null }],
    } });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // ---- 1. 导航结构 ----
  const navText = await page.locator('.rail-nav').innerText();
  check('导航含「数字人」', navText.includes('数字人'), navText.replace(/\s+/g, ' '));
  check('左侧导航含工具箱分区和黑白深度视频',
    (await page.locator('.rail-section-label').innerText()) === '工具箱' && navText.includes('黑白深度') && navText.includes('视频反推'));
  check('历史和账户已移到导航栏下方',
    (await page.locator('.rail-utility').innerText()).includes('历史') && (await page.locator('.rail-utility').innerText()).includes('账户'));
  check('导航已移除「模型库」', !navText.includes('模型库'));
  const logoAnimation = await page.locator('.logo-pixels i').first().evaluate((el) => getComputedStyle(el).animationName);
  check('仓鼠 Logo 像素扩散动画已启用', logoAnimation === 'pixel-diffuse', logoAnimation);
  const componentLibraries = await page.evaluate(() => ({
    lucideIcons: document.querySelectorAll('svg.lucide').length,
    motion: document.documentElement.dataset.uiMotion,
  }));
  check('Lucide 图标组件已本地加载', componentLibraries.lucideIcons >= 10, JSON.stringify(componentLibraries));
  check('AutoAnimate 动态列表动画已启用', componentLibraries.motion === 'auto-animate', JSON.stringify(componentLibraries));

  // ---- 2. 没填 RH Key 时按钮禁用 ----
  await page.click('[data-view="digital"]');
  await page.waitForTimeout(200);
  check('数字人页可见', await page.locator('[data-panel="digital"]').isVisible());
  check('已配置但未传素材时提交禁用', await page.locator('#dhSubmit').isDisabled());
  check('数字人生成按钮旁显示固定 20 积分',
    (await page.locator('#dhCostPreview').innerText()) === '20'
      && await page.locator('.digital-cost:has(#dhCostPreview) svg.lucide-zap').count() === 1);
  const audioFrameAnimation = await page.locator('#dhAudioBox').evaluate((el) => getComputedStyle(el, '::before').animationName);
  check('数字人音频框独立轨道动画已启用', audioFrameAnimation === 'frame-orbit', audioFrameAnimation);

  // ---- 3. 上传参考图 ----
  await page.setInputFiles('#dhImageFile', path.join(FIX, 'ref.png'));
  await page.waitForFunction(() => document.querySelector('#dhImageInfo').textContent.includes('✓'), null, { timeout: 8000 });
  check('参考图上传成功并显示文件名', (await page.locator('#dhImageInfo').innerText()).includes('ref.png'));
  check('参考图缩略图已渲染', await page.locator('#dhImageBox img').count() === 1);

  // ---- 4. 上传超长音频（35s）应被拒绝 ----
  await page.setInputFiles('#dhAudioFile', path.join(FIX, 'long.wav'));
  await page.waitForFunction(() => document.querySelector('#dhAudioInfo').className.includes('error'), null, { timeout: 8000 });
  const longMsg = await page.locator('#dhAudioInfo').innerText();
  check('超 30 秒音频被拒绝', longMsg.includes('超过') && longMsg.includes('30'), longMsg);
  check('拒绝后提交仍禁用', await page.locator('#dhSubmit').isDisabled());

  // ---- 5. 上传合规音频（2s） ----
  await page.setInputFiles('#dhAudioFile', path.join(FIX, 'short.wav'));
  await page.waitForFunction(() => document.querySelector('#dhAudioInfo').className.includes('ok'), null, { timeout: 8000 });
  check('合规音频上传成功', (await page.locator('#dhAudioInfo').innerText()).includes('short.wav'));
  check('两素材就绪后提交按钮启用', await page.locator('#dhSubmit').isEnabled());
  await page.screenshot({ path: path.join(FIX, 'shot-digital-ready.png') });

  // ---- 6. 提交并轮询到成功 ----
  await page.click('#dhSubmit');
  await page.waitForFunction(() => document.querySelector('#dhResults').innerText.includes('已完成'), null, { timeout: 25000 });
  const resultText = await page.locator('#dhResults').innerText();
  check('数字人任务显示已完成', resultText.includes('已完成'), resultText.replace(/\s+/g, ' ').slice(0, 80));
  check('结果渲染出 video 元素', await page.locator('#dhResults video').count() === 1);
  check('显示 24 小时有效期提示', resultText.includes('24 小时'));
  await page.waitForFunction(() => document.querySelector('#dhResults').innerText.includes('已自动保存'), null, { timeout: 8000 });
  check('生成结果自动保存请求正确', savePayload?.taskId === 'TASK_E2E_1' && savePayload?.outputType === 'mp4', JSON.stringify(savePayload));
  const digitalHistory = await page.evaluate(() => JSON.parse(localStorage.getItem('hamster_history') || '[]').find((item) => item.modelName === '仓鼠-数字人'));
  check('数字人历史记录固定记账 20 积分', digitalHistory?.cost === 20, JSON.stringify(digitalHistory));
  check('任务未串到「生成」页', (await page.locator('#taskFeed').innerText()).trim() === '');

  // ---- 7. 请求体正确性 ----
  check('提交体含 nodeInfoList', Array.isArray(rhRunPayload?.nodeInfoList));
  const imgNode = rhRunPayload?.nodeInfoList?.find((n) => n.nodeId === '133');
  const audNode = rhRunPayload?.nodeInfoList?.find((n) => n.nodeId === '125');
  check('图片节点 133 正确', imgNode?.fieldName === 'image' && imgNode?.fieldValue === 'openapi/mock-upload.png', JSON.stringify(imgNode));
  check('音频节点 125 正确', audNode?.fieldName === 'audio' && audNode?.fieldValue === 'openapi/mock-upload.png', JSON.stringify(audNode));
  check('instanceType=default', rhRunPayload?.instanceType === 'default');
  check('usePersonalQueue=false', rhRunPayload?.usePersonalQueue === false);

  // ---- 8. 工具箱：黑白深度视频 ----
  await page.click('[data-view="depth"]');
  check('黑白深度视频工具页可见', await page.locator('[data-panel="depth"]').isVisible());
  check('黑白深度视频固定显示 10 积分',
    (await page.locator('#depthCostPreview').innerText()) === '10'
      && await page.locator('#depthSubmit').isDisabled());
  const guideText = await page.locator('.tool-guide').innerText();
  check('深度视频教程包含概念、素材分工和使用步骤',
    guideText.includes('Depth Map') && guideText.includes('Who') && guideText.includes('How / Where') && guideText.includes('全能参考'));
  check('教程包含可复用的 Seedance 提示词模板',
    (await page.locator('#depthPromptTemplate').innerText()).includes('@图片1')
      && (await page.locator('#depthPromptTemplate').innerText()).includes('@视频1'));
  await page.click('#depthPromptCopy');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('模板已复制'));
  check('教程提示词模板支持一键复制', (await page.locator('#toast').innerText()).includes('模板已复制'));
  const depthTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([0, 0, 0, 24])], 'source.mp4', { type: 'video/mp4' }));
    return transfer;
  });
  await page.locator('#depthVideoBox').dispatchEvent('drop', { dataTransfer: depthTransfer });
  await page.waitForFunction(() => document.querySelector('#depthVideoInfo')?.textContent.includes('source.mp4'), null, { timeout: 8000 });
  await depthTransfer.dispose();
  check('深度视频支持拖入上传并启用生成按钮', await page.locator('#depthSubmit').isEnabled());
  await page.waitForTimeout(450);
  await page.locator('#toast').evaluate((el) => el.classList.remove('show'));
  await page.screenshot({ path: path.join(FIX, 'shot-depth-ready.png') });
  await page.screenshot({ path: path.join(FIX, 'shot-depth-guide.png'), fullPage: true });
  await page.click('#depthSubmit');
  await page.waitForFunction(() => document.querySelector('#depthResults')?.innerText.includes('已完成'), null, { timeout: 25000 });
  await page.waitForFunction(() => document.querySelector('#depthResults')?.innerText.includes('已自动保存'), null, { timeout: 8000 });
  check('深度视频使用文档指定工作流', rhRunUrl.endsWith('/run/ai-app/2089021172049596418'), rhRunUrl);
  const depthNode = rhRunPayload?.nodeInfoList?.find((n) => n.nodeId === '183');
  check('深度视频节点 183 映射正确',
    depthNode?.fieldName === 'video' && depthNode?.fieldValue === 'openapi/mock-upload.png', JSON.stringify(depthNode));
  check('深度视频实例参数正确', rhRunPayload?.instanceType === 'default' && rhRunPayload?.usePersonalQueue === false);
  const depthHistory = await page.evaluate(() => JSON.parse(localStorage.getItem('hamster_history') || '[]').find((item) => item.modelName === '仓鼠-黑白深度视频'));
  check('深度视频历史记录固定记账 10 积分', depthHistory?.cost === 10, JSON.stringify(depthHistory));

  // ---- 9. 工具箱：视频反推 ----
  await page.click('[data-view="reverse"]');
  check('视频反推工具页可见', await page.locator('[data-panel="reverse"]').isVisible());
  check('视频反推固定显示 2 积分',
    (await page.locator('#reverseCostPreview').innerText()) === '2'
      && await page.locator('#reverseSubmit').isDisabled());
  const reverseTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([0, 0, 0, 24])], 'reference.mp4', { type: 'video/mp4' }));
    return transfer;
  });
  await page.locator('#reverseVideoBox').dispatchEvent('drop', { dataTransfer: reverseTransfer });
  await page.waitForFunction(() => document.querySelector('#reverseVideoInfo')?.textContent.includes('reference.mp4'), null, { timeout: 8000 });
  await reverseTransfer.dispose();
  check('视频反推支持拖入上传并启用按钮', await page.locator('#reverseSubmit').isEnabled());
  await page.waitForTimeout(400);
  await page.locator('#toast').evaluate((el) => el.classList.remove('show'));
  await page.screenshot({ path: path.join(FIX, 'shot-reverse-ready.png') });
  await page.click('#reverseSubmit');
  await page.waitForFunction(() => document.querySelector('#reverseResults')?.innerText.includes('一只仓鼠'), null, { timeout: 25000 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(FIX, 'shot-reverse-result.png') });
  check('视频反推使用文档指定工作流', rhRunUrl.endsWith('/run/ai-app/2094793773539741698'), rhRunUrl);
  const reverseNode = rhRunPayload?.nodeInfoList?.find((n) => n.nodeId === '50');
  check('视频反推节点 50 映射正确',
    reverseNode?.fieldName === 'file' && reverseNode?.fieldValue === 'openapi/mock-upload.png' && reverseNode?.description === '加载视频', JSON.stringify(reverseNode));
  check('视频反推实例参数正确', rhRunPayload?.instanceType === 'default' && rhRunPayload?.usePersonalQueue === false);
  check('视频反推文本结果与复制按钮已显示',
    await page.locator('#reverseResults .text-result').count() === 1 && await page.locator('#reverseResults [data-copy-result]').count() === 1);
  const reverseHistory = await page.evaluate(() => JSON.parse(localStorage.getItem('hamster_history') || '[]').find((item) => item.modelName === '仓鼠-视频反推'));
  check('视频反推历史记录固定记账 2 积分', reverseHistory?.cost === 2, JSON.stringify(reverseHistory));

  // ---- 10. 生成页模型选择器（回归：不填 Key 也应有模型） ----
  await page.click('[data-view="generate"]');
  await page.waitForTimeout(300);
  const modelLabel = await page.locator('#modelLabel').innerText();
  check('生成页模型选择器非空（修复回归）', modelLabel !== '暂无模型', `modelLabel="${modelLabel}"`);
  check('上游模型名已加仓鼠前缀', modelLabel.startsWith('仓鼠-'), modelLabel);
  check('比例、画质、时长已拆成独立控件',
    await page.locator('[data-menu="ratio"]').isVisible()
      && await page.locator('[data-menu="quality"]').isVisible()
      && await page.locator('[data-menu="duration"]').isVisible());
  check('独立规格展示当前值',
    (await page.locator('#ratioLabel').innerText()) === '16:9'
      && (await page.locator('#qualityLabel').innerText()) === '720p'
      && (await page.locator('#durationLabel').innerText()) === '5s');
  await page.click('[data-menu="model"]');
  check('模型渠道使用卡片式展开选择',
    await page.locator('.channel-popover').isVisible() && await page.locator('.channel-card').count() > 0);
  check('当前渠道卡片有选中态', await page.locator('.channel-card.selected').count() === 1);
  await page.screenshot({ path: path.join(FIX, 'shot-channel-picker.png') });
  await page.click('.stage-title');
  const materialFrameAnimation = await page.locator('.media-tile[data-kind="image"]').evaluate((el) => getComputedStyle(el, '::before').animationName);
  check('素材上传框独立轨道动画已启用', materialFrameAnimation === 'frame-orbit', materialFrameAnimation);
  const styleCoverage = await page.evaluate(() => {
    const selectors = ['.rail-item', '.credit-card', '.media-tile', '.tool-pill', '.send-button', '.upload-box', '.plain-button', '.chip', '.account-card input', '.toast'];
    return selectors.map((selector) => {
      const el = document.querySelector(selector);
      const style = el ? getComputedStyle(el) : null;
      const animated = style && (style.transitionDuration.split(',').some((v) => v.trim() !== '0s') || style.animationName !== 'none');
      return { selector, found: Boolean(el), animated: Boolean(animated) };
    });
  });
  check('所有交互组件类型均有过渡或动画', styleCoverage.every((item) => item.found && item.animated), JSON.stringify(styleCoverage.filter((item) => !item.found || !item.animated)));
  await page.click('[data-menu="type"]');
  const popoverAnimation = await page.locator('.menu-popover').evaluate((el) => getComputedStyle(el).animationName);
  check('下拉菜单入场动画已启用', popoverAnimation === 'popover-in', popoverAnimation);
  await page.click('.stage-title');

  // ---- 11. 拖放素材 ----
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'dragged.png', { type: 'image/png' }));
    return transfer;
  });
  await page.locator('#generationForm').dispatchEvent('drop', { dataTransfer });
  await page.waitForFunction(() => document.querySelector('#mediaList')?.innerText.includes('dragged.png'), null, { timeout: 8000 });
  check('拖入图片后已上传并进入生成素材列表', (await page.locator('#mediaList').innerText()).includes('dragged.png'));
  await dataTransfer.dispose();

  await page.fill('#prompt', '@');
  await page.waitForFunction(() => !document.querySelector('#mentionMenu')?.hidden);
  check('输入 @ 会展开素材引用菜单', await page.locator('.mention-option').count() === 1);
  await page.keyboard.press('Enter');
  check('回车可插入素材引用', (await page.locator('#prompt').inputValue()).includes('@图片1'));
  await page.locator('.media-tag').click();
  check('点击素材标签也会插入引用', ((await page.locator('#prompt').inputValue()).match(/@图片1/g) || []).length === 2);

  await page.screenshot({ path: path.join(FIX, 'shot-generate.png') });

  check('无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  await browser.close();
  app.close();

  console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('E2E 崩溃:', e); process.exit(1); });
