/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { LineManagement } from '..'
import type { LineAdminResponse, LineConfig, LineRecord, LineSyncStatus } from '../types'

let client: QueryClient

function lineRecord(ready: boolean): LineRecord {
  return {
    public_model: 'pikno-video-cs-example',
    version: 7,
    draft: {
      public_model: 'pikno-video-cs-example',
      source_id: 'canseedream/example',
      name: 'Example video',
      kind: 'video',
      provider: 'canseedream',
      upstream_model: 'canseedream/example',
      plugin_key: 'pikno-canseedream',
      channel_id: ready ? 12 : 0,
      enabled: true,
      upstream_available: true,
      resolutions: ['480p'],
      ratios: ['16:9'],
      durations: [4, 8],
      max_images: 5,
      max_videos: 1,
      max_audio: 0,
      prices: [
        {
          resolution: '480p',
          unit: 'second',
          cost_cny: 0.72,
          suggested_cny: 1.44,
          retail_quota: 1_440_000,
        },
      ],
      price_issue: false,
      reference_surcharge_quota: 0,
      fetched_at: '2026-10-10T00:00:00Z',
      revision: 4,
    },
    published: null,
    previous: null,
    can_publish: ready,
    blocking_reasons: ready ? [] : ['channel is not configured'],
    updated_at: 1,
    updated_by: 1,
  }
}

function response(line: LineRecord): LineAdminResponse {
  return { success: true, data: { lines: [line] } }
}

it('keeps retired Sanbao drafts in read-only history even if the server marks them publishable', async () => {
  const line = lineRecord(true)
  line.draft!.provider = 'sanbao'
  line.draft!.enabled = false
  line.previous = { ...line.draft!, enabled: true }
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const post = vi.spyOn(api, 'post')
  mount()
  await screen.findByRole('button', { name: /已下架.*1/ })
  expect(screen.queryByText('Example video')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: /已下架.*1/ }))
  expect(await screen.findByText('Example video')).toBeVisible()
  expect(screen.getByText('三宝线路已下架，仅保留历史配置。')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  expect(screen.queryByRole('button', { name: '开放线路' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Rollback' })).toBeNull()
  expect(post).not.toHaveBeenCalled()
})

function draftConfig(line: LineRecord): LineConfig {
  if (!line.draft) throw new Error('Test fixture requires a draft')
  return line.draft
}

function mount() {
  const router = createRouter({
    routeTree: createRootRoute({ component: LineManagement }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
})

afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('shows publication blockers and prevents publication', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(lineRecord(false)) })
  mount()

  expect(await screen.findByText('channel is not configured')).toBeVisible()
  expect(screen.getByRole('button', { name: '开放线路' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Check configuration' })).toBeNull()
})

it('confirms publication with the exact optimistic-lock version', async () => {
  const line = lineRecord(true)
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: line },
  })
  const user = userEvent.setup()
  mount()

  await user.click(await screen.findByRole('button', { name: '开放线路' }))
  expect(post).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Confirm operation' }))

  await waitFor(() =>
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/api/pikno/lines/admin/publish',
      { public_model: line.public_model, expected_version: 7 }
    )
  )
})

