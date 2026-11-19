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
export type LineKind = 'image' | 'video'
export type LinePriceUnit = 'request' | 'second' | 'image'

export interface LinePrice {
  resolution: string
  unit: LinePriceUnit
  cost_cny?: number
  suggested_cny: number
  retail_quota: number
}

export interface LineConfig {
  public_model: string
  source_id: string
  name: string
  kind: LineKind
  provider: 'packy' | 'sanbao' | 'canseedream'
  upstream_model: string
  plugin_key?: string
  channel_id: number
  enabled: boolean
  upstream_available: boolean
  resolutions: string[]
  ratios: string[]
  durations: number[]
  max_images: number
  max_videos: number
  max_audio: number
  prices: LinePrice[]
  price_issue: boolean
  billing_unit?: string
  cost_issue_code?: string
  billing_issue_code?: string
  reference_surcharge_quota: number
  fetched_at: string
  revision: number
}

export interface LineRecord {
  public_model: string
  version: number
  draft: LineConfig | null
  published: LineConfig | null
  previous: LineConfig | null
  can_publish: boolean
  has_pending_changes?: boolean
  blocking_reasons: string[]
  updated_at: number
  updated_by: number
  sync?: LineSyncStatus | null
}

export interface LineSyncStatus {
  snapshot_hash: string
  last_seen_at: number
  missing_count: number
  paused: boolean
  pause_reason: string
  cost_changed: boolean
  cost_changed_at: number
  adapter_issue: string
  price_issue: boolean
  billing_unit?: string
  cost_issue_code?: string
  billing_issue_code?: string
}

export interface ProviderSyncStatus {
  provider: 'sanbao' | 'canseedream'
  state: 'ready' | 'error' | 'stale' | 'syncing'
  snapshot_hash: string
  last_attempt_at: number
  last_verified_at: number
  next_attempt_at: number
  error_code: string
}

export interface LineSyncOverview {
  enabled: boolean
  interval_seconds: number
  missing_threshold: number
  stale_seconds: number
  providers: ProviderSyncStatus[]
}

export interface LineAdminResponse {
  success: boolean
  data: { lines: LineRecord[]; sync?: LineSyncOverview | null }
  message?: string
}

export interface LineMutationResponse {
  success: boolean
  data: LineRecord
  message?: string
}

export interface LineDraftUpdate {
  public_model: string
  expected_version: number
  name: string
  enabled?: boolean
  prices: Pick<LinePrice, 'resolution' | 'unit' | 'retail_quota'>[]
}
