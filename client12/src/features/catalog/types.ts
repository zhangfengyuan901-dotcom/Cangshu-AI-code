export interface CatalogPrice {
  resolution: string
  unit: 'request' | 'second' | 'image'
  retail_cny: number
  cost_cny?: number
}
export interface CatalogModel {
  id: string
  name: string
  provider: 'sanbao' | 'canseedream' | 'packy'
  kind: 'video' | 'image'
  upstream_available: boolean
  resolutions: string[]
  ratios: string[]
  durations: number[]
  max_images: number
  max_videos: number
  max_audio: number
  prices: CatalogPrice[]
  price_issue: boolean
  reference_surcharge_cny: number
}
export interface CatalogSnapshot {
  revision: string
  fetched_at: string
  models: CatalogModel[]
}
export interface CatalogState {
  revision: string
  published: CatalogSnapshot | null
  draft: CatalogSnapshot | null
  previous: CatalogSnapshot | null
  events: { at: string; actor: number; action: string; revision: string }[]
}
export interface CatalogChange {
  id: string
  kind: 'added' | 'changed' | 'removed'
  before?: CatalogModel
  after?: CatalogModel
}
export interface CatalogAdminResponse {
  success: boolean
  data: CatalogState
  changes: CatalogChange[]
  message?: string
}
