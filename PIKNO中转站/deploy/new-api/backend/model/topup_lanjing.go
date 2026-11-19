package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

func GetUserEpayTopUp(userID int, tradeNo string) (*TopUp, error) {
	var order TopUp
	err := DB.Where("user_id = ? AND trade_no = ? AND payment_provider = ?", userID, tradeNo, PaymentProviderEpay).
		First(&order).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrTopUpNotFound
	}
	return &order, err
}

// ClaimLanjingCheckout permits exactly one upstream create attempt. A repeated
// authorization can reuse a bound checkout, but cannot create a second one.
func ClaimLanjingCheckout(tradeNo, method string, amount decimal.Decimal) (*TopUp, bool, error) {
	var order TopUp
	claimed := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := loadManagedEpayTopUp(tx, &order, tradeNo, method, amount); err != nil {
			return err
		}
		if order.Status != common.TopUpStatusPending || *order.EpayClaimedAt != 0 {
			return nil
		}
		now := common.GetTimestamp()
		result := tx.Model(&order).Where("status = ? AND epay_claimed_at = ?", common.TopUpStatusPending, 0).
			Update("epay_claimed_at", now)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 1 {
			order.EpayClaimedAt = &now
			claimed = true
			return nil
		}
		return tx.First(&order, order.Id).Error
	})
	return &order, claimed, err
}

func BindLanjingCheckout(tradeNo, method string, amount decimal.Decimal, gatewayID, reallyPrice string) (*TopUp, error) {
	var order TopUp
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := loadManagedEpayTopUp(tx, &order, tradeNo, method, amount); err != nil {
			return err
		}
		if gatewayID == "" || reallyPrice == "" || *order.EpayClaimedAt == 0 {
			return ErrTopUpStatusInvalid
		}
		if order.EpayGatewayOrderID == gatewayID && order.EpayGatewayReallyPrice == reallyPrice {
			return nil
		}
		if order.EpayGatewayOrderID != "" {
			return ErrTopUpStatusInvalid
		}
		if err := tx.Model(&order).Updates(map[string]any{"epay_gateway_order_id": gatewayID, "epay_gateway_really_price": reallyPrice}).Error; err != nil {
			return err
		}
		order.EpayGatewayOrderID = gatewayID
		order.EpayGatewayReallyPrice = reallyPrice
		return nil
	})
	return &order, err
}

func loadManagedEpayTopUp(tx *gorm.DB, order *TopUp, tradeNo, method string, amount decimal.Decimal) error {
	err := lockForUpdate(tx).Where("trade_no = ? AND payment_provider = ?", tradeNo, PaymentProviderEpay).First(order).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrTopUpNotFound
	}
	if err != nil {
		return err
	}
	if order.EpayClaimedAt == nil {
		return ErrTopUpStatusInvalid
	}
	if order.PaymentMethod != method {
		return ErrPaymentMethodMismatch
	}
	if !amount.Equal(decimal.NewFromFloat(order.Money).Round(2)) {
		return ErrTopUpAmountMismatch
	}
	return nil
}

func BeginLanjingCancellation(userID int, tradeNo string) (*TopUp, error) {
	var order TopUp
	err := DB.Transaction(func(tx *gorm.DB) error {
		err := lockForUpdate(tx).Where("user_id = ? AND trade_no = ? AND payment_provider = ?", userID, tradeNo, PaymentProviderEpay).
			First(&order).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrTopUpNotFound
		}
		if err != nil || order.Status != common.TopUpStatusPending {
			return err
		}
		if order.EpayClaimedAt == nil {
			return ErrTopUpStatusInvalid
		}
		status := common.TopUpStatusClosing
		if *order.EpayClaimedAt == 0 {
			status = common.TopUpStatusCancelled
		}
		if err := tx.Model(&order).Update("status", status).Error; err != nil {
			return err
		}
		order.Status = status
		return nil
	})
	return &order, err
}

// RecordLanjingTerminalState never overwrites a concurrent successful credit.
func RecordLanjingTerminalState(order *TopUp, status string) error {
	if order.EpayGatewayOrderID == "" || (status != common.TopUpStatusExpired && status != common.TopUpStatusCancelled) {
		return ErrTopUpStatusInvalid
	}
	return DB.Model(&TopUp{}).
		Where("id = ? AND epay_gateway_order_id = ? AND status IN ?", order.Id, order.EpayGatewayOrderID,
			[]string{common.TopUpStatusPending, common.TopUpStatusClosing}).
		Update("status", status).Error
}

func ListLanjingCheckoutsForReconciliation(since int64, afterID int, limit int) ([]TopUp, error) {
	var orders []TopUp
	err := DB.Where("id > ? AND create_time >= ? AND payment_provider = ? AND epay_gateway_order_id <> ? AND status IN ?",
		afterID, since, PaymentProviderEpay, "", []string{common.TopUpStatusPending, common.TopUpStatusClosing}).
		Order("id ASC").Limit(limit).Find(&orders).Error
	return orders, err
}
