import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] || '/build/source');
const webRoot = resolve(process.argv[3] || resolve(root, 'web'));
async function edit(path, transform) {
  const full = path.startsWith('web/') ? resolve(webRoot, path.slice(4)) : resolve(root, path);
  const before = (await readFile(full, 'utf8')).replaceAll('\r\n', '\n');
  await writeFile(full, transform(before));
}
function replace(source, from, to) {
  if (!source.includes(from)) throw new Error(`Missing patch anchor: ${from.slice(0, 100)}`);
  return source.replace(from, to);
}
function section(source, from, to, value) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`Missing section: ${from}`);
  return source.slice(0, start) + value + source.slice(end);
}

await edit('controller/topup.go', (s) => {
  s = replace(s, '\tcommon.ApiSuccess(c, data)', `\tif piknoFixedCNYEnabled() {
        data["amount_options"] = []int{50, 100, 200}
        data["min_topup"] = 50
        data["discount"] = map[int]float64{}
        data["fixed_cny_topup"] = true
    }
\tcommon.ApiSuccess(c, data)`);
  s = replace(s, '\tif req.Amount < getMinTopup() {', `\tvar creditedQuota *int64
    if piknoFixedCNYEnabled() {
        quota, quotaErr := piknoFixedCNYQuota(req.Amount)
        if quotaErr != nil {
            c.JSON(http.StatusOK, gin.H{"message": "error", "data": quotaErr.Error()})
            return
        }
        if req.PaymentMethod != "alipay" && req.PaymentMethod != "wxpay" {
            c.JSON(http.StatusOK, gin.H{"message": "error", "data": "仅支持支付宝或微信支付"})
            return
        }
        if rejectInvalidCreditedQuota(c, c.GetInt("id"), decimal.NewFromInt(quota)) { return }
        creditedQuota = &quota
    }
\tif creditedQuota == nil && req.Amount < getMinTopup() {`);
  s = replace(s, '\tif rejectInvalidTopUpQuota(c, id, req.Amount) {', '\tif creditedQuota == nil && rejectInvalidTopUpQuota(c, id, req.Amount) {');
  s = replace(s, '\tpayMoney := getPayMoney(req.Amount, group)', '\tpayMoney := getPayMoney(req.Amount, group)\n\tif creditedQuota != nil { payMoney = float64(req.Amount) }');
  s = replace(s, '\t\tAmount:          amount,', '\t\tAmount:          amount,\n\t\tCreditedQuota:   creditedQuota,');
  s = replace(s, 'func RequestAmount(c *gin.Context) {', `func RequestAmount(c *gin.Context) {
    if piknoFixedCNYEnabled() {
        var req AmountRequest
        if err := c.ShouldBindJSON(&req); err != nil {
            c.JSON(http.StatusOK, gin.H{"message": "error", "data": "参数错误"})
            return
        }
        quota, err := piknoFixedCNYQuota(req.Amount)
        if err != nil {
            c.JSON(http.StatusOK, gin.H{"message": "error", "data": err.Error()})
            return
        }
        if rejectInvalidCreditedQuota(c, c.GetInt("id"), decimal.NewFromInt(quota)) { return }
        c.JSON(http.StatusOK, gin.H{"message": "success", "data": strconv.FormatInt(req.Amount, 10) + ".00"})
        return
    }`);
  // Signed checkout parameters are credentials; never log them.
  s = replace(s, 'money=%.2f uri=%q params=%q", id, tradeNo, req.PaymentMethod, req.Amount, payMoney, uri, common.GetJsonString(params)', 'money=%.2f", id, tradeNo, req.PaymentMethod, req.Amount, payMoney');
  return s;
});
await edit('model/topup.go', (s) => {
  s = replace(s, 'type TopUp struct {', 'type TopUp struct {\n\tCreditedQuota *int64 `json:"credited_quota,omitempty"`');
  const old = 'decimal.NewFromInt(topUp.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit))';
  // Only Epay callback and manual settlement; other gateways retain their semantics.
  const rechargeStart = s.indexOf('func RechargeEpay(');
  const rechargeEnd = s.indexOf('func Recharge(', rechargeStart);
  const part = replace(s.slice(rechargeStart, rechargeEnd), old, 'topUp.piknoCreditedQuota()');
  s = s.slice(0, rechargeStart) + part + s.slice(rechargeEnd);
  const manualStart = s.indexOf('func ManualCompleteTopUp(');
  const manualEnd = s.indexOf('func RechargeCreem(', manualStart);
  const manual = replace(s.slice(manualStart, manualEnd), old, 'topUp.piknoCreditedQuota()');
  return s.slice(0, manualStart) + manual + s.slice(manualEnd);
});

