async (page) => {
  // Local QA only. These synthetic responses never touch production or upstreams.
  if (!page.url().startsWith('http://127.0.0.1:4180')) throw new Error('Local QA origin required')
  const user = { id: 12, username: 'qa_customer', display_name: 'PIKNO 客户验收', role: 1, status: 1, quota: 25000000 / 7.3, used_quota: 1000000 / 7.3, request_count: 20, group: 'default', permissions: { sidebar_settings: false }, aff_quota: 0, aff_count: 0, aff_history_quota: 0 }
  const now = Math.floor(Date.now() / 1000)
  const session = { sid: 'local-qa-session', current: true, login_method: 'password', ip: '127.0.0.1', user_agent: 'QA', created_at: now, last_active_at: now, expires_at: now + 3600 }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    let data
    switch (url.pathname) {
      case '/api/status': data = { system_name: 'PIKNO AI', logo: '/pikno-logo.png', version: 'client10-local-qa', quota_display_type: 'CNY', quota_per_unit: 500000, usd_exchange_rate: 7.3, price: 7.3, display_in_currency: true, HeaderNavModules: JSON.stringify({ home: true, console: true, pricing: { enabled: true, requireAuth: false }, rankings: { enabled: true }, docs: false }), SidebarModulesAdmin: JSON.stringify({ chat: { enabled: false } }), announcements_enabled: true, announcements: [], api_info_enabled: false, faq_enabled: false, uptime_kuma_enabled: false }; break
      case '/api/setup': data = { status: true }; break
      case '/api/notice': data = ''; break
      case '/api/user/auth/refresh': data = { access_token: 'local-qa-not-a-real-token', token_type: 'Bearer', access_expires_at: now + 3600, user, session }; break
      case '/api/user/self': data = user; break
      case '/api/user/topup/info': data = { fixed_cny_topup: true, enable_online_topup: true, enable_redemption: false, min_topup: 50, amount_options: [50, 100, 200], discount: {}, pay_methods: [{ type: 'alipay', name: '支付宝' }, { type: 'wxpay', name: '微信支付' }] }; break
      case '/api/user/amount': data = String(route.request().postDataJSON().amount); break
      case '/api/user/topup/self': data = { items: [], total: 0 }; break
      default: return route.fulfill({ status: 400, json: { success: false, message: 'Unmocked local QA endpoint' } })
    }
    return route.fulfill({ json: { success: true, data } })
  })
  await page.goto('http://127.0.0.1:4180/dashboard/overview')
}
