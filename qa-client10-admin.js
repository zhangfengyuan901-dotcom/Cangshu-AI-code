async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4180')) throw new Error('Local QA origin required')
  const now = Math.floor(Date.now() / 1000)
  const user = { id: 1, username: 'qa_admin', role: 100, status: 1, permissions: { sidebar_settings: false } }
  const session = { sid: 'local-admin-qa', current: true, login_method: 'password', ip: '127.0.0.1', user_agent: 'QA', created_at: now, last_active_at: now, expires_at: now + 3600 }
  await page.route('**/api/user/auth/refresh', (route) => route.fulfill({ json: { success: true, data: { access_token: 'local-admin-not-real-token', token_type: 'Bearer', access_expires_at: now + 3600, user, session } } }))
  await page.goto('http://127.0.0.1:4180/developer')
}
