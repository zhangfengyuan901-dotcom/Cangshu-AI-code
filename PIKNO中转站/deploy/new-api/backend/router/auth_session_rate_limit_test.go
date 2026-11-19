package router

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// Use the production in-memory limiter and real API registration. No valid
// credentials are submitted and no database or external service is required.
func sessionRateLimitRouter(t *testing.T, globalLimit int) *gin.Engine {
	t.Helper()
	t.Setenv("AUTH_CHALLENGE_PROVIDER", "turnstile")
	previousRedis := common.RedisEnabled
	previousGlobal, previousGlobalLimit, previousGlobalDuration := common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration
	previousCritical, previousCriticalLimit, previousCriticalDuration := common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	previousSecure, previousTrusted := common.SessionCookieSecure, common.SessionCookieTrustedURLs
	previousTurnstile := common.TurnstileCheckEnabled
	common.RedisEnabled = false
	common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration = true, globalLimit, 180
	common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = true, 20, 1200
	common.SessionCookieSecure, common.SessionCookieTrustedURLs = true, nil
	common.TurnstileCheckEnabled = false
	t.Cleanup(func() {
		common.RedisEnabled = previousRedis
		common.GlobalApiRateLimitEnable, common.GlobalApiRateLimitNum, common.GlobalApiRateLimitDuration = previousGlobal, previousGlobalLimit, previousGlobalDuration
		common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = previousCritical, previousCriticalLimit, previousCriticalDuration
		common.SessionCookieSecure, common.SessionCookieTrustedURLs = previousSecure, previousTrusted
		common.TurnstileCheckEnabled = previousTurnstile
	})
	require.NoError(t, i18n.Init())
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	require.NoError(t, engine.SetTrustedProxies(nil))
	SetApiRouter(engine)
	return engine
}

func TestSessionRefreshAndLogoutDoNotConsumeOrShareCriticalBudget(t *testing.T) {
	engine := sessionRateLimitRouter(t, 360)
	send := func(path, origin, cookie string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "https://panel.example.com"+path, strings.NewReader("{}"))
		request.RemoteAddr = "192.0.2.156:12345"
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		if cookie != "" {
			request.AddCookie(&http.Cookie{Name: service.RefreshCookieName, Value: cookie})
		}
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		return response
	}
	const sameOrigin = "https://panel.example.com"
	// More than the old shared budget remains usable and does not consume the
	// 20 login attempts. Missing refresh credentials still fail authentication.
	for range 21 {
		refresh := send("/api/user/auth/refresh", sameOrigin, "")
		require.Equal(t, http.StatusUnauthorized, refresh.Code, refresh.Body.String())
		require.Contains(t, refresh.Header().Get("Cache-Control"), "no-store")
		require.Empty(t, refresh.Header().Get("Retry-After"))
		logout := send("/api/user/auth/logout", sameOrigin, "")
		require.Equal(t, http.StatusOK, logout.Code, logout.Body.String())
		require.Contains(t, logout.Header().Get("Cache-Control"), "no-store")
	}
	for range 20 {
		login := send("/api/user/login", sameOrigin, "")
		require.Equal(t, http.StatusOK, login.Code, login.Body.String())
		require.Contains(t, login.Body.String(), `"success":false`)
	}
	// Login and registration keep their original shared sensitive-operation
	// rejection, while session refresh/logout still reach their real handlers.
	for _, path := range []string{"/api/user/login", "/api/user/register", "/api/user/login/2fa"} {
		limited := send(path, sameOrigin, "")
		assert.Equal(t, http.StatusTooManyRequests, limited.Code, path)
		assert.Equal(t, "1200", limited.Header().Get("Retry-After"), path)
	}
	refresh := send("/api/user/auth/refresh", sameOrigin, "synthetic-invalid-refresh")
	assert.Equal(t, http.StatusUnauthorized, refresh.Code, refresh.Body.String())
	assert.Contains(t, refresh.Body.String(), `"code":"AUTH_UNAUTHORIZED"`)
	assert.NotContains(t, refresh.Body.String(), "access_token")
	assert.Empty(t, refresh.Header().Get("Retry-After"))
	logout := send("/api/user/auth/logout", sameOrigin, "")
	assert.Equal(t, http.StatusOK, logout.Code, logout.Body.String())
	assert.Contains(t, logout.Body.String(), `"success":true`)
	for _, path := range []string{"/api/user/auth/refresh", "/api/user/auth/logout"} {
		for _, origin := range []string{"https://evil.invalid", ""} {
			forbidden := send(path, origin, "")
			assert.Equal(t, http.StatusForbidden, forbidden.Code, path)
			assert.Contains(t, forbidden.Body.String(), `"code":"AUTH_ORIGIN_FORBIDDEN"`)
		}
	}
}

