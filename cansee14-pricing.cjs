'use strict';
// Draft only: this compiler never changes gateway options or enables routes.
const assert = require('node:assert/strict');
const rounded = n => Math.round(n * 1e6) / 1e6;
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e6;
function build(health) {
  const d = health.defaults, divisor = d?.pointPricing?.pointsPerYuan;
  assert.ok(valid(divisor) && divisor > 0, 'Missing points-per-yuan basis');
  assert.ok(Array.isArray(d.videoProviders) && d.videoProviders.length > 0);
  const seen = new Set();
  const routes = d.videoProviders.map(r => {
    assert.match(r.id, /^[a-zA-Z0-9_-]+$/); assert.ok(!seen.has(r.id)); seen.add(r.id);
    const row = { model: 'canseedream/video/' + r.id, label: r.label, enabled: false, acceptance: 'not_tested', prices: [], blockedReasons: [] };
    const seconds = r.pricingMode === 'per_second';
    if (!seconds && r.pricingMode !== 'fixed') row.blockedReasons.push('unknown_billing_mode');
    if (seconds && r.resolutionPoints != null && r.resolutionPointsPerSecond == null) row.blockedReasons.push('ambiguous_resolution_price_unit');
    if (r.videoReferenceSurchargeEnabled) row.blockedReasons.push('reference_surcharge_requires_usage_schema');
    if (d.videoEnhance?.enabled && d.videoEnhance.mode === 'force') row.blockedReasons.push('forced_enhancement_changes_cost');
    if (!Array.isArray(r.allowedResolutions) || !r.allowedResolutions.length) row.blockedReasons.push('missing_resolutions');
    const map = seconds ? r.resolutionPointsPerSecond : r.resolutionPoints;
    const fallback = seconds ? r.pointsPerSecond : r.pointsCost;
    for (const resolution of r.allowedResolutions || []) {
      const points = map == null ? fallback : map[resolution];
      if (!valid(points)) { row.blockedReasons.push('missing_or_invalid_price_' + resolution); continue; }
      row.prices.push({ resolution, unit: seconds ? 'second' : 'request', upstreamPoints: points, upstreamCNY: rounded(points/divisor), retailCNY: rounded(points/divisor*2) });
    }
    if (row.blockedReasons.length) row.prices = [];
    row.durations = r.allowedDurations || [r.durationSeconds];
    return row;
  });
  return { source: 'https://see.ximeiedu.org/health', multiplier: 2, pointsPerYuan: divisor, currency: 'CNY', draftOnly: true, imageGenerationIncluded: false, failureChargingPolicy: 'confirmed nonrefunded upstream cost x1; unknown receipts require review; not deployed', routes };
}
module.exports = { build };
if (require.main === module) (async () => {
  const fs = require('node:fs'), path = require('node:path');
  const r = await fetch('https://see.ximeiedu.org/health', { redirect: 'error', signal: AbortSignal.timeout(30000) }); assert.equal(r.status, 200);
  const plan = build(await r.json()); plan.fetchedAt = new Date().toISOString();
  fs.writeFileSync(path.join(__dirname, 'cansee14-pricing.draft.json'), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({ routes: plan.routes.length, priced: plan.routes.filter(r => !r.blockedReasons.length).length, blocked: plan.routes.filter(r => r.blockedReasons.length).map(r => ({ model: r.model, reasons: r.blockedReasons })) }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
