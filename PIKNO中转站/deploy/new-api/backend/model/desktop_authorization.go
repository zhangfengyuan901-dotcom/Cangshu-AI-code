package model

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"gorm.io/gorm"
)

var (
	ErrDesktopFlowInvalid      = errors.New("desktop authorization is invalid")
	ErrDesktopAccountMismatch  = errors.New("desktop account does not match")
	ErrDesktopApprovalRequired = errors.New("desktop authorization is pending")
	ErrDesktopFlowComplete     = errors.New("desktop authorization is complete")
	ErrDesktopSetupFailed      = errors.New("desktop keys cannot be configured")
)

// DesktopAuthorization stores only the challenge, never the device verifier.
// The browser authenticates independently before binding its account to a flow.
type DesktopAuthorization struct {
	ID              string `gorm:"type:varchar(43);primaryKey"`
	Challenge       string `gorm:"type:varchar(43);not null;uniqueIndex"`
	Purpose         string `gorm:"type:varchar(16);not null"`
	ExpectedUserID  int    `gorm:"not null"`
	UserID          int    `gorm:"not null"`
	UserAuthVersion int64  `gorm:"not null"`
	ApprovalSID     string `gorm:"type:varchar(64)"`
	SourceSID       string `gorm:"type:varchar(64)"`
	DesktopSID      string `gorm:"type:varchar(64)"`
	Status          string `gorm:"type:varchar(16);not null"`
	CreatedAt       int64  `gorm:"not null"`
	ExpiresAt       int64  `gorm:"not null;index"`
}

// Managed references are unique per account and purpose. Ordinary user keys
// are left intact, and a disabled managed key requires explicit user action.
type DesktopManagedKey struct {
	UserID  int    `gorm:"primaryKey;autoIncrement:false"`
	Group   string `gorm:"type:varchar(32);primaryKey"`
	TokenID int    `gorm:"not null"`
}

func WithDesktopAuthorization(id string, apply func(*gorm.DB, *DesktopAuthorization) error) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var flow DesktopAuthorization
		if err := lockForUpdate(tx).Where("id = ?", id).First(&flow).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrDesktopFlowInvalid
			}
			return err
		}
		if flow.ExpiresAt <= common.GetTimestamp() {
			return ErrDesktopFlowInvalid
		}
		return apply(tx, &flow)
	})
}

func LockDesktopUser(tx *gorm.DB, userID int) (*User, error) {
	var user User
	err := lockForUpdate(tx).Where("id = ?", userID).First(&user).Error
	return &user, err
}

func DesktopSourceSessionActive(tx *gorm.DB, flow *DesktopAuthorization) bool {
	if flow.SourceSID == "" {
		return true
	}
	var session UserSession
	return tx.Where("sid = ? AND user_id = ?", flow.SourceSID, flow.ExpectedUserID).First(&session).Error == nil &&
		session.Status == UserSessionStatusActive && session.ExpiresAt > common.GetTimestamp() && session.UserAuthVersion == flow.UserAuthVersion
}

func CleanupDesktopAuthorizations() error {
	var expired []DesktopAuthorization
	if err := DB.Select("id").Where("expires_at < ?", common.GetTimestamp()-86400).Order("expires_at ASC").Limit(100).Find(&expired).Error; err != nil {
		return err
	}
	ids := make([]string, 0, len(expired))
	for _, flow := range expired {
		ids = append(ids, flow.ID)
	}
	if len(ids) == 0 {
		return nil
	}
	return DB.Where("id IN ?", ids).Delete(&DesktopAuthorization{}).Error
}

func EnsureDesktopManagedKeys(tx *gorm.DB, userID int, groups []string) ([]Token, error) {
	var count int64
	if err := tx.Model(&Token{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
		return nil, err
	}
	tokens := make([]Token, 0, len(groups))
	for _, group := range groups {
		var reference DesktopManagedKey
		err := tx.Where(&DesktopManagedKey{UserID: userID, Group: group}).First(&reference).Error
		if err == nil {
			var token Token
			if err := tx.Where("id = ? AND user_id = ?", reference.TokenID, userID).First(&token).Error; err != nil {
				return nil, ErrDesktopSetupFailed
			}
			if token.Group != group || token.Status != common.TokenStatusEnabled || token.Key == "" ||
				(token.ExpiredTime != -1 && token.ExpiredTime <= common.GetTimestamp()) {
				return nil, ErrDesktopSetupFailed
			}
			tokens = append(tokens, token)
			continue
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
		if count >= int64(operation_setting.GetMaxUserTokens()) {
			return nil, ErrDesktopSetupFailed
		}
		key, err := common.GenerateKey()
		if err != nil {
			return nil, err
		}
		token := Token{UserId: userID, Group: group, Key: key, Name: "仓鼠AI · " + group,
			Status: common.TokenStatusEnabled, CreatedTime: common.GetTimestamp(), AccessedTime: common.GetTimestamp(),
			ExpiredTime: -1, UnlimitedQuota: true}
		if err := tx.Create(&token).Error; err != nil {
			return nil, err
		}
		if err := tx.Create(&DesktopManagedKey{UserID: userID, Group: group, TokenID: token.Id}).Error; err != nil {
			return nil, err
		}
		tokens = append(tokens, token)
		count++
	}
	return tokens, nil
}

func GetDesktopManagedKeys(tx *gorm.DB, userID int) ([]Token, error) {
	var references []DesktopManagedKey
	if err := tx.Where("user_id = ?", userID).Order("token_id ASC").Find(&references).Error; err != nil {
		return nil, err
	}
	if len(references) != 4 {
		return nil, ErrDesktopSetupFailed
	}
	result := make([]Token, 0, len(references))
	for _, reference := range references {
		var token Token
		if err := tx.Where("id = ? AND user_id = ?", reference.TokenID, userID).First(&token).Error; err != nil {
			return nil, ErrDesktopSetupFailed
		}
		if token.Group != reference.Group || token.Status != common.TokenStatusEnabled || token.Key == "" ||
			(token.ExpiredTime != -1 && token.ExpiredTime <= common.GetTimestamp()) {
			return nil, ErrDesktopSetupFailed
		}
		result = append(result, token)
	}
	return result, nil
}