func TestSessionRefreshAndLogoutKeepGlobalAPIBudget(t *testing.T) {
	engine := sessionRateLimitRouter(t, 2)
	for index, path := range []string{"/api/user/auth/refresh", "/api/user/auth/logout"} {
		t.Run(path, func(t *testing.T) {
			expected := http.StatusUnauthorized
			if strings.HasSuffix(path, "/logout") {
				expected = http.StatusOK
			}
			for attempt := range 3 {
				request := httptest.NewRequest(http.MethodPost, "https://panel.example.com"+path, nil)
				request.RemoteAddr = []string{"192.0.2.157:12345", "192.0.2.158:12345"}[index]
				request.Header.Set("Origin", "https://panel.example.com")
				response := httptest.NewRecorder()
				engine.ServeHTTP(response, request)
				if attempt < 2 {
					require.Equal(t, expected, response.Code, response.Body.String())
				} else {
					assert.Equal(t, http.StatusTooManyRequests, response.Code)
					assert.Equal(t, "180", response.Header().Get("Retry-After"))
				}
			}
		})
	}
}

func TestEpayRechargeDoesNotConsumeOrShareCriticalBudget(t *testing.T) {
	t.Setenv("PIKNO_FIXED_CNY_TOPUP", "true")
	t.Setenv("LOG_SQL_DSN", "")
	engine := sessionRateLimitRouter(t, 360)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "recharge-router.db")), &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	previousDB, previousLogDB, previousSecret, previousMaster := model.DB, model.LOG_DB, common.SessionSecret, common.IsMasterNode
	previousDBType := common.MainDatabaseType()
	previousLogDBType := common.LogDatabaseType()
	previousQuota, previousRate := common.QuotaPerUnit, operation_setting.USDExchangeRate
	previousDisplay := operation_setting.GetGeneralSetting().QuotaDisplayType
	previousAddress, previousID, previousKey := operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey
	previousMethods := operation_setting.PayMethods
	model.DB, common.SessionSecret = db, "synthetic-recharge-router-secret"
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.IsMasterNode = false
	common.QuotaPerUnit, operation_setting.USDExchangeRate = 7_300_000, 7.3
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeCNY
	operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey = "https://payment.invalid", "synthetic-merchant", "synthetic-payment-key"
	operation_setting.PayMethods = []map[string]string{{"type": "alipay"}, {"type": "wxpay"}}
	t.Cleanup(func() {
		model.DB, model.LOG_DB, common.SessionSecret, common.IsMasterNode = previousDB, previousLogDB, previousSecret, previousMaster
		common.SetMainDatabaseType(previousDBType)
		common.SetLogDatabaseType(previousLogDBType)
		common.QuotaPerUnit, operation_setting.USDExchangeRate = previousQuota, previousRate
		operation_setting.GetGeneralSetting().QuotaDisplayType = previousDisplay
		operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey = previousAddress, previousID, previousKey
		operation_setting.PayMethods = previousMethods
		require.NoError(t, sqlDB.Close())
	})
	// Initialize the production dialect column references against this fixture.
	require.NoError(t, model.InitLogDB())
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.TopUp{}))
	user := &model.User{Username: "recharge-router-user", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1}
	require.NoError(t, db.Create(user).Error)
	bundle, err := service.CreateLoginSession(user.Id, "password", "192.0.2.159", "recharge-router-test")
	require.NoError(t, err)
	send := func(target *gin.Engine, path, body, accessToken, address string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "https://panel.example.com"+path, strings.NewReader(body))
		request.RemoteAddr = address
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "https://panel.example.com")
		if accessToken != "" {
			request.Header.Set("Authorization", "Bearer "+accessToken)
		}
		response := httptest.NewRecorder()
		target.ServeHTTP(response, request)
		return response
	}
	const address = "192.0.2.159:12345"
	orders := make(map[string]bool)
	createOrder := func(method string) {
		response := send(engine, "/api/user/pay", `{"amount":50,"payment_method":"`+method+`"}`, bundle.AccessToken, address)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		require.Empty(t, response.Header().Get("Retry-After"))
		require.Contains(t, response.Header().Get("Cache-Control"), "no-store")
		var body struct {
			Message string            `json:"message"`
			Data    map[string]string `json:"data"`
			URL     string            `json:"url"`
		}
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
		require.Equal(t, "success", body.Message)
		assert.Equal(t, "https://payment.invalid/submit.php", body.URL)
		assert.Equal(t, "50.00", body.Data["money"])
		assert.Equal(t, method, body.Data["type"])
		tradeNo := body.Data["out_trade_no"]
		require.NotEmpty(t, tradeNo)
		require.False(t, orders[tradeNo], "a new recharge must have an independent order")
		orders[tradeNo] = true
		// Purchase only produces signed parameters; no payment gateway is called.
		verified, err := controller.GetEpayClient().Verify(body.Data)
		require.NoError(t, err)
		assert.True(t, verified.VerifyStatus)
	}
	// Crossing the old 20-operation boundary neither blocks recharge nor uses
	// any of the separate login/registration/redemption protection budget.
	for range 21 {
		createOrder("alipay")
	}
	for range 20 {
		response := send(engine, "/api/user/login", "{}", "", address)
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		require.Contains(t, response.Body.String(), `"success":false`)
	}
	for _, path := range []string{"/api/user/login", "/api/user/register", "/api/user/topup", "/api/user/stripe/pay", "/api/user/creem/pay", "/api/user/waffo/pay", "/api/user/waffo-pancake/pay"} {
		response := send(engine, path, "{}", bundle.AccessToken, address)
		assert.Equal(t, http.StatusTooManyRequests, response.Code, path)
		assert.Equal(t, "1200", response.Header().Get("Retry-After"), path)
	}
	createOrder("alipay")
	createOrder("wxpay")

	t.Run("authorization and amount validation remain", func(t *testing.T) {
		response := send(engine, "/api/user/pay", `{"amount":50,"payment_method":"alipay"}`, "", address)
		assert.Equal(t, http.StatusUnauthorized, response.Code)
		assert.Empty(t, response.Header().Get("Retry-After"))
		for _, body := range []string{`{"amount":1,"payment_method":"alipay"}`, `{"amount":50,"payment_method":"unsupported"}`, `{"amount":50.5,"payment_method":"alipay"}`} {
			response := send(engine, "/api/user/pay", body, bundle.AccessToken, address)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			assert.Contains(t, response.Body.String(), `"message":"error"`)
		}
	})

	t.Run("global API budget remains", func(t *testing.T) {
		limitedEngine := sessionRateLimitRouter(t, 2)
		for attempt := range 3 {
			response := send(limitedEngine, "/api/user/pay", "{", bundle.AccessToken, "192.0.2.160:12345")
			if attempt < 2 {
				require.Equal(t, http.StatusOK, response.Code, response.Body.String())
				assert.Contains(t, response.Body.String(), `"message":"error"`)
			} else {
				assert.Equal(t, http.StatusTooManyRequests, response.Code)
				assert.Equal(t, "180", response.Header().Get("Retry-After"))
			}
		}
	})

	var storedOrders []model.TopUp
	require.NoError(t, db.Order("id").Find(&storedOrders).Error)
	require.Len(t, storedOrders, 23)
	for _, order := range storedOrders {
		assert.True(t, orders[order.TradeNo])
		assert.Equal(t, user.Id, order.UserId)
		assert.Equal(t, common.TopUpStatusPending, order.Status)
		assert.Equal(t, model.PaymentProviderEpay, order.PaymentProvider)
		require.NotNil(t, order.CreditedQuota)
		assert.Equal(t, int64(50_000_000), *order.CreditedQuota)
	}
	require.NoError(t, db.First(user, user.Id).Error)
	assert.Zero(t, user.Quota, "creating a checkout does not credit the wallet")
}
