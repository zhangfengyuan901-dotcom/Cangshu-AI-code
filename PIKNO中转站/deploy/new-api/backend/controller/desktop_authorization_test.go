package controller

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestDesktopAuthorization(t *testing.T) {
	oldDB, oldRedis := model.DB, common.RedisEnabled
	oldType := common.MainDatabaseType()
	oldGroups, oldRatios := setting.UserUsableGroups2JSONString(), ratio_setting.GetGroupRatioCopy()
	t.Cleanup(func() {
		model.DB, common.RedisEnabled = oldDB, oldRedis
		common.SetMainDatabaseType(oldType)
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(oldGroups))
		raw, err := common.Marshal(oldRatios)
		require.NoError(t, err)
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(string(raw)))
	})
	common.RedisEnabled = false
	var driver gorm.Dialector = sqlite.Open(":memory:")
	engine := common.DatabaseTypeSQLite
	switch os.Getenv("PIKNO_TEST_DB_ENGINE") {
	case "mysql":
		driver = mysql.Open(os.Getenv("PIKNO_TEST_DB_DSN"))
		engine = common.DatabaseTypeMySQL
	case "postgres":
		driver = postgres.Open(os.Getenv("PIKNO_TEST_DB_DSN"))
		engine = common.DatabaseTypePostgreSQL
	}
	db, err := gorm.Open(driver, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	connection, err := db.DB()
	require.NoError(t, err)
	connection.SetMaxOpenConns(1)
	t.Cleanup(func() { require.NoError(t, connection.Close()) })
	model.DB = db
	common.SetMainDatabaseType(engine)
	groups := map[string]string{"image-standard": "图片", "video-standard": "视频", "tool-standard": "工具", "chat-standard": "对话"}
	raw, err := common.Marshal(groups)
	require.NoError(t, err)
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(string(raw)))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"image-standard":1,"video-standard":1,"tool-standard":1,"chat-standard":1}`))

	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}, &model.UserSession{}))
	account := model.User{Id: 420042, Username: "desktop-fixture", AffCode: "desktop-fixture", Status: common.UserStatusEnabled, Role: common.RoleCommonUser, Group: "default", AuthVersion: 1}
	other := model.User{Id: 420043, Username: "other-fixture", AffCode: "other-fixture", Status: common.UserStatusEnabled, Role: common.RoleCommonUser, Group: "default", AuthVersion: 1}
	require.NoError(t, db.Create(&account).Error)
	require.NoError(t, db.Create(&other).Error)
	ordinary := model.Token{UserId: account.Id, Key: strings.Repeat("ordinary-fixture", 3), Group: "image-standard", Name: "existing-user-key", Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
	require.NoError(t, db.Create(&ordinary).Error)
	for range 2 {
		require.NoError(t, db.AutoMigrate(&model.DesktopAuthorization{}, &model.DesktopManagedKey{}))
	}
	var preserved model.Token
	require.NoError(t, db.First(&preserved, ordinary.Id).Error)
	require.True(t, preserved.Key == ordinary.Key)
	browser := model.UserSession{SID: "90aabcc0-b13f-45be-9153-7d589884cc31", UserID: account.Id, Version: 1, UserAuthVersion: 1, Status: model.UserSessionStatusActive, RefreshHash: strings.Repeat("0", 64), LoginMethod: "password", CreatedAt: time.Now().Unix(), LastActiveAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	require.NoError(t, db.Create(&browser).Error)
	identity := service.AuthIdentity{UserID: account.Id, UserAuthVersion: 1, SessionVersion: 1, SessionID: browser.SID}
	otherIdentity := identity
	otherIdentity.UserID = other.Id

	makeFlow := func(letter string, purpose string, who *service.AuthIdentity) (*model.DesktopAuthorization, string) {
		t.Helper()
		verifier := strings.Repeat(letter, 43)
		sum := sha256.Sum256([]byte(verifier))
		flow, err := service.StartDesktopAuthorization(base64.RawURLEncoding.EncodeToString(sum[:]), purpose, who)
		require.NoError(t, err)
		return flow, verifier
	}
	countKeys := func(expected int64) {
		t.Helper()
		var count int64
		require.NoError(t, db.Model(&model.Token{}).Where("user_id = ?", account.Id).Count(&count).Error)
		require.Equal(t, expected, count)
	}

	t.Run("pending authorization and explicit approval", func(t *testing.T) {
		flow, verifier := makeFlow("a", "connect", nil)
		pending, bundle, keys, err := service.ExchangeDesktopAuthorization(flow.ID, verifier, "127.0.0.1", "fixture")
		require.NoError(t, err)
		require.Equal(t, "pending", pending.Status)
		require.Nil(t, bundle)
		require.Empty(t, keys)
		_, _, _, err = service.ExchangeDesktopAuthorization(flow.ID, strings.Repeat("b", 43), "127.0.0.1", "fixture")
		require.ErrorIs(t, err, model.ErrDesktopFlowInvalid)
		inspected, err := service.InspectDesktopAuthorization(flow.ID, identity, false)
		require.NoError(t, err)
		require.Equal(t, "pending", inspected.Status)
		countKeys(1)
		approved, err := service.InspectDesktopAuthorization(flow.ID, identity, true)
		require.NoError(t, err)
		require.Equal(t, "approved", approved.Status)
		countKeys(5)
		_, err = service.InspectDesktopAuthorization(flow.ID, otherIdentity, true)
		require.ErrorIs(t, err, model.ErrDesktopAccountMismatch)
		ready, bundle, keys, err := service.ExchangeDesktopAuthorization(flow.ID, verifier, "127.0.0.1", "fixture")
		require.NoError(t, err)
		require.Equal(t, "ready", ready.Status)
		require.NotNil(t, bundle)
		require.Len(t, keys, 4)
		_, again, repeated, err := service.ExchangeDesktopAuthorization(flow.ID, verifier, "127.0.0.1", "fixture")
		require.NoError(t, err)
		require.True(t, again.RefreshToken == bundle.RefreshToken)
		require.Equal(t, bundle.Session.SID, again.Session.SID)
		require.Len(t, repeated, 4)
		countKeys(5)
		require.True(t, keys[0].Key == repeated[0].Key)
		appIdentity := service.AuthIdentity{UserID: account.Id, UserAuthVersion: 1, SessionVersion: 1, SessionID: bundle.Session.SID}
		require.ErrorIs(t, service.AcknowledgeDesktopAuthorization(flow.ID, verifier, identity), model.ErrDesktopFlowInvalid)
		require.NoError(t, service.AcknowledgeDesktopAuthorization(flow.ID, verifier, appIdentity))
		require.NoError(t, service.AcknowledgeDesktopAuthorization(flow.ID, verifier, appIdentity))
		_, _, _, err = service.ExchangeDesktopAuthorization(flow.ID, verifier, "127.0.0.1", "fixture")
		require.ErrorIs(t, err, model.ErrDesktopFlowComplete)
		require.NoError(t, service.ValidateDesktopRecharge(flow.ID, account.Id))
		require.ErrorIs(t, service.ValidateDesktopRecharge(flow.ID, other.Id), model.ErrDesktopAccountMismatch)
		var unchanged model.Token
		require.NoError(t, db.First(&unchanged, ordinary.Id).Error)
		require.True(t, unchanged.Key == ordinary.Key)
	})

	t.Run("retry and reconnect reuse account purpose keys", func(t *testing.T) {
		flow, verifier := makeFlow("c", "connect", &identity)
		_, err := service.InspectDesktopAuthorization(flow.ID, identity, true)
		require.NoError(t, err)
		_, bundle, keys, err := service.ExchangeDesktopAuthorization(flow.ID, verifier, "127.0.0.1", "fixture")
		require.NoError(t, err)
		require.NotNil(t, bundle)
		require.Len(t, keys, 4)
		countKeys(5)
		var sessions int64
		require.NoError(t, db.Model(&model.UserSession{}).Where("sid = ?", bundle.Session.SID).Count(&sessions).Error)
		require.Equal(t, int64(1), sessions)
		// A rotated refresh token ends enrollment replay even before ACK.
		require.NoError(t, db.Model(&model.UserSession{}).Where("sid = ?", bundle.Session.SID).Update("refresh_hash", strings.Repeat("1", 64)).Error)
		_, _, _, err = service.ExchangeDesktopAuthorization(flow.ID, verifier, "127.0.0.1", "fixture")
		require.ErrorIs(t, err, model.ErrDesktopFlowInvalid)
	})

	t.Run("recharge requires browser account and live source session", func(t *testing.T) {
		flow, verifier := makeFlow("d", "recharge", &identity)
		_, err := service.InspectDesktopAuthorization(flow.ID, otherIdentity, false)
		require.ErrorIs(t, err, model.ErrDesktopAccountMismatch)
		require.ErrorIs(t, service.ValidateDesktopRecharge(flow.ID, account.Id), model.ErrDesktopAccountMismatch)
		inspected, err := service.InspectDesktopAuthorization(flow.ID, identity, false)
		require.NoError(t, err)
		require.Equal(t, "ready", inspected.Status)
		_, bundle, keys, err := service.ExchangeDesktopAuthorization(flow.ID, verifier, "127.0.0.1", "fixture")
		require.NoError(t, err)
		require.Nil(t, bundle)
		require.Empty(t, keys)
		countKeys(5)
		require.NoError(t, service.ValidateDesktopRecharge(flow.ID, account.Id))
		require.NoError(t, db.Model(&browser).Update("status", model.UserSessionStatusRevoked).Error)
		require.ErrorIs(t, service.ValidateDesktopRecharge(flow.ID, account.Id), model.ErrDesktopFlowInvalid)
		require.NoError(t, db.Model(&browser).Update("status", model.UserSessionStatusActive).Error)

		// Actual recharge entry rejects foreign flow before any payment creation.
		request := httptest.NewRequest(http.MethodPost, "/api/user/pay", strings.NewReader(`{"amount":50,"payment_method":"alipay"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Hamster-Desktop-Flow", flow.ID)
		response := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(response)
		context.Request = request
		context.Set("id", other.Id)
		RequestEpay(context)
		require.Equal(t, http.StatusForbidden, response.Code)
		var result struct {
			Code string `json:"code"`
		}
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
		assert.Equal(t, "DESKTOP_ACCOUNT_MISMATCH", result.Code)
	})

	t.Run("expiry registration binding and cleanup preserve managed keys", func(t *testing.T) {
		flow, _ := makeFlow("e", "connect", nil)
		require.NoError(t, service.ValidateDesktopRegistration(flow.ID))
		require.NoError(t, service.BindDesktopRegistration(flow.ID, account.Id, 1))
		require.ErrorIs(t, service.ValidateDesktopRegistration(flow.ID), model.ErrDesktopFlowInvalid)
		_, err := service.InspectDesktopAuthorization(flow.ID, otherIdentity, true)
		require.ErrorIs(t, err, model.ErrDesktopAccountMismatch)
		require.NoError(t, db.Model(flow).Update("expires_at", time.Now().Add(-25*time.Hour).Unix()).Error)
		_, err = service.InspectDesktopAuthorization(flow.ID, identity, false)
		require.ErrorIs(t, err, model.ErrDesktopFlowInvalid)
		require.NoError(t, model.CleanupDesktopAuthorizations())
		var count int64
		require.NoError(t, db.Model(&model.DesktopAuthorization{}).Where("id = ?", flow.ID).Count(&count).Error)
		require.Zero(t, count)
		countKeys(5)
		var refs int64
		require.NoError(t, db.Model(&model.DesktopManagedKey{}).Where("user_id = ?", account.Id).Count(&refs).Error)
		require.Equal(t, int64(4), refs)
		require.Error(t, db.Create(&model.DesktopManagedKey{UserID: account.Id, Group: "image-standard", TokenID: ordinary.Id}).Error)
	})
	t.Run("local key owner restricts an anonymous connect without granting authentication", func(t *testing.T) {
		verifier := strings.Repeat("f", 43)
		sum := sha256.Sum256([]byte(verifier))
		challenge := base64.RawURLEncoding.EncodeToString(sum[:])
		flow, err := service.StartDesktopAuthorization(challenge, "connect", nil, account.Id)
		require.NoError(t, err)
		require.ErrorIs(t, service.ValidateDesktopRegistration(flow.ID), model.ErrDesktopFlowInvalid)
		_, err = service.InspectDesktopAuthorization(flow.ID, otherIdentity, true)
		require.ErrorIs(t, err, model.ErrDesktopAccountMismatch)
		pending, bundle, keys, err := service.ExchangeDesktopAuthorization(flow.ID, verifier, "127.0.0.1", "fixture")
		require.NoError(t, err)
		require.Equal(t, "pending", pending.Status)
		require.Nil(t, bundle)
		require.Empty(t, keys)
		approved, err := service.InspectDesktopAuthorization(flow.ID, identity, true)
		require.NoError(t, err)
		require.Equal(t, "approved", approved.Status)
		countKeys(5)
	})
}
