import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { isPiknoPackyImageChannel } from '../../lib/pikno-packy-check'
import { channelSchema } from '../../types'
import { ChannelsDialogs } from '../channels-dialogs'
import { ChannelsProvider, useChannels } from '../channels-provider'
import { PiknoPackyCheckDialog } from '../dialogs/pikno-packy-check-dialog'

const channel = channelSchema.parse({
  id: 1,
  type: 1,
  key: '',
  name: 'Packy image connection',
  status: 1,
  created_time: 1,
  test_time: 0,
  response_time: 0,
  balance_updated_time: 0,
  base_url: 'https://cf.api.fan',
  models: 'gpt-image-2,pikno-image-flare,old-model',
  model_mapping: '{"pikno-image-flare":"gpt-image-2"}',
})
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})

function view(overrides: Partial<typeof channel> = {}) {
  return (
    <QueryClientProvider client={client}>
      <PiknoPackyCheckDialog
        open
        channel={{ ...channel, ...overrides }}
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
}

test('a manual read-only check uses one catalogue GET and distinguishes mapping from generation', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValue({ data: { success: true, data: ['gpt-image-2'] } })
  const post = vi.spyOn(api, 'post')
  const put = vi.spyOn(api, 'put')
  const remove = vi.spyOn(api, 'delete')
  const user = userEvent.setup()
  render(view())
  expect(get).not.toHaveBeenCalled()
  expect(
    screen.queryByRole('button', { name: /Delete failed|Test all/ })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Run read-only check' }))
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Image generation is not yet verified.'
  )
  const publicRow = screen.getByRole('row', { name: /^pikno-image-flare/ })
  expect(within(publicRow).getByText('gpt-image-2')).toBeInTheDocument()
  expect(
    within(publicRow).getByText('Listed in catalogue; generation not verified')
  ).toBeInTheDocument()
  expect(
    screen.getByText('Not listed; confirm upstream availability')
  ).toBeInTheDocument()
  expect(get).toHaveBeenCalledTimes(1)
  expect(get.mock.calls[0][0]).toBe('/api/channel/fetch_models/1')
  expect(post).not.toHaveBeenCalled()
  expect(put).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})

test('pending check disables duplicate submissions and upstream errors stay safe and retryable', async () => {
  let finish!: (value: unknown) => void
  const get = vi.spyOn(api, 'get').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const user = userEvent.setup()
  render(view())
  await user.click(screen.getByRole('button', { name: 'Run read-only check' }))
  expect(
    screen.getByRole('button', { name: 'Checking connection...' })
  ).toBeDisabled()
  finish({
    data: { success: false, message: 'private-provider-detail sk-not-a-key' },
  })
  expect(
    await screen.findByText('Read-only check did not complete')
  ).toBeInTheDocument()
  expect(screen.queryByText(/sk-not-a-key/)).not.toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Run read-only check' })
  ).toBeEnabled()
  expect(get).toHaveBeenCalledTimes(1)
})

test('empty model lists remain a catalogue result and invalid mappings are shown separately', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: [] } })
  const user = userEvent.setup()
  render(
    view({
      models: 'alias',
      model_mapping: '{"alias":"other","other":"alias"}',
    })
  )
  await user.click(screen.getByRole('button', { name: 'Run read-only check' }))
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Image generation is not yet verified.'
  )
  expect(
    screen.getByText(
      'Invalid model mapping; review the connection configuration.'
    )
  ).toBeInTheDocument()
})

test('an empty connection has an explicit empty state', () => {
  render(view({ models: '' }))
  expect(
    screen.getByText('No models configured on this connection.')
  ).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})

test('the Packy route opens the read-only dialog instead of the legacy generation tester', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: [] } })
  function OpenCheck() {
    const { setCurrentRow, setOpen } = useChannels()
    return (
      <button
        type='button'
        onClick={() => {
          setCurrentRow(channel)
          setOpen('test-channel')
        }}
      >
        Open connection check
      </button>
    )
  }
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={client}>
      <ChannelsProvider>
        <OpenCheck />
        <ChannelsDialogs />
      </ChannelsProvider>
    </QueryClientProvider>
  )
  await user.click(
    screen.getByRole('button', { name: 'Open connection check' })
  )
  expect(
    await screen.findByRole('dialog', {
      name: 'PackyAPI read-only connection check',
    })
  ).toBeInTheDocument()
  expect(screen.queryByText('Endpoint type')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /Test all/ })
  ).not.toBeInTheDocument()
})

test('unrelated providers and misleading host suffixes retain their normal test flow', () => {
  expect(isPiknoPackyImageChannel(channel)).toBe(true)
  expect(
    isPiknoPackyImageChannel({
      ...channel,
      base_url: 'https://cf.api.fan.other.example',
    })
  ).toBe(false)
  expect(isPiknoPackyImageChannel({ ...channel, type: 99 })).toBe(false)
  expect(isPiknoPackyImageChannel(null)).toBe(false)
})
