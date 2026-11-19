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
import { CreditCard } from 'lucide-react'
import { SiAlipay, SiWechat, SiStripe, SiPaypal } from 'react-icons/si'
import type { IconBaseProps, IconType } from 'react-icons'

// Payment configuration can select these bundled icons, never an entire icon pack.
const PAYMENT_ICONS: Record<string, IconType> = {
  SiAlipay, FaAlipay: SiAlipay, RiAlipayFill: SiAlipay,
  SiWechat, FaWeixin: SiWechat,
  SiStripe, FaStripe: SiStripe,
  SiPaypal, FaPaypal: SiPaypal,
}
type ReactIconByNameProps = IconBaseProps & { name?: string | null }
export function ReactIconByName({ name, ...props }: ReactIconByNameProps) {
  const value = name?.trim()
  if (!value) return null
  if (value === 'LuCreditCard' || value === 'FaCreditCard') return <CreditCard {...props} />
  const Icon = Object.hasOwn(PAYMENT_ICONS, value) ? PAYMENT_ICONS[value] : null
  return Icon ? <Icon {...props} /> : <CreditCard {...props} />
}
