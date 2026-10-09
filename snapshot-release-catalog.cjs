'use strict';
// Read-only supplier catalog snapshot. Does not publish or alter production.
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const targets = ['https://sanbaobeauty.com/api/public/openapi-models', 'https://see.ximeiedu.org/health'];
  const data = await Promise.all(targets.map(async url => {
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('Catalog HTTP ' + r.status);
    return r.json();
  }));
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugins/generated/catalog.json')));
  const report = { checkedAt: new Date().toISOString(), sources: targets, policy: 'Video only; suggested retail = upstream CNY * 2; catalog presence is not generation acceptance', suppliers: [] };
  for (const provider of ['sanbao', 'canseedream']) {
    const rows = provider === 'sanbao' ? data[0].data.filter(x => x.type === 'video') : data[1].defaults.videoProviders;
    const previous = Object.keys(old.specs.find(x => x.provider === provider).models).map(x => x.split('/').pop());
    const conversion = provider === 'sanbao' ? 10 : data[1].defaults.pointPricing.pointsPerYuan;
    report.suppliers.push({ provider, creditsPerCny: conversion, count: rows.length, added: rows.filter(x => !previous.includes(x.id)).map(x => x.id), removed: previous.filter(id => !rows.some(x => x.id === id)), models: rows.map(x => ({ id: x.id, name: x.name || x.label, mode: x.billing || x.pricingMode, advertisedCredits: x.price_credits ?? x.pointsCost, pointsPerSecond: x.price_per_second_credits ?? x.pointsPerSecond, resolutionUnitCredits: x.price_per_second_by_resolution_credits || x.resolutionPointsPerSecond || x.resolutionPoints || null, durations: x.durations || x.allowedDurations || [Number(x.duration)], resolutions: x.resolutions || x.allowedResolutions || [x.resolution], liveGenerationAcceptance: 'pending', raw: x })) });
  }
  report.priceConflicts = [];
  for (const model of report.suppliers[0].models) {
    for (const [resolution, cny] of Object.entries(model.raw.price_per_second_by_resolution_cny || {})) {
      const credits = model.raw.price_per_second_by_resolution_credits?.[resolution];
      if (credits != null && Math.abs(credits / 10 - cny) > 0.000001) report.priceConflicts.push({ model: model.id, resolution, credits, calculatedCny: credits / 10, advertisedCny: cny });
    }
  }
  const dir = path.resolve(__dirname, '../../output/upstream-release-20261008');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(report, null, 2));
  const lines = ['# 上游视频模型发布前目录检查', '', '此清单仅证明目录与价格配置可读取，不证明真实生成成功。图片渠道仍仅使用 PackyAPI。', ''];
  for (const supplier of report.suppliers) {
    lines.push('## ' + supplier.provider, '', `共 ${supplier.count} 条；${supplier.creditsPerCny} 积分/元。`, '', '新增：' + (supplier.added.join('、') || '无'), '', '下线：' + (supplier.removed.join('、') || '无'), '', '| 模型 | 计费方式 | 上游公示积分（单位以计费方式为准） | ×2售价参考 |', '| --- | --- | --- | --- |');
    for (const m of supplier.models) {
      const raw = m.resolutionUnitCredits || { default: m.mode === 'per_second' ? m.pointsPerSecond : m.advertisedCredits };
      const prices = Object.entries(raw).map(([res, value]) => `${res}: ${value == null ? '待核对' : '¥' + (value / supplier.creditsPerCny * 2).toFixed(4)}`).join('；');
      lines.push(`| ${m.id} | ${m.mode} | ${JSON.stringify(raw)} | ${prices} |`);
    }
    lines.push('');
  }
  lines.push('## 价格冲突：禁止按表直接发布', '', '| 模型/档位 | 积分换算人民币 | 上游人民币字段 |', '| --- | --- | --- |');
  for (const conflict of report.priceConflicts) lines.push(`| ${conflict.model}/${conflict.resolution} | ¥${conflict.calculatedCny.toFixed(4)} | ¥${conflict.advertisedCny.toFixed(4)} |`);
  lines.push('', '价格为待验收建议，不是已发布价格；冲突模型必须以真实扣款或上游确认确定成本。参考素材附加费用、可选增强及供应商特殊计费须另行核对。');
  fs.writeFileSync(path.join(dir, 'catalog-review.md'), lines.join('\n'));
  console.log(JSON.stringify({ output: dir, suppliers: report.suppliers.map(({provider,count,added,removed}) => ({provider,count,added,removed})) }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
