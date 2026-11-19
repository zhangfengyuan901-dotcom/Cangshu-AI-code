const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { syncWorkflow } = require('../electron/workflow-sync.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hamster-workflow-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'bundle'), target = path.join(root, 'user-workflow');
  await fs.mkdir(source); await fs.mkdir(target);
  for (const dir of [source, target]) await fs.writeFile(path.join(dir, '.hamster-workflow-version'), '32');
  await fs.writeFile(path.join(source, 'chat.py'), 'new cloud gateway code');
  await fs.writeFile(path.join(target, 'chat.py'), 'old direct inference code');
  return { source, target };
}

test('legacy matching workflow marker still upgrades code without touching customer data', async t => {
  const { source, target } = await fixture(t);
  for (const file of ['config.yaml', 'chat-data/history.db', 'creative-data/tasks.json', 'studio-data/material.png']) {
    for (const [dir, value] of [[source, 'bundled fixture'], [target, 'customer data']]) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), value);
    }
  }
  assert.equal(await syncWorkflow(source, target, '1.7.37'), true);
  assert.equal(await fs.readFile(path.join(target, 'chat.py'), 'utf8'), 'new cloud gateway code');
  for (const file of ['config.yaml', 'chat-data/history.db', 'creative-data/tasks.json', 'studio-data/material.png']) {
    assert.equal(await fs.readFile(path.join(target, file), 'utf8'), 'customer data');
  }
  assert.equal(await syncWorkflow(source, target, '1.7.37'), false);
  await fs.writeFile(path.join(source, 'chat.py'), 'next release');
  assert.equal(await syncWorkflow(source, target, '1.7.38'), true);
  assert.equal(await fs.readFile(path.join(target, 'chat.py'), 'utf8'), 'next release');
});

test('workflow revision change upgrades within the same app release', async t => {
  const { source, target } = await fixture(t);
  await syncWorkflow(source, target, '1.7.37');
  await fs.writeFile(path.join(source, '.hamster-workflow-version'), '33');
  assert.equal(await syncWorkflow(source, target, '1.7.37'), true);
  assert.equal(await fs.readFile(path.join(target, '.hamster-workflow-version'), 'utf8'), '33');
});

test('failed synchronization does not commit successful release markers', async t => {
  const { source, target } = await fixture(t);
  await fs.writeFile(path.join(target, '.hamster-workflow-app-version'), '1.7.36');
  await fs.writeFile(path.join(source, '.hamster-workflow-version'), '33');
  await fs.unlink(path.join(target, 'chat.py'));
  await fs.mkdir(path.join(target, 'chat.py'));
  await assert.rejects(syncWorkflow(source, target, '1.7.37'));
  assert.equal(await fs.readFile(path.join(target, '.hamster-workflow-version'), 'utf8'), '32');
  assert.equal(await fs.readFile(path.join(target, '.hamster-workflow-app-version'), 'utf8'), '1.7.36');
});

test('upgrade retires creative code without copying it or changing chat, creative history, configuration or exports', async t => {
  const { source, target } = await fixture(t);
  const retired = ['creative.py', 'creative_prompt.py', 'creative_result.py', 'creative-ui/index.html', 'creative-ui/creative.js'];
  for (const dir of [source, target]) {
    for (const file of retired) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), 'retired implementation');
    }
  }
  const preserved = ['chat-data/conversations.sqlite3', 'chat-data/session/attachment.mp4', 'creative-data/job.json',
    'creative-data/original.mp4', 'studio-data/legacy.png', 'merged_videos/old.mp4', 'config.yaml', '.env'];
  for (const file of preserved) {
    await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await fs.writeFile(path.join(target, file), 'customer fixture');
  }
  const exported = path.join(path.dirname(target), 'results', '创意工作台', '旧提示词.txt');
  await fs.mkdir(path.dirname(exported), { recursive: true });
  await fs.writeFile(exported, 'customer exported prompt');
  await syncWorkflow(source, target, '1.7.47');
  for (const file of retired) await assert.rejects(fs.access(path.join(target, file)), { code: 'ENOENT' });
  for (const file of preserved) assert.equal(await fs.readFile(path.join(target, file), 'utf8'), 'customer fixture');
  assert.equal(await fs.readFile(exported, 'utf8'), 'customer exported prompt');
  assert.equal(await fs.readFile(path.join(target, 'chat.py'), 'utf8'), 'new cloud gateway code');
});

test('retirement rejects a junction outside the workflow before copying or deleting anything', async t => {
  const { source, target } = await fixture(t);
  const outside = path.join(path.dirname(target), 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'index.html'), 'unrelated file');
  await fs.symlink(outside, path.join(target, 'creative-ui'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(syncWorkflow(source, target, '1.7.47'), /非预期位置/);
  assert.equal(await fs.readFile(path.join(outside, 'index.html'), 'utf8'), 'unrelated file');
  assert.equal(await fs.readFile(path.join(target, 'chat.py'), 'utf8'), 'old direct inference code');
  await assert.rejects(fs.access(path.join(target, '.hamster-workflow-app-version')), { code: 'ENOENT' });
});

test('retirement rejects a parent junction redirected into preserved customer data', async t => {
  const { source, target } = await fixture(t);
  const data = path.join(target, 'creative-data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'studio.css'), 'customer fixture');
  await fs.symlink(data, path.join(target, 'studio-ui'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(syncWorkflow(source, target, '1.7.47'), /父目录指向非预期位置/);
  assert.equal(await fs.readFile(path.join(data, 'studio.css'), 'utf8'), 'customer fixture');
  assert.equal(await fs.readFile(path.join(target, 'chat.py'), 'utf8'), 'old direct inference code');
});
