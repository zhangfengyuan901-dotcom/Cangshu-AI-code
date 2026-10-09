'use strict';

// Stages confirmed PIKNO prices and groups while every customer channel stays disabled.
// Requires a short-lived root session in private/admin-session.json or environment.
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.NEW_API_BASE || 'http://127.0.0.1:3100';
const PRIVATE = path.join(__dirname, 'private');
const DRAFT_FILE = path.join(__dirname, 'pricing.draft.json');
const SESSION_FILE = path.join(PRIVATE, 'admin-session.json');
const JOURNAL_DIR = path.join(PRIVATE, 'pricing-rollout');
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'stage-result.json');
const IMAGE_MODEL = 'gpt-image-2.5-flare';
const VIDEO_MODEL = 'sanbao/sd2_480p_real';
const VIDEO_EXPR_KEY = 'pikno-sanbao::' + VIDEO_MODEL;

const draft = JSON.parse(fs.readFileSync(DRAFT_FILE, 'utf8'));
if (draft.status !== 'draft' || draft.firstReleaseScopeStatus !== 'confirmed') throw new Error('First-release scope is not confirmed');
if (draft.customerReleaseApproved !== false || draft.products.some(item => item.published !== false)) throw new Error('Release safety gate is not closed');
const accounting = draft.newApiAccounting;
if (!accounting || accounting.displayCurrency !== 'CNY' || accounting.groupRatio !== '1.000000') throw new Error('Unexpected accounting draft');
const fx = Number(accounting.cnyPerUsd);
const quotaPerUsd = Number(accounting.quotaPerUsd);
if (!Number.isFinite(fx) || fx <= 0 || !Number.isInteger(quotaPerUsd) || quotaPerUsd <= 0) throw new Error('Invalid accounting conversion');
if (Math.abs(quotaPerUsd / fx - 1_000_000) > 0.000001) throw new Error('Quota precision must equal one micro-CNY');

function product(id) {
  const found = draft.products.find(item => item.id === id);
  if (!found || found.firstReleaseDecision.indexOf('approved') !== 0) throw new Error('Product is not approved for first release: ' + id);
  return found;
}
const image = product('flare-text-1024-high');
const edit = product('flare-edit-1024-high');
const video = product('sanbao-sd2-480p-4s');
if (image.retailPriceCny !== edit.retailPriceCny) throw new Error('Image generation and edit prices differ');
const imageUsd = Number((Number(image.retailPriceCny) / fx).toFixed(15));
const videoUsd = Number((Number(video.retailPriceCny) / fx).toFixed(15));
const imageQuota = Math.round(imageUsd * quotaPerUsd);
const videoQuota = Math.round(videoUsd * quotaPerUsd);
if (imageQuota !== 100_000 || videoQuota !== 6_000_000) throw new Error('Unexpected quota conversion');
const videoExpr = `tier("retail_cny_6", u("requests") * ${videoUsd})`;

const session = process.env.PIKNO_ADMIN_ACCESS_TOKEN && process.env.PIKNO_ADMIN_USER_ID
  ? { accessToken: process.env.PIKNO_ADMIN_ACCESS_TOKEN, userId: process.env.PIKNO_ADMIN_USER_ID }
  : JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
if (!session.accessToken || !session.userId) throw new Error('Short-lived administrator session is missing');
const headers = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer ' + session.accessToken,
  'New-Api-User': String(session.userId),
};

async function request(route, method = 'GET', payload) {
  const response = await fetch(BASE + route, {
    method, headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(route + ': ' + (body.message || 'HTTP ' + response.status));
  return body.data;
}

function canonicalJSON(value) {
  function sort(node) {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.keys(node).sort().map(key => [key, sort(node[key])]));
    }
    return node;
  }
  return JSON.stringify(sort(JSON.parse(value)));
}

function optionMatches(key, actual, expected) {
  const jsonKeys = new Set([
    'GroupRatio',
    'group_ratio_setting.group_ratio',
    'UserUsableGroups',
    'ModelPrice',
    'billing_setting.plugin_billing_expr',
  ]);
  return jsonKeys.has(key) ? canonicalJSON(actual) === canonicalJSON(expected) : actual === expected;
}

