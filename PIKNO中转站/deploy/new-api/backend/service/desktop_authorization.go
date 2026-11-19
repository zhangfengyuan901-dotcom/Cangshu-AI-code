package service

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
)

var (
	desktopReference = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	desktopVerifier  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

var desktopGroups = []string{"image-standard", "video-standard", "tool-standard", "chat-standard"}

func StartDesktopAuthorization(challenge, purpose string, identity *AuthIdentity, expectedUserID ...int) (*model.DesktopAuthorization, error) {
	if !desktopReference.MatchString(challenge) || (purpose != "connect" && purpose != "recharge") || (purpose == "recharge" && identity == nil) {
		return nil, model.ErrDesktopFlowInvalid
	}
	flow := &model.DesktopAuthorization{Challenge: challenge, Purpose: purpose, Status: "pending", CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(15 * time.Minute).Unix()}
	if len(expectedUserID) > 0 {
		if expectedUserID[0] < 0 {
			return nil, model.ErrDesktopFlowInvalid
		}
		flow.ExpectedUserID = expectedUserID[0]
	}
	if identity != nil {
		if flow.ExpectedUserID != 0 && flow.ExpectedUserID != identity.UserID {
			return nil, model.ErrDesktopAccountMismatch
		}
		flow.ExpectedUserID = identity.UserID
		flow.UserAuthVersion = identity.UserAuthVersion
		flow.ApprovalSID = identity.SessionID
		flow.SourceSID = identity.SessionID
	}
	_ = model.CleanupDesktopAuthorizations()
	var existing []model.DesktopAuthorization
	if err := model.DB.Where("challenge = ?", challenge).Limit(1).Find(&existing).Error; err != nil {
		return nil, err
	}
	if len(existing) > 0 {
		previous := existing[0]
		if previous.ExpiresAt <= time.Now().Unix() || previous.Purpose != purpose || previous.ExpectedUserID != flow.ExpectedUserID {
			return nil, model.ErrDesktopFlowInvalid
		}
		return &previous, nil
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	flow.ID = base64.RawURLEncoding.EncodeToString(random[:])
	if err := model.DB.Create(flow).Error; err != nil {
		return nil, err
	}
	return flow, nil
}

func ValidateDesktopRegistration(id string) error {
	if !desktopReference.MatchString(id) {
		return model.ErrDesktopFlowInvalid
	}
	return model.WithDesktopAuthorization(id, func(tx *gorm.DB, flow *model.DesktopAuthorization) error {
		if flow.Purpose != "connect" || flow.Status != "pending" || flow.ExpectedUserID != 0 {
			return model.ErrDesktopFlowInvalid
		}
		return nil
	})
}

func BindDesktopRegistration(id string, userID int, authVersion int64) error {
	return model.WithDesktopAuthorization(id, func(tx *gorm.DB, flow *model.DesktopAuthorization) error {
		if flow.Purpose != "connect" || flow.Status != "pending" || flow.ExpectedUserID != 0 {
			return model.ErrDesktopFlowInvalid
		}
		return tx.Model(flow).Updates(map[string]any{"expected_user_id": userID, "user_auth_version": authVersion}).Error
	})
}

func InspectDesktopAuthorization(id string, identity AuthIdentity, approve bool) (*model.DesktopAuthorization, error) {
	if !desktopReference.MatchString(id) {
		return nil, model.ErrDesktopFlowInvalid
	}
	var result model.DesktopAuthorization
	err := model.WithDesktopAuthorization(id, func(tx *gorm.DB, flow *model.DesktopAuthorization) error {
		if flow.ExpectedUserID != 0 && flow.ExpectedUserID != identity.UserID || flow.UserID != 0 && flow.UserID != identity.UserID {
			return model.ErrDesktopAccountMismatch
		}
		user, err := model.LockDesktopUser(tx, identity.UserID)
		if err != nil {
			return err
		}
		if user.Status != common.UserStatusEnabled || user.AuthVersion != identity.UserAuthVersion ||
			((flow.ExpectedUserID != 0 || flow.UserID != 0) && flow.UserAuthVersion > 0 && flow.UserAuthVersion != identity.UserAuthVersion) {
			return model.ErrDesktopFlowInvalid
		}
		if !model.DesktopSourceSessionActive(tx, flow) {
			return model.ErrDesktopFlowInvalid
		}
		if flow.Status == "complete" {
			result = *flow
			return nil
		}
		if flow.Purpose == "recharge" || (approve && flow.Status == "pending") {
			if flow.Purpose == "connect" {
				for _, group := range desktopGroups {
					if !IsUserSelectableGroup(user.Group, group) {
						return model.ErrDesktopSetupFailed
					}
				}
				if _, err := model.EnsureDesktopManagedKeys(tx, user.Id, desktopGroups); err != nil {
					return err
				}
				flow.Status = "approved"
			} else {
				flow.Status = "ready"
			}
			flow.UserID = identity.UserID
			flow.UserAuthVersion = identity.UserAuthVersion
			flow.ApprovalSID = identity.SessionID
			if err := tx.Save(flow).Error; err != nil {
				return err
			}
		}
		result = *flow
		return nil
	})
	return &result, err
}

func desktopProof(flow *model.DesktopAuthorization, verifier string) bool {
	if !desktopVerifier.MatchString(verifier) {
		return false
	}
	digest := sha256.Sum256([]byte(verifier))
	return hmac.Equal([]byte(flow.Challenge), []byte(base64.RawURLEncoding.EncodeToString(digest[:])))
}

// Exchange is recoverable until acknowledgement. Retrying a lost response returns
// the same refresh secret, and never adds a session or keys. Rotation ends replay.
func ExchangeDesktopAuthorization(id, verifier, ip, userAgent string) (*model.DesktopAuthorization, *AuthBundle, []model.Token, error) {
	if !desktopReference.MatchString(id) {
		return nil, nil, nil, model.ErrDesktopFlowInvalid
	}
	var result model.DesktopAuthorization
	var session *model.UserSession
	var secret string
	var keys []model.Token
	err := model.WithDesktopAuthorization(id, func(tx *gorm.DB, flow *model.DesktopAuthorization) error {
		if !desktopProof(flow, verifier) {
			return model.ErrDesktopFlowInvalid
		}
		if flow.Status == "complete" {
			return model.ErrDesktopFlowComplete
		}
		result = *flow
		if flow.Status == "pending" {
			return nil
		}
		user, err := model.LockDesktopUser(tx, flow.UserID)
		if err != nil {
			return err
		}
		if user.Status != common.UserStatusEnabled || user.AuthVersion != flow.UserAuthVersion {
			return model.ErrDesktopFlowInvalid
		}
		if !model.DesktopSourceSessionActive(tx, flow) {
			return model.ErrDesktopFlowInvalid
		}
		var browser model.UserSession
		if err := tx.Where("sid = ? AND user_id = ?", flow.ApprovalSID, flow.UserID).First(&browser).Error; err != nil {
			return model.ErrDesktopFlowInvalid
		}
		if browser.Status != model.UserSessionStatusActive || browser.ExpiresAt <= time.Now().Unix() || browser.UserAuthVersion != user.AuthVersion {
			return model.ErrDesktopFlowInvalid
		}
		if flow.Purpose == "recharge" {
			return nil
		}
		secret = common.GenerateHMACWithKey(authSigningKey("desktop-refresh"), flow.ID+"."+verifier)
		if flow.DesktopSID == "" {
			var active, issued int64
			if err := tx.Model(&model.UserSession{}).Where("user_id = ? AND status = ? AND expires_at > ?", user.Id, model.UserSessionStatusActive, time.Now().Unix()).Count(&active).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.UserSession{}).Where("user_id = ? AND created_at >= ?", user.Id, time.Now().Unix()-common.UserSessionIssuanceWindowSeconds).Count(&issued).Error; err != nil {
				return err
			}
			if active >= int64(common.UserSessionActiveLimit) {
				return model.ErrUserSessionLimit
			}
			if issued >= int64(common.UserSessionIssuanceLimit) {
				return model.ErrUserSessionIssuanceLimit
			}
			session, _, err = newLoginSession(user.Id, user.AuthVersion, "desktop_browser", ip, userAgent)
			if err != nil {
				return err
			}
			session.RefreshHash = hashRefreshSecret(secret)
			if err := tx.Create(session).Error; err != nil {
				return err
			}
			flow.DesktopSID = session.SID
			flow.Status = "ready"
			if err := tx.Save(flow).Error; err != nil {
				return err
			}
		} else {
			session = &model.UserSession{}
			if err := tx.Where("sid = ? AND user_id = ?", flow.DesktopSID, user.Id).First(session).Error; err != nil {
				return model.ErrDesktopFlowInvalid
			}
			if session.Status != model.UserSessionStatusActive || session.ExpiresAt <= time.Now().Unix() || session.UserAuthVersion != user.AuthVersion ||
				!hmac.Equal([]byte(session.RefreshHash), []byte(hashRefreshSecret(secret))) {
				return model.ErrDesktopFlowInvalid
			}
		}
		keys, err = model.GetDesktopManagedKeys(tx, user.Id)
		if err != nil {
			return err
		}
		result = *flow
		return nil
	})
	if err != nil || session == nil {
		return &result, nil, keys, err
	}
	bundle, err := issueAuthBundle(session, session.SID+"."+secret, true)
	return &result, bundle, keys, err
}

func AcknowledgeDesktopAuthorization(id, verifier string, identity AuthIdentity) error {
	if !desktopReference.MatchString(id) {
		return model.ErrDesktopFlowInvalid
	}
	return model.WithDesktopAuthorization(id, func(tx *gorm.DB, flow *model.DesktopAuthorization) error {
		if !desktopProof(flow, verifier) || flow.UserID != identity.UserID || flow.UserAuthVersion != identity.UserAuthVersion {
			return model.ErrDesktopFlowInvalid
		}
		if flow.Purpose == "connect" && flow.DesktopSID != identity.SessionID {
			return model.ErrDesktopFlowInvalid
		}
		if flow.Status != "ready" && flow.Status != "complete" {
			return model.ErrDesktopApprovalRequired
		}
		return tx.Model(flow).Update("status", "complete").Error
	})
}

func ValidateDesktopRecharge(id string, userID int) error {
	if !desktopReference.MatchString(id) {
		return model.ErrDesktopFlowInvalid
	}
	return model.WithDesktopAuthorization(id, func(tx *gorm.DB, flow *model.DesktopAuthorization) error {
		if flow.UserID != userID {
			return model.ErrDesktopAccountMismatch
		}
		if flow.Status != "ready" && flow.Status != "approved" && flow.Status != "complete" {
			return model.ErrDesktopApprovalRequired
		}
		user, err := model.LockDesktopUser(tx, userID)
		if err != nil {
			return err
		}
		if user.Status != common.UserStatusEnabled || user.AuthVersion != flow.UserAuthVersion {
			return model.ErrDesktopFlowInvalid
		}
		if !model.DesktopSourceSessionActive(tx, flow) {
			return model.ErrDesktopFlowInvalid
		}
		return nil
	})
}