it('an open line without a draft has no false publication failure or draft actions', async () => {
  const line = lineRecord(true)
  line.published = line.draft
  line.previous = line.draft
  line.draft = null
  line.can_publish = false
  line.blocking_reasons = ['缺少线路草稿']
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  mount()

  expect(await screen.findByText('已开放，无待生效更改')).toBeVisible()
  expect(screen.getByText('已开放', { exact: true })).toBeVisible()
  expect(screen.queryByText('缺少线路草稿')).toBeNull()
  expect(screen.queryByText('Cannot publish')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Check configuration' })).toBeNull()
  expect(screen.queryByRole('button', { name: /开放线路|应用更改|Publish line/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Disable line' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Rollback' })).toBeEnabled()
})

it('a synchronization pause takes priority over the stored open publication', async () => {
  const line = lineRecord(true)
  line.published = line.draft
  line.draft = null
  line.sync = {
    snapshot_hash: '', last_seen_at: 0, missing_count: 0,
    paused: true, pause_reason: 'adapter_invalid', cost_changed: false,
    cost_changed_at: 0, adapter_issue: 'protocol_not_supported', price_issue: false,
  } satisfies LineSyncStatus
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  mount()

  expect(await screen.findByText('已暂停', { exact: true })).toBeVisible()
  expect(screen.queryByText('已开放', { exact: true })).toBeNull()
  expect(screen.queryByText('已开放，无待生效更改')).toBeNull()
  expect(screen.getByText(/已暂停新任务.*已提交任务继续查询原结果/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Disable line' })).toBeEnabled()
})

it('an operator choosing not to open a draft is a neutral state, not a fault', async () => {
  const line = lineRecord(true)
  draftConfig(line).enabled = false
  line.can_publish = false
  line.blocking_reasons = ['尚未勾选开放线路']
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  mount()

  expect(await screen.findByText('未开放', { exact: true })).toBeVisible()
  expect(screen.queryByText('Cannot publish')).toBeNull()
  expect(screen.queryByText('尚未勾选开放线路')).toBeNull()
  expect(screen.getByRole('button', { name: '开放线路' })).toBeDisabled()
})

it('a capable unopened draft requires an explicit open confirmation', async () => {
  const line = lineRecord(true)
  draftConfig(line).enabled = false
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const post = vi.spyOn(api, 'post')
  mount()

  expect(await screen.findByRole('button', { name: '开放线路' })).toBeEnabled()
  expect(post).not.toHaveBeenCalled()
})

it('a closed published line can reopen without fabricating a new draft', async () => {
  const line = lineRecord(true)
  line.published = { ...draftConfig(line), enabled: false }
  line.draft = null
  line.has_pending_changes = false
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { success: true, data: line } })
  const user = userEvent.setup()
  mount()

  await user.click(await screen.findByRole('button', { name: '已下架 (1)' }))
  await user.click(await screen.findByRole('button', { name: '开放线路' }))
  expect(post).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Check configuration' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Confirm operation' }))
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith(
    '/api/pikno/lines/admin/publish',
    { public_model: line.public_model, expected_version: 7 }
  ))
})

it('a closed line without a draft still explains genuine publication blockers', async () => {
  const line = lineRecord(true)
  line.published = { ...draftConfig(line), enabled: false }
  line.draft = null
  line.has_pending_changes = false
  line.can_publish = false
  line.blocking_reasons = ['缺少线路草稿', '上游价格或计费单位需要核对']
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const user = userEvent.setup()
  mount()

  await user.click(await screen.findByRole('button', { name: '已下架 (1)' }))
  expect(await screen.findByText('上游价格或计费单位需要核对')).toBeVisible()
  expect(screen.queryByText('缺少线路草稿')).toBeNull()
  expect(screen.getByRole('button', { name: '开放线路' })).toBeDisabled()
})