async function main() {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  if (fs.existsSync(JOURNAL_FILE)) throw new Error('Pricing stage journal already exists; inspect it before another run');
  const journal = {
    startedAt: new Date().toISOString(),
    draftVersion: draft.version,
    expected: { imageQuota, videoQuota, imageUsd, videoUsd },
    channels: {}, appliedOptions: [], modifiedChannelIds: [], rollback: null,
  };
  const save = () => fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
  save();

  const options = await request('/api/option/');
  const optionMap = Object.fromEntries(options.map(item => [item.key, item.value]));
  if (optionMap.RegisterEnabled !== 'false' || optionMap.PasswordRegisterEnabled !== 'false') throw new Error('Registration must remain closed');
  if (optionMap.RetryTimes !== '0') throw new Error('RetryTimes must remain zero');

  const channels = (await request('/api/channel/?p=1&page_size=100')).items || [];
  const packy = channels.find(item => item.name === 'PIKNO PackyAPI 图片');
  const sanbao = channels.find(item => item.name === 'PIKNO 三宝视频');
  if (!packy || !sanbao || packy.status !== 2 || sanbao.status !== 2) throw new Error('Customer channels must exist and remain disabled');
  journal.channels = {
    packy: { id: packy.id, status: packy.status, group: packy.group },
    sanbao: { id: sanbao.id, status: sanbao.status, group: sanbao.group },
  };
  save();

  const modelPrice = JSON.parse(optionMap.ModelPrice || '{}');
  modelPrice[IMAGE_MODEL] = imageUsd;
  const pluginExpr = JSON.parse(optionMap['billing_setting.plugin_billing_expr'] || '{}');
  pluginExpr[VIDEO_EXPR_KEY] = videoExpr;
  const groups = {
    ...JSON.parse(optionMap.GroupRatio || '{}'),
    ...JSON.parse(optionMap['group_ratio_setting.group_ratio'] || '{}'),
    'image-standard': 1,
    'video-standard': 1,
  };
  if (!Object.prototype.hasOwnProperty.call(groups, 'default')) groups.default = 1;
  const usableGroups = {
    ...JSON.parse(optionMap.UserUsableGroups || '{}'),
    'image-standard': '图片标准线路',
    'video-standard': '视频标准线路',
  };
  if (!Object.prototype.hasOwnProperty.call(usableGroups, 'default')) usableGroups.default = '默认分组';
  const desiredOptions = {
    QuotaPerUnit: String(quotaPerUsd),
    USDExchangeRate: String(fx),
    DisplayInCurrencyEnabled: 'true',
    'general_setting.quota_display_type': 'CNY',
    GroupRatio: JSON.stringify(groups),
    'group_ratio_setting.group_ratio': JSON.stringify(groups),
    UserUsableGroups: JSON.stringify(usableGroups),
    ModelPrice: JSON.stringify(modelPrice),
    'billing_setting.plugin_billing_expr': JSON.stringify(pluginExpr),
  };
  const originals = Object.fromEntries(Object.keys(desiredOptions).map(key => [key, optionMap[key]]));

  try {
    for (const [key, value] of Object.entries(desiredOptions)) {
      await request('/api/option/', 'PUT', { key, value });
      journal.appliedOptions.push(key); save();
    }
    for (const [channel, group] of [[packy, 'image-standard'], [sanbao, 'video-standard']]) {
      await request('/api/channel/', 'PUT', {
        id: channel.id, name: channel.name, type: channel.type,
        base_url: channel.base_url, models: channel.models, group,
        priority: channel.priority, weight: channel.weight, test_model: channel.test_model,
        auto_ban: channel.auto_ban, setting: channel.setting || '', settings: channel.settings || '{}',
        other: channel.other || '', remark: channel.remark || '',
      });
      journal.modifiedChannelIds.push(channel.id); save();
      await request('/api/channel/' + channel.id + '/status', 'POST', { status: 2 });
    }
    const verifyOptions = Object.fromEntries((await request('/api/option/')).map(item => [item.key, item.value]));
    for (const [key, value] of Object.entries(desiredOptions)) {
      if (!optionMatches(key, verifyOptions[key], value)) throw new Error('Option verification failed: ' + key);
    }
    const verifyChannels = (await request('/api/channel/?p=1&page_size=100')).items || [];
    for (const expected of [{ id: packy.id, group: 'image-standard' }, { id: sanbao.id, group: 'video-standard' }]) {
      const current = verifyChannels.find(item => item.id === expected.id);
      if (!current || current.status !== 2 || current.group !== expected.group) throw new Error('Channel verification failed: ' + expected.id);
    }
    journal.completedAt = new Date().toISOString();
    journal.status = 'staged_disabled';
    save();
    console.log(JSON.stringify({ status: journal.status, imageQuota, videoQuota, channelsEnabled: false }));
  } catch (error) {
    journal.error = String(error.message || error).slice(0, 500);
    journal.rollback = { startedAt: new Date().toISOString(), restored: [], errors: [] };
    for (const key of [...journal.appliedOptions].reverse()) {
      try {
        if (originals[key] === undefined) throw new Error('Original option missing');
        await request('/api/option/', 'PUT', { key, value: originals[key] });
        journal.rollback.restored.push(key);
      } catch (rollbackError) {
        journal.rollback.errors.push({ key, error: String(rollbackError.message || rollbackError).slice(0, 300) });
      }
    }
    for (const [channel, original] of [[packy, journal.channels.packy], [sanbao, journal.channels.sanbao]]) {
      if (!journal.modifiedChannelIds.includes(channel.id)) continue;
      try {
        await request('/api/channel/', 'PUT', {
          id: channel.id, name: channel.name, type: channel.type,
          base_url: channel.base_url, models: channel.models, group: original.group,
          priority: channel.priority, weight: channel.weight, test_model: channel.test_model,
          auto_ban: channel.auto_ban, setting: channel.setting || '', settings: channel.settings || '{}',
          other: channel.other || '', remark: channel.remark || '',
        });
        await request('/api/channel/' + channel.id + '/status', 'POST', { status: 2 });
      } catch (rollbackError) {
        journal.rollback.errors.push({ channelId: channel.id, error: String(rollbackError.message || rollbackError).slice(0, 300) });
      }
    }
    journal.rollback.completedAt = new Date().toISOString();
    save();
    throw error;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
