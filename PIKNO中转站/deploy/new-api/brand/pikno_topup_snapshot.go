package model

import (
    "github.com/QuantumNous/new-api/common"
    "github.com/shopspring/decimal"
)

func (topUp *TopUp) piknoCreditedQuota() decimal.Decimal {
    if topUp.CreditedQuota != nil {
        return decimal.NewFromInt(*topUp.CreditedQuota)
    }
    return decimal.NewFromInt(topUp.Amount).Mul(decimal.NewFromFloat(common.QuotaPerUnit))
}
