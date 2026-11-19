import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL('../website/public/' + path, import.meta.url), 'utf8');
const page = read('tutorials/index.html');
const versioned = read('tutorials/1.7.49/index.html');
const archived = read('tutorials/1.7.46/index.html');

test('默认教程展示 1.7.49 三 Key、报价、批次和手动画布，目录可直达', () => {
  const sections = [...page.matchAll(/<section class="tutorial-chapter reveal" id="([a-z]+)"/g)].map(match => match[1]);
  assert.deepEqual(sections, ['account', 'quote', 'batch', 'canvas']);
  assert.match(page, /<aside class="tutorial-sidebar" aria-label="教程目录">/);
  for (const id of sections) assert.match(page, new RegExp(`<a href="#${id}">`));
  assert.match(page, /适用于仓鼠AI 1\.7\.49/);
  assert.match(page, /图片 Key、视频 Key、工具 Key 必须来自同一账户，共用账户余额/);
  assert.match(page, /工具 Key 供数字人和黑白深度共用/);
  assert.match(page, /留空表示保留原 Key/);
  assert.match(page, /失效项可单独移除/);
  assert.match(page, /检测不创建生成任务，不扣费/);
  assert.match(page, /连接检测通过只表示认证及当前可用线路已确认/);
});

test('新版教程说明报价边界、有效素材上限和当前图片编辑限制', () => {
  assert.match(page, /已发布名称、客户单价与计费单位/);
  assert.match(page, /当前总数最多 20 个/);
  assert.match(page, /只读报价不上传素材、不冻结、不扣费/);
  assert.match(page, /报价过期、参数改变或改价时需重新获取并确认/);
  assert.match(page, /圈选暂不可用/);
  assert.match(page, /不能通过忽略笔画继续提交/);
  assert.match(page, /单图图片线路支持原图加文字修改/);
});

test('新版教程区分停止未发送份数、已提交任务、未知任务与结果保存失败', () => {
  assert.match(page, /停止剩余.*只阻止尚未发送的份数/);
  assert.match(page, /不表示任务取消或已退款/);
  assert.match(page, /刷新和重启不会自动继续剩余份数/);
  assert.match(page, /核对原任务，勿重复生成/);
  assert.match(page, /清除已结束记录仍保留未知任务/);
  assert.match(page, /没有任务编号时暂不保证自动找回/);
  assert.match(page, /保存失败与生成失败分开/);
  assert.match(page, /余额不足请前往 PIKNO 充值/);
  assert.match(page, /历史线路名称和报价快照保留/);
});

test('新版教程明确手动执行、对话未开放与工作台退役，保留历史', () => {
  assert.match(page, /确认后手动执行；下游不会自动执行/);
  assert.match(page, /旧节点、连线和已绑定结果保留/);
  assert.match(page, /对话服务暂未开放/);
  assert.match(page, /彩色仅表示本次检测成功/);
  assert.match(page, /独立反推／改写工作台已退役/);
  assert.match(page, /本地聊天、附件和历史文字保留/);
  assert.doesNotMatch(page, /自动拆解视频|生成全能参考提示词|创意工作台入口保留/);
});

test('默认与版本化教程正文一致，正式页面不残留候选或待发布文案', () => {
  assert.equal(versioned.replace('https://hamsterai.cc/tutorials/1.7.49/', 'https://hamsterai.cc/tutorials/'), page);
  assert.match(page, /rel="canonical" href="https:\/\/hamsterai\.cc\/tutorials\/"/);
  assert.match(versioned, /rel="canonical" href="https:\/\/hamsterai\.cc\/tutorials\/1\.7\.49\/"/);
  for (const current of [page, versioned]) {
    assert.doesNotMatch(current, /候选|尚未正式发布|官网.*仍为 1\.7\.46|name="robots" content="noindex/);
    assert.match(current, /离线模拟/);
    assert.match(current, /不代表实时 PIKNO 价格或实际扣费/);
    assert.match(current, /账户截图为开发模式/);
  }
});

test('公开教程只允许指定的 PIKNO 入口，不包含其他服务方、凭证或内部地址', () => {
  const forbidden = /三宝|RunningHub|Cloudflare|BytePlus|Image 2|\bRH\b|\bARK\b|\bR2\b|上游|密钥|接口|接入点|token|127\.0\.0\.1|localhost|\/api\/|sk-[A-Za-z0-9_-]{8,}|ep-[A-Za-z0-9_-]{8,}/i;
  for (const current of [page, versioned, archived]) {
    assert.doesNotMatch(current, forbidden);
    const urls = [...current.matchAll(/https?:\/\/[^"\s<>]+/g)].map(match => match[0]);
    assert.ok(urls.every(url => url.startsWith('https://hamsterai.cc/') || url === 'https://www.piknoai.com'));
  }
});

test('新版三张演示截图均存在并带说明，旧版完整创作教程留在版本归档', () => {
  const chapters = new Map([...page.matchAll(/<section class="tutorial-chapter reveal" id="([a-z]+)"[\s\S]*?<\/section>/g)].map(match => [match[1], match[0]]));
  for (const [chapter, name] of [['account', 'account'], ['quote', 'editor'], ['canvas', 'canvas']]) {
    const asset = `/assets/tutorial-1749-${name}.png`;
    assert.ok(chapters.get(chapter)?.includes(asset));
    assert.ok(existsSync(new URL('../website/public' + asset, import.meta.url)));
    assert.match(chapters.get(chapter), /离线模拟截图/);
  }
  assert.match(archived, /1\.7\.46 版本归档：此页双 Key 与工作台流程不适用于新版/);
  assert.match(archived, /查看 1\.7\.49 正式版教程/);
  assert.match(archived, /如何构建自己的达人资产？/);
  assert.match(archived, /CRITICAL PRESERVATION OVERRIDE/);
  assert.match(archived, /data-copy-prompt="characterSheetPrompt"/);
  assert.match(archived, /生成全能参考提示词/);
  for (const asset of ['tutorial-talent.webp', 'tutorial-talent-sheet.webp', 'tutorial-talent-sad.webp', 'tutorial-talent-outfit.webp', 'tutorial-reference.mp4', 'tutorial-binding.webp', 'tutorial-prompt.webp', 'tutorial-result-preview.webp', 'tutorial-final.mp4']) {
    assert.ok(archived.includes('/assets/' + asset));
    assert.ok(existsSync(new URL('../website/public/assets/' + asset, import.meta.url)));
  }
});