const web = 'web/src/features/wallet/';
await edit(web + 'components/recharge-form-card.tsx', (s) => {
  s = replace(s, "import { useState, useEffect } from 'react'\n", '');
  s = replace(s, "import { formatNumber } from '@/lib/format'\n", '');
  s = replace(s, '  getDiscountLabel,\n', '');
  s = replace(s, '  calculatePresetPricing,\n', '');
  s = replace(s, '  onTopupAmountChange,\n', '');
  s = replace(s, '  priceRatio = 1,\n  usdExchangeRate = 1,\n', '');
  s = replace(s, "import { CreemProductsSection } from './creem-products-section'", "import { CreemProductsSection } from './creem-products-section'\nimport { isFixedCnyQuote, FIXED_CNY_AMOUNTS } from '../lib/fixed-cny'");
  s = section(s, '  const [localAmount,', '  const hasConfigurableTopup', '');
  s = replace(s, '  const minTopup = getMinTopupAmount(topupInfo)\n', '');
  s = replace(s, '                    {presetAmounts.map((preset) => {', '                    {presetAmounts.filter((preset) => FIXED_CNY_AMOUNTS.some((value) => value === preset.value)).map((preset) => {');
  s = section(s, '                      const discount =', '                      return (', '');
  s = replace(s, '                          variant=\'outline\'\n                          className={cn(', '                          variant=\'outline\'\n                          aria-pressed={selectedPreset === preset.value}\n                          disabled={!!paymentLoading}\n                          className={cn(');
  s = section(s, "                          <div className='flex w-full items-center justify-between'>", '                        </Button>', `                          <span className='text-lg font-semibold'>¥{formatCurrency(preset.value)}</span>
                          <span className='text-muted-foreground text-xs'>{t('CNY balance credit')}</span>
`);
  s = section(s, "              <div className='space-y-2.5 sm:space-y-3'>\n                <Label\n                  htmlFor='topup-amount'", "              <div className='space-y-2.5 sm:space-y-3'>\n                <Label className=", `              <div className='bg-muted/30 flex items-center justify-between gap-2 rounded-md border p-3'>
                <span>{t('Amount to pay:')}</span>
                {calculating ? <Skeleton className='h-5 w-16' /> : <span>¥{formatCurrency(paymentAmount)}</span>}
              </div>

`);
  s = replace(s, '                      const disabled = minTopup > topupAmount', '                      const disabled = minTopup > topupAmount || calculating || !topupInfo?.fixed_cny_topup || !isFixedCnyQuote(topupAmount, paymentAmount)');
  s = replace(s, 'topupInfo?.pay_methods?.map((method)', "topupInfo?.pay_methods?.filter((method) => method.type === 'alipay' || method.type === 'wxpay').map((method)");
  s = replace(s, 'md:grid-cols-4', 'md:grid-cols-3');
  return s;
});
await edit(web + 'hooks/use-topup-info.ts', (s) => {
  s = section(s, 'import {\n  generatePresetAmounts,', 'import type {', "import { FIXED_CNY_AMOUNTS } from '../lib/fixed-cny'\n");
  return section(s, '      if (processedData.amount_options.length > 0) {', '    } catch (err)', '      setPresetAmounts(FIXED_CNY_AMOUNTS.map((value) => ({ value })))\n');
});
await edit(web + 'index.tsx', (s) => {
  s = replace(s, '      const minTopup = getMinTopupAmount(topupInfo)', '      const minTopup = 50\n      setSelectedPreset(minTopup)');
  s = replace(s, '      await calculatePaymentAmount(topupAmount, method.type)\n      setConfirmDialogOpen(true)', '      const quote = await calculatePaymentAmount(topupAmount, method.type)\n      if (quote !== topupAmount) return\n      setConfirmDialogOpen(true)');
  return replace(s, '        usdExchangeRate={effectiveUsdExchangeRate}', '        usdExchangeRate={1}');
});
await edit(web + 'hooks/use-payment.ts', (s) => {
  s = replace(s, "import type { AmountRequest, AmountResponse } from '../types'", "import type { AmountRequest, AmountResponse } from '../types'\nimport { isFixedCnyAmount } from '../lib/fixed-cny'");
  return replace(s, '        setProcessing(true)', `        if (!isFixedCnyAmount(topupAmount) || !['alipay', 'wxpay'].includes(paymentType)) { return false }
        setProcessing(true)`);
});
await edit(web + 'components/dialogs/payment-confirm-dialog.tsx', (s) => {
  s = replace(s, "import { formatLocalCurrencyAmount } from '@/lib/currency'", "import { isFixedCnyQuote } from '../../lib/fixed-cny'");
  s = replace(s, '  usdExchangeRate = 1,\n', '');
  s = section(s, '              {formatLocalCurrencyAmount(topupAmount * usdExchangeRate, {', '            </span>', '              ¥{formatCurrency(topupAmount)}\n');
  s = replace(s, '{formatCurrency(paymentAmount)}', '¥{formatCurrency(paymentAmount)}');
  return replace(s, 'onClick={onConfirm} disabled={processing}', 'onClick={onConfirm} disabled={processing || calculating || !isFixedCnyQuote(topupAmount, paymentAmount)}');
});
await edit(web + 'types.ts', (s) => replace(replace(s, 'export interface TopupInfo {', 'export interface TopupInfo {\n  fixed_cny_topup?: boolean'), 'export interface TopupRecord {', 'export interface TopupRecord {\n  credited_quota?: number'));
await edit(web + 'components/dialogs/billing-history-dialog.tsx', (s) => {
  s = replace(s, "import { formatNumber } from '@/lib/format'", "import { formatCurrency } from '../../lib'");
  s = replace(s, '{formatCurrencyFromUSD(record.amount, {', '{record.credited_quota != null ? `¥${formatCurrency(record.money)}` : formatCurrencyFromUSD(record.amount, {');
  return replace(s, '{formatNumber(record.money)}', '¥{formatCurrency(record.money)}');
});
await edit('web/src/i18n/locales/zh.json', (s) => {
  const data = JSON.parse(s);
  data.translation['CNY balance credit'] = '人民币余额';
  return JSON.stringify(data, null, 2) + '\n';
});
