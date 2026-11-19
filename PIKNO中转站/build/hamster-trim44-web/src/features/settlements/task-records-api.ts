import type { TaskLog } from '@/features/usage-logs/types'
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

// Synchronous HTTP image responses are not persisted as task artifacts.
// Never infer a relation from a model name or a timestamp.
export async function getOrderTask(orderId: string): Promise<TaskLog | null> {
  if (orderId.startsWith('req_')) return null
  const response = requireServerSuccess(
    (
      await api.get<{
        success: boolean
        message?: string
        data: { items: TaskLog[]; total: number }
      }>('/api/task/self', {
        params: { task_id: orderId, p: 1, page_size: 2 },
      })
    ).data
  )
  // Duplicate identifiers or old, unlinked rows must not show a guessed result.
  if (response.data.total !== 1 || response.data.items.length !== 1) return null
  const task = response.data.items[0]
  return task.task_id === orderId ? task : null
}
