import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

export type Settlement = {
  order_id: string
  model: string
  created_at: number
  generation_state: string
  financial_state: string
  reserved_quota: number
  net_quota: number
  refunded_quota: number
  version: number
  review_required: boolean
}
export type AdminSettlement = Settlement & {
  user_id: number
  price_mode: string
  quote_quota: number
  image_usage_quota?: number
  account_ref: string
  upstream_task_id: string
  net_cost_quota: number
  charged_quota: number
  upstream_refunded_quota: number
  review_reason: string
  review_due_at: number
}
export type LedgerEvent = {
  id: number
  action: string
  wallet_delta: number
  net_quota: number
  reserved_quota: number
  financial_state: string
  created_at: number
  reason?: string
  evidence?: string
}
export type ReviewCommand = {
  operation_id: string
  version: number
  action: 'success' | 'failure' | 'waive' | 'refund' | 'acknowledge'
  reason: string
  images: number
  evidence_ref: string
  upstream_task_id: string
  charged_quota: number
  refunded_quota: number
  fixed_refund_quota: number
}
export type ReviewPreview = {
  order_id: string
  version: number
  digest: string
  before_reserved: number
  before_net: number
  after_reserved: number
  after_net: number
  wallet_delta: number
  state: string
  review_required: boolean
}
type Envelope<T> = { success: boolean; message?: string; data: T }
export async function getSettlements(
  admin: boolean,
  page: number,
  review: boolean
) {
  return requireServerSuccess(
    (
      await api.get<
        Envelope<{ items: (Settlement | AdminSettlement)[]; total: number }>
      >(`/api/pikno/settlements/${admin ? 'admin' : 'self'}`, {
        params: { page, review },
      })
    ).data
  ).data
}
export async function getSettlement(admin: boolean, id: string) {
  return requireServerSuccess(
    (
      await api.get<
        Envelope<{ order: Settlement | AdminSettlement; events: LedgerEvent[] }>
      >(
        `/api/pikno/settlements/${admin ? 'admin' : 'self'}/${encodeURIComponent(id)}`
      )
    ).data
  ).data
}
export async function previewSettlement(id: string, command: ReviewCommand) {
  return requireServerSuccess(
    (
      await api.post<Envelope<ReviewPreview>>(
        `/api/pikno/settlements/admin/${encodeURIComponent(id)}/preview`,
        command
      )
    ).data
  ).data
}
export async function applySettlement(
  id: string,
  command: ReviewCommand,
  proof: string
) {
  return requireServerSuccess(
    (
      await api.post<Envelope<LedgerEvent>>(
        `/api/pikno/settlements/admin/${encodeURIComponent(id)}/apply`,
        command,
        { headers: { 'X-Security-Proof': proof } }
      )
    ).data
  ).data
}
