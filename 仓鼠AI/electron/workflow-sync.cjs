const fs = require('node:fs/promises');
const path = require('node:path');

const retired = [
  'app', 'agents', 'main.py', 'debug.py',
  'studio-ui/index.html', 'studio-ui/studio.css', 'studio-ui/studio.js',
  'studio-ui/lucide-LICENSE.txt', 'studio-ui/lucide.min.js',
  'creative.py', 'creative_prompt.py', 'creative_result.py', 'creative-ui',
];

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

async function checkedRetiredPaths(target) {
  const root = await fs.realpath(path.resolve(target));
  const checked = [];
  for (const name of retired) {
    const candidate = path.resolve(root, name);
    if (!contained(root, candidate)) throw Error('退役文件路径超出工作流目录');
    // A parent junction could redirect a fixed code filename into customer data
    // or another directory. Reject it before copying or removing any code.
    let parent = path.dirname(candidate);
    while (parent !== root) {
      try {
        if (path.relative(parent, await fs.realpath(parent)) !== '') throw Error('退役文件父目录指向非预期位置');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        parent = path.dirname(parent);
      }
    }
    try {
      const resolved = await fs.realpath(candidate);
      if (!contained(root, resolved) || path.relative(candidate, resolved) !== '') throw Error('退役文件路径指向非预期位置');
      checked.push(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return checked;
}

async function syncWorkflow(source, target, appVersion) {
  const marker = '.hamster-workflow-version';
  const releaseMarker = '.hamster-workflow-app-version';
  const readMarker = file => fs.readFile(file, 'utf8').then(value => value.trim()).catch(() => '');
  const sourceVersion = (await fs.readFile(path.join(source, marker), 'utf8')).trim();
  const targetVersion = await readMarker(path.join(target, marker));
  const targetRelease = await readMarker(path.join(target, releaseMarker));
  if (sourceVersion === targetVersion && targetRelease === appVersion) return false;

  // A new app release must refresh code even when the manual workflow marker was unchanged.
  // Runtime data and customer configuration never belong to the bundled code payload.
  const preserved = new Set([marker, releaseMarker, 'config.yaml', '.env',
    'chat-data', 'creative-data', 'studio-data', 'merged_videos', '__pycache__', '.venv']);
  await fs.mkdir(target, { recursive: true });
  await checkedRetiredPaths(target);
  await fs.cp(source, target, { recursive: true, force: true,
    filter: entry => {
      const relative = path.relative(source, entry).split(path.sep).join('/');
      return !preserved.has(path.basename(entry)) && !retired.some(name => relative === name || relative.startsWith(name + '/'));
    } });
  // Validate every resolved target before removing any retired code. Customer data
  // directories are absent from this fixed list and are never cleanup targets.
  for (const candidate of await checkedRetiredPaths(target)) await fs.rm(candidate, { recursive: true, force: true });
  // Commit both markers only after all code has been synchronized successfully.
  await fs.copyFile(path.join(source, marker), path.join(target, marker));
  await fs.writeFile(path.join(target, releaseMarker), appVersion + '\n');
  return true;
}

module.exports = { syncWorkflow };
