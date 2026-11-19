import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

import type { CatalogAdminResponse, CatalogSnapshot } from './types'

export async function getCatalog(signal?: AbortSignal): Promise<CatalogSnapshot> {
  const response = requireServerSuccess(
    (
      await api.get<{ success: boolean; data: CatalogSnapshot }>(
        '/api/pikno/catalog',
        { timeout: 10_000, signal, skipAuthRefresh: true, skipErrorHandler: true }
      )
    ).data
  )
  return response.data
}
export async function getCatalogAdmin(): Promise<CatalogAdminResponse> {
  return requireServerSuccess(
    (await api.get<CatalogAdminResponse>('/api/pikno/catalog/admin')).data
  )
}
export async function changeCatalog(
  action: 'sync' | 'publish' | 'rollback',
  revision: string
): Promise<CatalogAdminResponse> {
  return requireServerSuccess(
    (
      await api.post<CatalogAdminResponse>(
        `/api/pikno/catalog/admin/${action}`,
        { revision },
        { timeout: 50000 }
      )
    ).data
  )
}
