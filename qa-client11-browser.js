async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4180')) throw new Error('Local QA origin required')
  const now = Math.floor(Date.now() / 1000)
  const user = { id: 12, username: 'qa_customer', display_name: 'PIKNO 客户验收', role: 1, status: 1, quota: 25000000 / 7.3, used_quota: 1000000 / 7.3, request_count: 20, group: 'default', permissions: { sidebar_settings: false } }
  const session = { sid: 'local-qa-session', current: true, login_method: 'password', ip: '127.0.0.1', user_agent: 'QA', created_at: now, last_active_at: now, expires_at: now + 3600 }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    let data
    switch (url.pathname) {
      case '/api/status': data = { system_name: 'PIKNO AI', logo: '/pikno-logo.png', version: 'client11-local-qa', quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7.3, price: 7.3, display_in_currency: true, HeaderNavModules: JSON.stringify({ home: true, console: true, pricing: { enabled: true, requireAuth: false }, docs: false }), SidebarModulesAdmin: JSON.stringify({ chat: { enabled: false } }), announcements_enabled: true, announcements: [] }; break
      case '/api/setup': data = { status: true }; break
      case '/api/notice': data = ''; break
      case '/api/user/auth/refresh': data = { access_token: 'local-qa-not-a-real-token', token_type: 'Bearer', access_expires_at: now + 3600, user, session }; break
      case '/api/user/self': data = user; break
      case '/api/pricing': return route.fulfill({ json: { success: true, data: [
        { id: 1, model_name: 'gpt-image-2.5-flare', description: 'PIKNO 图片生成 · 本地验收数据', model_ratio: 1, completion_ratio: 1, quota_type: 1, model_price: 0.1 / 7.3, enable_groups: ['default'], supported_endpoint_types: ['image-generation'] },
        { id: 2, model_name: 'sanbao/qa-video-480p', description: 'PIKNO 视频标准 480P · 本地验收数据', model_ratio: 1, completion_ratio: 1, quota_type: 1, model_price: 6 / 7.3, enable_groups: ['default'], supported_endpoint_types: ['openai-video'] }
      ], vendors: [], group_ratio: { default: 1 }, usable_group: { default: { desc: '默认分组', ratio: 1 } }, supported_endpoint: {}, auto_groups: [] } })
      case '/api/log/self': data = { items: [{ id: 1, user_id: 12, created_at: now, type: 2, content: '', model_name: 'gpt-image-2.5-flare', token_name: 'qa-key', quota: 50000 / 7.3, prompt_tokens: 0, completion_tokens: 0, use_time: 12, group: 'default', other: '{}' }], total: 1 }; break
      case '/api/log/self/stat': data = { quota: 50000 / 7.3, rpm: 0, tpm: 0 }; break
      case '/api/user/self/groups': data = { default: { desc: '默认分组', ratio: 1 } }; break
      case '/api/subscription/self': data = { subscriptions: [] }; break
      default: return route.fulfill({ status: 400, json: { success: false, message: 'Unmocked local QA endpoint' } })
    }
    return route.fulfill({ json: { success: true, data } })
  })
  await page.goto('http://127.0.0.1:4180/pricing')
}
