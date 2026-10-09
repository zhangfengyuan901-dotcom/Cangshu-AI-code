'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { build } = require('./cansee14-pricing.cjs');
const fixture = r => ({ defaults: { pointPricing: { pointsPerYuan: 100 }, videoProviders: [{ id: 'route', allowedResolutions: ['480p', '720p'], allowedDurations: [4, 5], ...r }] } });
test('per-second resolution pricing maps to CNY x2', () => {
  const r = build(fixture({ pricingMode: 'per_second', resolutionPointsPerSecond: { '480p': 19, '720p': 36 } })).routes[0];
  assert.deepEqual(r.prices.map(p => p.retailCNY), [0.38, 0.72]);
  assert.equal(r.prices[0].retailCNY*4, 1.52); assert.equal(r.enabled, false);
});
test('fixed price is per request, never multiplied by duration', () => {
  const r = build(fixture({ pricingMode: 'fixed', pointsCost: 388 })).routes[0];
  assert.ok(r.prices.every(p => p.unit === 'request' && p.retailCNY === 7.76));
});
test('ambiguous per-second resolutionPoints blocks pricing', () => {
  const r = build(fixture({ pricingMode: 'per_second', pointsPerSecond: 54, resolutionPoints: { '480p': 54, '720p': 104 } })).routes[0];
  assert.deepEqual(r.prices, []); assert.ok(r.blockedReasons.includes('ambiguous_resolution_price_unit'));
});
test('partial resolution maps cannot silently fall back to a cheaper price', () => {
  const r = build(fixture({ pricingMode: 'per_second', pointsPerSecond: 19, resolutionPointsPerSecond: { '480p': 19 } })).routes[0];
  assert.deepEqual(r.prices, []);
});
test('missing currency conversion, invalid points, and duplicates fail closed', () => {
  const h = fixture({ pricingMode: 'fixed', pointsCost: 388 }); delete h.defaults.pointPricing;
  assert.throws(() => build(h));
  for (const pointsCost of [-1, '388', NaN, Infinity]) assert.deepEqual(build(fixture({ pricingMode: 'fixed', pointsCost })).routes[0].prices, []);
  const dup = fixture({ pricingMode: 'fixed', pointsCost: 388 }); dup.defaults.videoProviders.push(dup.defaults.videoProviders[0]); assert.throws(() => build(dup));
});
test('surcharge and forced enhancement require explicit adaptation', () => {
  const h = fixture({ pricingMode: 'fixed', pointsCost: 388, videoReferenceSurchargeEnabled: true });
  assert.deepEqual(build(h).routes[0].prices, []);
  h.defaults.videoProviders[0].videoReferenceSurchargeEnabled = false; h.defaults.videoEnhance = { enabled: true, mode: 'force' };
  assert.deepEqual(build(h).routes[0].prices, []);
});
