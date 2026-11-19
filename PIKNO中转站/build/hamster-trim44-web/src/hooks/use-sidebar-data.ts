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
import {
  Activity, ClipboardList, FileText, Key, ListTodo, Radio,
  ShieldCheck, User, Users, Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { SidebarData } from '@/components/layout/types'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

// Fixed operator navigation. Customer account operations use the separate H5 page.
export function useSidebarData(): SidebarData {
  const { t } = useTranslation()
  const role = useAuthStore((state) => state.auth.user?.role) ?? ROLE.GUEST
  if (role < ROLE.ADMIN) {
    return {
      navGroups: [{
        id: 'account',
        title: '账户',
        items: [
          { title: '余额', url: '/account-lite/index.html', icon: Wallet },
          { title: '消费记录', url: '/account-lite/index.html?tab=usage', icon: FileText },
          { title: '充值', url: '/account-lite/index.html?tab=topup', icon: Wallet },
          { title: 'API Key', url: '/account-lite/index.html?tab=keys', icon: Key },
        ],
      }],
    }
  }
  return {
    navGroups: [
      {
        id: 'users', title: '用户与权限',
        items: [
          { title: t('Users'), url: '/users', icon: Users, requiredRole: ROLE.ADMIN },
          { title: t('Profile'), url: '/profile', icon: User },
          { title: t('Security & Access'), url: '/security', icon: ShieldCheck },
        ],
      },
      {
        id: 'channels', title: '渠道与线路',
        items: [
          { title: '上游管理', url: '/channels', icon: Radio, requiredRole: ROLE.ADMIN },
          { title: t('Line management'), url: '/line-management', icon: Radio, requiredRole: ROLE.SUPER_ADMIN },
          { title: t('Task plugins'), url: '/task-plugins', icon: ListTodo, requiredRole: ROLE.ADMIN },
        ],
      },
      {
        id: 'pricing', title: '定价与分组',
        items: [
          { title: '目录与上架', url: '/catalog-admin', icon: ClipboardList, requiredRole: ROLE.SUPER_ADMIN },
          { title: '模型定价', url: '/system-settings/billing/model-pricing', icon: Wallet, requiredRole: ROLE.SUPER_ADMIN },
        ],
      },
      {
        id: 'settlement', title: '充值与结算',
        items: [
          { title: t('Overview'), url: '/dashboard/overview', icon: Activity },
          { title: '我的账户', url: '/account-lite/index.html', icon: Wallet },
          { title: t('Settlement review'), url: '/settlement-admin', icon: ClipboardList, configUrls: ['/users'], requiredRole: ROLE.SUPER_ADMIN },
        ],
      },
      {
        id: 'logs', title: '日志与基础安全',
        items: [
          { title: t('Usage Logs'), url: '/usage-logs/common', icon: FileText },
          { title: t('Audit Logs'), url: '/usage-logs/audit', icon: ClipboardList },
          { title: t('Task Logs'), url: '/usage-logs/task', activeUrls: ['/usage-logs/drawing'], configUrls: ['/usage-logs/drawing', '/usage-logs/task'], icon: ListTodo },
          { title: '基础设置', url: '/system-settings', icon: ShieldCheck, requiredRole: ROLE.SUPER_ADMIN },
        ],
      },
    ],
  }
}
