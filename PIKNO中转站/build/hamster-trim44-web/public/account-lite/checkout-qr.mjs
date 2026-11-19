import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { QRCodeCanvas } from 'qrcode.react'

export function renderCheckoutQr(container, payload) {
  const root = createRoot(container)
  flushSync(() => root.render(createElement(QRCodeCanvas, {
    value: payload,
    size: 232,
    marginSize: 4,
    role: 'img',
    'aria-label': '付款二维码',
  })))
  return () => root.unmount()
}
