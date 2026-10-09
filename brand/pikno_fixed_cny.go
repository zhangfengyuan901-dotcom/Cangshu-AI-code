package controller

import (
    "errors"
    "os"

    "github.com/QuantumNous/new-api/common"
    "github.com/QuantumNous/new-api/setting/operation_setting"
    "github.com/shopspring/decimal"
)

func piknoFixedCNYEnabled() bool {
    return os.Getenv("PIKNO_FIXED_CNY_TOPUP") == "true"
}

// PIKNO's existing ledger represents one CNY as exactly 1,000,000 quota.
// Check the live display conversion before checkout, then snapshot quota on
// the order. Never change global quota units or reinterpret historical orders.
func piknoFixedCNYQuota(amount int64) (int64, error) {
    if amount != 50 && amount != 100 && amount != 200 {
        return 0, errors.New("仅支持人民币 50、100、200 元固定充值")
    }
    rate := operation_setting.USDExchangeRate
    if !operation_setting.IsCNYDisplay() || rate <= 0 || common.QuotaPerUnit <= 0 {
        return 0, errors.New("人民币充值配置异常，请联系管理员")
    }
    quotaPerCNY := decimal.NewFromFloat(common.QuotaPerUnit).Div(decimal.NewFromFloat(rate))
    if !quotaPerCNY.Equal(decimal.NewFromInt(1_000_000)) {
        return 0, errors.New("人民币充值配置异常，请联系管理员")
    }
    quota, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(amount).Mul(quotaPerCNY))
    return int64(quota), err
}
