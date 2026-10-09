async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4180')) throw new Error('Local QA origin required')
  const base = { kind: 'video', upstream_available: true, resolutions: ['480p', '720p'], ratios: ['16:9', '9:16'], durations: [4, 8], max_images: 5, max_videos: 1, max_audio: 1, prices: [{ resolution: '480p', unit: 'second', retail_cny: 0.38 }, { resolution: '720p', unit: 'second', retail_cny: 0.72 }], price_issue: false, reference_surcharge_cny: 0.6 }
  const models = [
    { ...base, id: 'gpt-image-2.5-flare', name: 'Flare', provider: 'packy', kind: 'image', prices: [{ resolution: 'default', unit: 'image', retail_cny: 0.1 }], reference_surcharge_cny: 0 },
    { ...base, id: 'canseedream/video/nanguar', name: 'CanSeeDream 待核价测试线路', provider: 'canseedream', prices: [], price_issue: true },
    ...Array.from({ length: 13 }, (_, index) => ({ ...base, id: `sanbao/qa-${index}`, name: `PIKNO 视频参数验收线路 ${index + 1}`, provider: 'sanbao', upstream_available: index !== 12 })),
  ]
  const snapshot = { revision: 'qa-catalog', fetched_at: '2026-10-08T14:00:00Z', models }
  const adminModels = models.map((model) => ({ ...model, prices: model.prices.map((price) => ({ ...price, cost_cny: price.retail_cny / 2 })) }))
  let state = { revision: 'qa-draft-state', published: snapshot, draft: { ...snapshot, revision: 'qa-draft', models: adminModels }, previous: snapshot, events: [] }
  await page.route('**/api/pikno/catalog**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/pikno/catalog') return route.fulfill({ json: { success: true, data: snapshot } })
    if (path.endsWith('/publish')) state = { ...state, revision: 'qa-published-state', published: state.draft, draft: null }
    if (path.endsWith('/rollback')) state = { ...state, revision: 'qa-rollback-state', published: state.previous, draft: null }
    return route.fulfill({ json: { success: true, data: state, changes: state.draft ? [{ id: models[2].id, kind: 'changed', before: { ...adminModels[2], prices: [{ resolution: '480p', unit: 'second', retail_cny: 0.3, cost_cny: 0.15 }] }, after: adminModels[2] }] : [] } })
  })
  await page.goto('http://127.0.0.1:4180/pricing')
}