it('a semantically unchanged draft does not add redundant actions to an open line', async () => {
  const line = lineRecord(true)
  line.published = line.draft
  line.has_pending_changes = false
  line.can_publish = false
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  mount()

  expect(await screen.findByText('已开放，无待生效更改')).toBeVisible()
  expect(screen.queryByRole('button', { name: '应用更改' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Check configuration' })).toBeNull()
})

it('a genuine pricing problem remains visible for an unopened draft', async () => {
  const line = lineRecord(true)
  draftConfig(line).enabled = false
  line.can_publish = false
  line.blocking_reasons = ['尚未勾选开放线路', '上游价格或计费单位需要核对']
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  mount()

  expect(await screen.findByText('上游价格或计费单位需要核对')).toBeVisible()
  expect(screen.getByText('Cannot publish')).toBeVisible()
  expect(screen.queryByText('尚未勾选开放线路')).toBeNull()
  expect(screen.getByRole('button', { name: '开放线路' })).toBeDisabled()
})

it('missing upstream cost warns while an explicit unit and customer price can still open', async () => {
  const line = lineRecord(true)
  const config = draftConfig(line)
  config.billing_unit = 'second'
  config.cost_issue_code = 'missing_cost'
  config.prices[0].cost_cny = undefined
  config.prices[0].suggested_cny = 0
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const post = vi.spyOn(api, 'post')
  const user = userEvent.setup()
  mount()

  expect(await screen.findByText('成本提醒：上游未提供成本。客户售价保持不变。')).toBeVisible()
  expect(screen.getByRole('button', { name: '开放线路' })).toBeEnabled()
  expect(screen.queryByText('已暂停', { exact: true })).toBeNull()
  expect(screen.getByText('计费单位：每秒')).toBeVisible()
  expect(screen.getByText('¥1.44 / 每秒')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  expect(screen.getByText('成本待核对')).toBeVisible()
  expect(screen.queryByText(/Recommended|Upstream cost: ¥0/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled()
  expect(post).not.toHaveBeenCalled()
})

it('an explicitly known zero cost is distinct from missing cost', async () => {
  const line = lineRecord(true)
  draftConfig(line).prices[0].cost_cny = 0
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const user = userEvent.setup()
  mount()

  await user.click(await screen.findByRole('button', { name: 'Edit' }))
  expect(screen.getByText('Upstream cost: ¥0 / 每秒')).toBeVisible()
  expect(screen.queryByText('成本待核对')).toBeNull()
})

it('an unknown declared billing unit is never inferred from an old price row', async () => {
  const line = lineRecord(true)
  const config = draftConfig(line)
  config.billing_unit = ''
  config.billing_issue_code = 'unknown_billing_unit'
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const user = userEvent.setup()
  mount()

  expect(await screen.findByText('计费单位：单位待核对')).toBeVisible()
  expect(screen.getByText('上游未声明计费单位，暂不能开放。')).toBeVisible()
  expect(screen.getByRole('button', { name: '开放线路' })).toBeDisabled()
  expect(screen.queryByText('¥1.44 / 每秒')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
})

it('retained operator prices cannot imply a current unit when the missing global unit was omitted', async () => {
  const line = lineRecord(true)
  const config = draftConfig(line)
  config.billing_unit = undefined
  config.billing_issue_code = 'unknown_billing_unit'
  config.prices[0].cost_cny = undefined
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const user = userEvent.setup()
  mount()

  expect(await screen.findByText('计费单位：单位待核对')).toBeVisible()
  expect(screen.getByText('¥1.44 / 单位待核对')).toBeVisible()
  expect(document.body.textContent).not.toContain('每秒')
  expect(screen.getByRole('button', { name: '开放线路' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Edit' }))
  expect(document.body.textContent).not.toContain('每秒')
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
})

it('adapter failures use safe protocol guidance instead of exposing the static model-list error', async () => {
  const line = lineRecord(false)
  line.blocking_reasons = ['任务适配器未声明该上游模型']
  line.sync = {
    snapshot_hash: '', last_seen_at: 0, missing_count: 0, paused: false,
    pause_reason: '', cost_changed: false, cost_changed_at: 0,
    adapter_issue: 'private-adapter-code', price_issue: false,
  }
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  mount()

  expect((await screen.findAllByText(/上游任务协议需要核对/)).length).toBeGreaterThan(0)
  expect(document.body.textContent).not.toMatch(/private-adapter-code|任务适配器未声明/)
  expect(screen.getByRole('button', { name: '开放线路' })).toBeDisabled()
})

it('an existing open line applies draft changes with the exact expected version', async () => {
  const line = lineRecord(true)
  line.published = { ...draftConfig(line), revision: 3 }
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: line },
  })
  const user = userEvent.setup()
  mount()

  await user.click(await screen.findByRole('button', { name: '应用更改' }))
  expect(post).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Confirm operation' }))
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith(
    '/api/pikno/lines/admin/publish',
    { public_model: line.public_model, expected_version: 7 }
  ))
})

it('converts an exact six-decimal CNY price to integer quota', async () => {
  const line = lineRecord(true)
  vi.spyOn(api, 'get').mockResolvedValue({ data: response(line) })
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({
    data: { success: true, data: line },
  })
  const user = userEvent.setup()
  mount()

  await user.click(await screen.findByRole('button', { name: 'Edit' }))
  expect(screen.queryByRole('switch')).toBeNull()
  const price = screen.getByRole('textbox', { name: 'Customer price (CNY)' })
  await user.clear(price)
  await user.type(price, '0.123456')
  await user.click(screen.getByRole('button', { name: 'Save draft' }))

  await waitFor(() =>
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      '/api/pikno/lines/admin',
      expect.objectContaining({
        public_model: line.public_model,
        expected_version: 7,
        prices: [{ resolution: '480p', unit: 'second', retail_quota: 123_456 }],
      })
    )
  )
  expect(patch.mock.calls[0]?.[1]).not.toHaveProperty('enabled')
})

it('hides removed publications by default while drafts and repairable faults stay manageable', async () => {
  const draft = lineRecord(true)
  draft.public_model = 'new-draft'
  draftConfig(draft).name = 'New draft remains visible'
  const archived = lineRecord(true)
  archived.public_model = 'removed-publication'
  archived.published = { ...draftConfig(archived), name: 'Removed old publication' }
  archived.draft = null
  archived.sync = {
    snapshot_hash: '', last_seen_at: 0, missing_count: 3, paused: true,
    pause_reason: 'missing', cost_changed: false, cost_changed_at: 0,
    adapter_issue: '', price_issue: false,
  }
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: { lines: [draft, archived] } } })
  const user = userEvent.setup()
  mount()

  expect(await screen.findByText('New draft remains visible')).toBeVisible()
  expect(screen.getByRole('button', { name: '可管理 (1)' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByText('Removed old publication')).toBeNull()
  await user.click(screen.getByRole('button', { name: '已下架 (1)' }))
  expect(screen.getByText('Removed old publication')).toBeVisible()
  expect(screen.queryByText('New draft remains visible')).toBeNull()
  await user.click(screen.getByRole('button', { name: '全部 (2)' }))
  expect(screen.getByText('New draft remains visible')).toBeVisible()
  expect(screen.getByText('Removed old publication')).toBeVisible()
})

it('catalog push refreshes the list without replacing an open editor or its optimistic version', async () => {
  class FakeEventSource extends EventTarget {
    static instances: FakeEventSource[] = []
    close = vi.fn()
    constructor(readonly url: string) {
      super()
      FakeEventSource.instances.push(this)
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const original = lineRecord(true)
  const next = structuredClone(original)
  next.version = 8
  draftConfig(next).name = 'Updated upstream list'
  const get = vi.spyOn(api, 'get').mockResolvedValueOnce({ data: response(original) }).mockResolvedValue({ data: response(next) })
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: { success: true, data: original } })
  const user = userEvent.setup()
  mount()

  await user.click(await screen.findByRole('button', { name: 'Edit' }))
  const editor = within(screen.getByRole('dialog'))
  const name = editor.getByRole('textbox', { name: 'Display name' })
  await user.clear(name)
  await user.type(name, 'Unsaved operator name')
  const source = FakeEventSource.instances[0]
  expect(source?.url).toBe('/api/pikno/catalog/events')
  source?.dispatchEvent(new MessageEvent('catalog-change', { data: '{"revision":"new-snapshot"}' }))
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  expect(await screen.findByText('Updated upstream list')).toBeInTheDocument()
  expect(name).toHaveValue('Unsaved operator name')
  await user.click(editor.getByRole('button', { name: 'Save draft' }))
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/pikno/lines/admin', expect.objectContaining({ expected_version: 7, name: 'Unsaved operator name' })))
})

it('archives an upstream-disabled draft without hiding an ordinary unpublished draft', async () => {
  const draft = lineRecord(true)
  draftConfig(draft).name = 'Ordinary unpublished draft'
  const disabled = structuredClone(draft)
  disabled.public_model = 'upstream-disabled-draft'
  draftConfig(disabled).name = 'Disabled upstream draft'
  disabled.sync = {
    snapshot_hash: '', last_seen_at: 0, missing_count: 0, paused: true,
    pause_reason: 'disabled', cost_changed: false, cost_changed_at: 0,
    adapter_issue: '', price_issue: false,
  }
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: { lines: [draft, disabled] } } })
  const user = userEvent.setup()
  mount()
  expect(await screen.findByText('Ordinary unpublished draft')).toBeVisible()
  expect(screen.queryByText('Disabled upstream draft')).toBeNull()
  await user.click(screen.getByRole('button', { name: '已下架 (1)' }))
  expect(screen.getByText('Disabled upstream draft')).toBeVisible()
  expect(screen.queryByText('Ordinary unpublished draft')).toBeNull()
})
