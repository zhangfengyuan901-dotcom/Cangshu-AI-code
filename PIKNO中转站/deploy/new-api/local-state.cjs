const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bundleRoot = __dirname;
const externalRoot = process.env.PIKNO_LOCAL_DATA_DIR || path.join(
  process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  'HamsterAI-WorkspaceData',
  'relay',
);

// Existing ECS/operator installs can still use their established local layout.
const dataRoot = process.env.PIKNO_LOCAL_DATA_DIR || (fs.existsSync(path.join(bundleRoot, 'private')) ? bundleRoot : externalRoot);

module.exports = {
  privateDir: path.join(dataRoot, 'private'),
  envPath: path.join(dataRoot, '.env'),
};
