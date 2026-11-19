package model

import (
	"errors"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

const PiknoReversePriceVersion = "reverse-cny-003-v1"
const PiknoReverseReservationQuota = 18000000
const PiknoReverseQuotaPerSecond = 30000

// This control-plane table is independent of generation and financial ledgers.
// Provider identifiers and short-lived upload credentials never enter API views.
type PiknoReverseOperation struct {
	ID                 string `gorm:"primaryKey;size:40" json:"-"`
	UserID             int    `gorm:"not null;uniqueIndex:pikno_reverse_owner_operation" json:"-"`
	OperationID        string `gorm:"size:80;not null;uniqueIndex:pikno_reverse_owner_operation" json:"-"`
	TokenID            int    `json:"-"`
	TokenLimited       bool   `json:"-"`
	ResourceKey        string `gorm:"size:64;not null;uniqueIndex" json:"-"`
	Kind               string `gorm:"size:8;not null" json:"-"`
	RequestSHA256      string `gorm:"size:64;not null" json:"-"`
	UploadID           string `gorm:"size:40" json:"-"`
	State              string `gorm:"size:16;not null" json:"-"`
	ProviderUploadKey  string `gorm:"type:text" json:"-"`
	ProviderAccountRef string `gorm:"size:64" json:"-"`
	ProviderJobID      string `gorm:"size:160" json:"-"`
	UploadURL          string `gorm:"type:text" json:"-"`
	ContentType        string `gorm:"size:80" json:"-"`
	ExpiresAt          int64  `json:"-"`
	ResultText         string `gorm:"type:text" json:"-"`
	ChargedSeconds     string `gorm:"size:80" json:"-"`
	PriceVersion       string `gorm:"size:40" json:"-"`
	FinancialState     string `gorm:"size:16" json:"-"`
	ReservedQuota      int    `json:"-"`
	ChargedQuota       int    `json:"-"`
	RefundedQuota      int    `json:"-"`
	CreatedAt          int64  `json:"-"`
	UpdatedAt          int64  `json:"-"`
}

var ErrPiknoReverseConflict = errors.New("reverse operation conflict")
var ErrPiknoReverseQuota = errors.New("reverse reservation exceeds available balance")

// This table contains private result text and temporary upload credentials.
// Suppress ORM statement interpolation, including slow/error statement logs.
func piknoReverseDB() *gorm.DB {
	return DB.Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)})
}

func MigratePiknoReverse(db *gorm.DB) error { return db.AutoMigrate(&PiknoReverseOperation{}) }

func GetPiknoReverseOperation(userID int, operationID string) (*PiknoReverseOperation, error) {
	var row PiknoReverseOperation
	err := piknoReverseDB().Where("user_id = ? AND operation_id = ?", userID, operationID).First(&row).Error
	return &row, err
}

func GetPiknoReverseResource(userID int, id, kind string) (*PiknoReverseOperation, error) {
	var row PiknoReverseOperation
	err := piknoReverseDB().Where("user_id = ? AND id = ? AND kind = ?", userID, id, kind).First(&row).Error
	return &row, err
}

// The unique claim is committed before HTTP dispatch. A crash or ambiguous
// response leaves an unknown operation; neither replay nor another operation
// on the same upload may initiate another task.
func ClaimPiknoReverseOperation(row *PiknoReverseOperation) (*PiknoReverseOperation, bool, error) {
	row.State = "unknown"
	row.CreatedAt = time.Now().Unix()
	row.UpdatedAt = row.CreatedAt
	created := false
	err := piknoReverseDB().Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, row.UserID).Error; err != nil {
			return err
		}
		var existing PiknoReverseOperation
		err := tx.Where("user_id = ? AND (operation_id = ? OR resource_key = ?)", row.UserID, row.OperationID, row.ResourceKey).First(&existing).Error
		if err == nil {
			if existing.OperationID != row.OperationID || existing.RequestSHA256 != row.RequestSHA256 || existing.Kind != row.Kind || existing.TokenID != row.TokenID {
				return ErrPiknoReverseConflict
			}
			*row = existing
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if row.Kind == "task" {
			if err := piknoSettlementGate(); err != nil {
				return err
			}
			var token Token
			if err := lockForUpdate(tx).Where("id = ? AND user_id = ?", row.TokenID, row.UserID).First(&token).Error; err != nil {
				return err
			}
			if user.Status != common.UserStatusEnabled || token.Status != common.TokenStatusEnabled || token.Group != "tool-standard" || (token.ExpiredTime != -1 && token.ExpiredTime <= common.GetTimestamp()) || (token.ModelLimitsEnabled && !token.GetModelLimitsMap()["pikno-reverse"]) {
				return ErrPiknoReverseConflict
			}
			if user.Quota < PiknoReverseReservationQuota || (!token.UnlimitedQuota && token.RemainQuota < PiknoReverseReservationQuota) {
				return ErrPiknoReverseQuota
			}
			if err := tx.Model(&User{}).Where("id = ?", user.Id).Update("quota", gorm.Expr("quota - ?", PiknoReverseReservationQuota)).Error; err != nil {
				return err
			}
			if !token.UnlimitedQuota {
				if err := tx.Model(&Token{}).Where("id = ?", token.Id).Update("remain_quota", gorm.Expr("remain_quota - ?", PiknoReverseReservationQuota)).Error; err != nil {
					return err
				}
			}
			row.TokenLimited, row.ReservedQuota = !token.UnlimitedQuota, PiknoReverseReservationQuota
			row.PriceVersion, row.FinancialState = PiknoReversePriceVersion, "reserved"
		}
		result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(row)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrPiknoReverseConflict // rolls back any reservation
		}
		created = true
		return nil
	})
	return row, created, err
}

