export const STORE_PREFIX = '/__control-store/v1/';
export const META_HEADER = 'x-pikno-object';
export const OPTIONS_HEADER = 'x-pikno-options';
export const isControlPath = (path) => path === '/media/v1/packy' || path === '/media/v1/tools' || path.startsWith('/media/v1/tools/');
export const isAssetPath = (path) => /^\/media\/v1\/assets\/[a-f0-9]{32}(\/inspect)?$/.test(path);

// Only objects used by the pinned control runtime are accessible. No listing API.
export function keyLimit(key) {
  if (/^tool-config\/(active|versions\/[a-f0-9]{32})$/.test(key)) return 2048;
  if (/^tool-jobs\/[A-Za-z0-9_-]{1,200}$/.test(key)) return 65536;
  if (/^tool-polls\/[A-Za-z0-9_-]{1,200}$/.test(key)) return 64;
  if (/^input\/edge-requests\/[1-9]\d{0,15}\/[a-f0-9]{32}$/.test(key)) return 64;
  if (/^input\/[1-9]\d{0,15}\/[a-f0-9]{32}$/.test(key)) return 50 << 20;
  return 0;
}

export function encodeHeader(value) { return encodeURIComponent(JSON.stringify(value)); }
export function decodeHeader(value, maximum = 8192) {
  if (!value || value.length > maximum) throw Error('Invalid storage metadata');
  return JSON.parse(decodeURIComponent(value));
}

export function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !['onlyIf', 'httpMetadata', 'customMetadata'].includes(key))) throw Error('Invalid storage options');
  if (options.onlyIf) {
    const entries = Object.entries(options.onlyIf);
    if (entries.length !== 1 || !['etagMatches', 'etagDoesNotMatch'].includes(entries[0][0]) || typeof entries[0][1] !== 'string' || !/^[A-Za-z0-9*_-]{1,128}$/.test(entries[0][1]) || (entries[0][0] === 'etagDoesNotMatch' && entries[0][1] !== '*')) throw Error('Invalid storage condition');
  }
  for (const [field, names] of [['httpMetadata', ['contentType']], ['customMetadata', ['uid', 'expires', 'lease']]]) {
    const value = options[field];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, item]) => !names.includes(key) || typeof item !== 'string' || item.length > 128 || /[\r\n]/.test(item)))) throw Error('Invalid storage metadata');
  }
  return options;
}

export async function sameSecret(a, b) {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))));
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

export function storageSecretValid(env) {
  const secret = env.TOOL_STORE_SECRET;
  return typeof secret === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(secret) && !['TICKET_KEY', 'TOOLS_BRIDGE_SECRET', 'TOOLS_ADMIN_SECRET', 'RUNNINGHUB_API_KEY', 'RH_CONFIG_ENCRYPTION_KEY'].some((key) => secret === env[key]);
}