func UpdatePiknoReverseOperation(row *PiknoReverseOperation, values map[string]any) error {
	values["updated_at"] = time.Now().Unix()
	// Terminal results are monotonic even when concurrent read-only polls finish
	// out of order. Never turn a final result back into queued or unknown.
	result := piknoReverseDB().Model(&PiknoReverseOperation{}).Where("id = ? AND user_id = ? AND state NOT IN ?", row.ID, row.UserID, []string{"done", "error", "cancelled"}).Updates(values)
	if result.Error != nil {
		return result.Error
	}
	return piknoReverseDB().Where("id = ? AND user_id = ?", row.ID, row.UserID).First(row).Error
}

// Only authenticated provider observations call this method. File metadata and
// client-selected target duration never decide a charge. Terminal money and
// wallet/token counters commit atomically and may be applied only once.
func ObservePiknoReverseTask(row *PiknoReverseOperation, state, providerID, text string, seconds *decimal.Decimal) error {
	if err := piknoSettlementGate(); err != nil {
		return err
	}
	return piknoReverseDB().Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, row.UserID).Error; err != nil {
			return err
		}
		if err := lockForUpdate(tx).Where("id = ? AND user_id = ? AND kind = ?", row.ID, row.UserID, "task").First(row).Error; err != nil {
			return err
		}
		if row.FinancialState == "settled" || row.FinancialState == "released" {
			return nil
		}
		if row.PriceVersion != PiknoReversePriceVersion || row.ReservedQuota != PiknoReverseReservationQuota || (row.ProviderJobID != "" && row.ProviderJobID != providerID) {
			return ErrPiknoReverseConflict
		}
		if row.State == "done" && state != "done" {
			return nil
		}
		values := map[string]any{"state": state, "provider_job_id": providerID, "updated_at": common.GetTimestamp()}
		if state == "done" {
			values["result_text"] = text
		}
		final := state == "error" || state == "cancelled" || (state == "done" && seconds != nil)
		if !final {
			values["financial_state"] = "reserved"
			if state == "done" || state == "unknown" {
				values["financial_state"] = "pending"
			}
			if err := tx.Model(row).Updates(values).Error; err != nil {
				return err
			}
			return tx.Where("id = ?", row.ID).First(row).Error
		}
		charge := 0
		if state == "done" {
			if seconds.IsNegative() || seconds.GreaterThan(decimal.NewFromInt(600)) || seconds.Exponent() < -9 || seconds.Exponent() > 9 {
				return ErrPiknoReverseConflict
			}
			var err error
			charge, err = common.QuotaFromDecimalStrict(seconds.Mul(decimal.NewFromInt(PiknoReverseQuotaPerSecond)))
			if err != nil || charge < 0 || charge > row.ReservedQuota {
				return ErrPiknoReverseConflict
			}
			values["charged_seconds"] = seconds.String()
		}
		refund := row.ReservedQuota - charge
		var token Token
		// Revocation after dispatch cannot erase the original reservation.
		if err := lockForUpdate(tx.Unscoped()).Where("id = ? AND user_id = ?", row.TokenID, row.UserID).First(&token).Error; err != nil {
			return err
		}
		quota, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(user.Quota)).Add(decimal.NewFromInt(int64(refund))))
		if err != nil {
			return err
		}
		used, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(user.UsedQuota)).Add(decimal.NewFromInt(int64(charge))))
		if err != nil {
			return err
		}
		tokenUsed, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(token.UsedQuota)).Add(decimal.NewFromInt(int64(charge))))
		if err != nil {
			return err
		}
		requests := user.RequestCount
		if state == "done" {
			requests, err = common.QuotaFromDecimalStrict(decimal.NewFromInt(int64(requests)).Add(decimal.NewFromInt(1)))
			if err != nil {
				return err
			}
		}
		tokenValues := map[string]any{"used_quota": tokenUsed}
		if row.TokenLimited {
			remain, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(token.RemainQuota)).Add(decimal.NewFromInt(int64(refund))))
			if err != nil {
				return err
			}
			tokenValues["remain_quota"] = remain
			// A concurrent normal API check can mark a fully reserved key as
			// exhausted. Releasing its own hold restores only that automatic
			// quota state, never a disabled or expired credential.
			if remain > 0 && token.Status == common.TokenStatusExhausted && (token.ExpiredTime == -1 || token.ExpiredTime > common.GetTimestamp()) {
				tokenValues["status"] = common.TokenStatusEnabled
			}
		}
		if err := tx.Model(&User{}).Where("id = ?", user.Id).Updates(map[string]any{"quota": quota, "used_quota": used, "request_count": requests}).Error; err != nil {
			return err
		}
		if err := tx.Unscoped().Model(&Token{}).Where("id = ? AND user_id = ?", token.Id, row.UserID).Updates(tokenValues).Error; err != nil {
			return err
		}
		financial := "released"
		if state == "done" {
			financial = "settled"
		}
		values["financial_state"], values["charged_quota"], values["refunded_quota"] = financial, charge, refund
		if err := tx.Model(row).Updates(values).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", row.ID).First(row).Error
	})
}
