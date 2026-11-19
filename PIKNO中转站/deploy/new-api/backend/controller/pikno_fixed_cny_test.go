package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/shopspring/decimal"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// Run once per real database engine in an isolated, disposable test database.
func TestPiknoFixedCNY(t *testing.T) {
	t.Setenv("PIKNO_FIXED_CNY_TOPUP", "true")
	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldRedis := common.RedisEnabled
	common.RedisEnabled = false
	oldDBType := common.MainDatabaseType()
	oldLogType := common.LogDatabaseType()
	oldQuota, oldRate := common.QuotaPerUnit, operation_setting.USDExchangeRate
	oldDisplay := operation_setting.GetGeneralSetting().QuotaDisplayType
	common.QuotaPerUnit, operation_setting.USDExchangeRate = 7_300_000, 7.3
	operation_setting.GetGeneralSetting().QuotaDisplayType = operation_setting.QuotaDisplayTypeCNY
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLogDB
		common.RedisEnabled = oldRedis
		common.SetMainDatabaseType(oldDBType)
		common.SetLogDatabaseType(oldLogType)
		common.QuotaPerUnit, operation_setting.USDExchangeRate = oldQuota, oldRate
		operation_setting.GetGeneralSetting().QuotaDisplayType = oldDisplay
	})
	var dialector gorm.Dialector = sqlite.Open(":memory:")
	dbType := common.DatabaseTypeSQLite
	switch os.Getenv("PIKNO_TEST_DB_ENGINE") {
	case "postgres":
		dialector = postgres.Open(os.Getenv("PIKNO_TEST_DB_DSN"))
		dbType = common.DatabaseTypePostgreSQL
	case "mysql":
		dialector = mysql.Open(os.Getenv("PIKNO_TEST_DB_DSN"))
		dbType = common.DatabaseTypeMySQL
	}
	db, err := gorm.Open(dialector, &gorm.Config{})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	if dbType == common.DatabaseTypeSQLite {
		sqlDB.SetMaxOpenConns(1)
	} else {
		sqlDB.SetMaxOpenConns(4)
	}
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	model.DB, model.LOG_DB = db, db
	common.SetMainDatabaseType(dbType)
	common.SetLogDatabaseType(dbType)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Log{}))
	require.NoError(t, db.Create(&model.User{Id: 42, Username: "fixed_cny_test", Quota: 0, Status: common.UserStatusEnabled}).Error)

	t.Run("fresh payment schema", func(t *testing.T) {
		for range 2 {
			require.NoError(t, db.AutoMigrate(&model.TopUp{}))
		}
		order := model.TopUp{UserId: 42, TradeNo: "USR42NOFRESH", PaymentProvider: model.PaymentProviderEpay}
		require.NoError(t, order.Insert())
		order.Id = 0
		require.Error(t, order.Insert())
		require.NoError(t, db.Migrator().DropTable(&model.TopUp{}))
	})

	// Start with the exact released TopUp fields, then prove the additive
	// migration preserves an existing pending legacy order on both startups.
	var fields []reflect.StructField
	typ := reflect.TypeOf(model.TopUp{})
	for i := 0; i < typ.NumField(); i++ {
		if field := typ.Field(i); !strings.HasPrefix(field.Name, "Epay") {
			fields = append(fields, field)
		}
	}
	legacy := reflect.New(reflect.StructOf(fields)).Interface()
	require.NoError(t, db.Table("top_ups").AutoMigrate(legacy))
	require.NoError(t, db.Table("top_ups").Create(map[string]any{
		"user_id": 42, "amount": 1, "money": 7.3, "trade_no": "USR42NOLEGACY",
		"payment_method": "alipay", "payment_provider": model.PaymentProviderEpay,
		"status": common.TopUpStatusPending,
	}).Error)
	for range 2 {
		require.NoError(t, db.AutoMigrate(&model.TopUp{}))
	}
	legacyOrder := model.GetTopUpByTradeNo("USR42NOLEGACY")
	require.NotNil(t, legacyOrder)
	assert.Nil(t, legacyOrder.CreditedQuota)
	assert.Equal(t, int64(1), legacyOrder.Amount)
	assert.Nil(t, legacyOrder.EpayClaimedAt)

	t.Run("checkout resume signs only the same eligible order without inserting", func(t *testing.T) {
		payment := operation_setting.GetPaymentSetting()
		previousSetting := *payment
		address, id, key, methods := operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey, operation_setting.PayMethods
		t.Cleanup(func() {
			*payment = previousSetting
			operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey, operation_setting.PayMethods = address, id, key, methods
		})
		payment.ComplianceConfirmed, payment.ComplianceTermsVersion = true, operation_setting.CurrentComplianceTermsVersion
		operation_setting.PayAddress, operation_setting.EpayId, operation_setting.EpayKey = "https://account.test/pay/lanjing/epay", "1", "fixture"
		operation_setting.PayMethods = []map[string]string{{"type": "alipay"}}
		unclaimed := int64(0)
		order := model.TopUp{UserId: 42, Amount: 50, Money: 50, TradeNo: "USR42NORESUME",
			PaymentMethod: "alipay", PaymentProvider: model.PaymentProviderEpay, Status: common.TopUpStatusPending, EpayClaimedAt: &unclaimed}
		require.NoError(t, order.Insert())
		resume := func(user int, trade string) bool {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Set("id", user)
			c.Request = httptest.NewRequest(http.MethodPost, "/api/user/topup/checkout", strings.NewReader(fmt.Sprintf(`{"trade_no":%q}`, trade)))
			c.Request.Header.Set("Content-Type", "application/json")
			EpayResumeCheckout(c)
			var response struct {
				Message string            `json:"message"`
				TradeNo string            `json:"trade_no"`
				Data    map[string]string `json:"data"`
			}
			require.NoError(t, common.Unmarshal(w.Body.Bytes(), &response))
			if response.Message != "success" {
				return false
			}
			require.Equal(t, trade, response.TradeNo)
			require.Equal(t, trade, response.Data["out_trade_no"])
			require.Equal(t, "50.00", response.Data["money"])
			return true
		}
		assert.True(t, resume(42, order.TradeNo))
		assert.False(t, resume(41, order.TradeNo))
		assert.False(t, resume(42, legacyOrder.TradeNo))
		_, claimed, err := model.ClaimLanjingCheckout(order.TradeNo, "alipay", decimal.NewFromInt(50))
		require.NoError(t, err)
		require.True(t, claimed)
		assert.False(t, resume(42, order.TradeNo))
		_, err = model.BindLanjingCheckout(order.TradeNo, "alipay", decimal.NewFromInt(50), "fixture-resume", "50.00")
		require.NoError(t, err)
		assert.True(t, resume(42, order.TradeNo))
		_, err = model.BeginLanjingCancellation(42, order.TradeNo)
		require.NoError(t, err)
		assert.False(t, resume(42, order.TradeNo))
		observed := "provider_order_missing"
		reads := 0
		mockBridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "/pay/lanjing/internal/lookup", r.URL.Path)
			reads++
			fmt.Fprintf(w, `{"status":%q}`, observed)
		}))
		defer mockBridge.Close()
		t.Setenv("PIKNO_LANJING_BRIDGE_INTERNAL_URL", mockBridge.URL)
		status := func(id int, tradeNo string) bool {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Set("id", id)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/user/topup/status?trade_no="+tradeNo, nil)
			EpayOrderStatus(c)
			var v struct {
				Data struct {
					Separate bool `json:"separate_payment_allowed"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(w.Body.Bytes(), &v))
			return v.Data.Separate
		}
		assert.True(t, status(42, order.TradeNo))
		assert.False(t, status(41, order.TradeNo))
		assert.False(t, status(42, legacyOrder.TradeNo))
		observed = "processing"
		assert.False(t, status(42, order.TradeNo))
		assert.Equal(t, 2, reads)
		unchanged, err := model.GetUserEpayTopUp(42, order.TradeNo)
		require.NoError(t, err)
		assert.Equal(t, common.TopUpStatusClosing, unchanged.Status)
		var count int64
		require.NoError(t, db.Model(&model.TopUp{}).Where("trade_no = ?", order.TradeNo).Count(&count).Error)
		assert.Equal(t, int64(1), count)
	})

	t.Run("managed checkout closure and late payment", func(t *testing.T) {
		unclaimed, credit := int64(0), int64(50_000_000)
		newOrder := func(tradeNo string) model.TopUp {
			order := model.TopUp{UserId: 42, Amount: 50, Money: 50, CreditedQuota: &credit, TradeNo: tradeNo,
				PaymentMethod: "alipay", PaymentProvider: model.PaymentProviderEpay, Status: common.TopUpStatusPending, EpayClaimedAt: &unclaimed}
			require.NoError(t, order.Insert())
			return order
		}
		early := newOrder("USR42NOEARLYCANCEL")
		_, err := model.BeginLanjingCancellation(7, early.TradeNo)
		require.ErrorIs(t, err, model.ErrTopUpNotFound)
		closed, err := model.BeginLanjingCancellation(42, early.TradeNo)
		require.NoError(t, err)
		require.Equal(t, common.TopUpStatusCancelled, closed.Status)
		amount := decimal.NewFromInt(50)
		_, created, err := model.ClaimLanjingCheckout(early.TradeNo, "alipay", amount)
		require.NoError(t, err)
		require.False(t, created)

		pending := newOrder("USR42NOPAIDRACE")
		_, created, err = model.ClaimLanjingCheckout(pending.TradeNo, "alipay", amount)
		require.NoError(t, err)
		require.True(t, created)
		_, created, err = model.ClaimLanjingCheckout(pending.TradeNo, "alipay", amount)
		require.NoError(t, err)
		require.False(t, created)
		bound, err := model.BindLanjingCheckout(pending.TradeNo, "alipay", amount, "fixture-cloud-1", "50.01")
		require.NoError(t, err)
		_, err = model.BindLanjingCheckout(pending.TradeNo, "alipay", amount, "fixture-cloud-2", "50.01")
		require.ErrorIs(t, err, model.ErrTopUpStatusInvalid)
		closing, err := model.BeginLanjingCancellation(42, pending.TradeNo)
		require.NoError(t, err)
		require.Equal(t, common.TopUpStatusClosing, closing.Status)
		require.NoError(t, model.RecordLanjingTerminalState(bound, common.TopUpStatusCancelled))
		_, err = model.RechargeVerifiedEpay(pending.TradeNo, "alipay", "127.0.0.1", amount, "50.02")
		require.ErrorIs(t, err, model.ErrTopUpAmountMismatch)
		_, err = model.RechargeVerifiedEpay(pending.TradeNo, "wxpay", "127.0.0.1", amount, "50.01")
		require.ErrorIs(t, err, model.ErrPaymentMethodMismatch)
		type creditResult struct {
			already bool
			err     error
		}
		results := make(chan creditResult, 2)
		for range 2 {
			go func() {
				already, err := model.RechargeVerifiedEpay(pending.TradeNo, "alipay", "127.0.0.1", amount, "50.01")
				results <- creditResult{already, err}
			}()
		}
		first, second := <-results, <-results
		require.NoError(t, first.err)
		require.NoError(t, second.err)
		require.NotEqual(t, first.already, second.already)
		require.NoError(t, model.RecordLanjingTerminalState(bound, common.TopUpStatusCancelled))
		require.Equal(t, common.TopUpStatusSuccess, model.GetTopUpByTradeNo(pending.TradeNo).Status)
		var account model.User
		require.NoError(t, db.First(&account, 42).Error)
		require.Equal(t, 50_000_000, account.Quota)
		require.NoError(t, db.Model(&account).Update("quota", 0).Error)
	})

	t.Run("checkout signature retains the released form shape", func(t *testing.T) {
		oldKey := operation_setting.EpayKey
		t.Cleanup(func() { operation_setting.EpayKey = oldKey })
		operation_setting.EpayKey = "fixture-epay"
		form := epay.GenerateParams(map[string]string{"pid": "1", "type": "alipay", "money": "50.00"}, lanjingCheckoutKey())
		assert.NotContains(t, form, "param")
		assert.Equal(t, "MD5", form["sign_type"])
		assert.Equal(t, "811a3ce7fd5232eaeaa8cc1bd7c1a177", form["sign"])
	})

	for _, amount := range []int64{50, 100, 200} {
		quota, err := piknoFixedCNYQuota(amount)
		require.NoError(t, err)
		assert.Equal(t, amount*1_000_000, quota)
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set("id", 42)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/user/amount", strings.NewReader(fmt.Sprintf(`{"amount":%d}`, amount)))
		c.Request.Header.Set("Content-Type", "application/json")
		RequestAmount(c)
		assert.JSONEq(t, fmt.Sprintf(`{"message":"success","data":"%d.00"}`, amount), w.Body.String())
	}
	for _, body := range []string{`{"amount":1}`, `{"amount":51}`, `{"amount":50.5}`, `{"amount":-50}`, `{"amount":99999999999999999999}`} {
		for _, handler := range []gin.HandlerFunc{RequestAmount, RequestEpay} {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Set("id", 42)
			c.Request = httptest.NewRequest(http.MethodPost, "/api/user/pay", strings.NewReader(body))
			c.Request.Header.Set("Content-Type", "application/json")
			handler(c)
			assert.Contains(t, w.Body.String(), `"message":"error"`)
		}
	}
	quota := int64(50_000_000)
	order := model.TopUp{UserId: 42, Amount: 50, Money: 50, CreditedQuota: &quota, TradeNo: "USR42NOFIXED", PaymentMethod: "alipay", PaymentProvider: model.PaymentProviderEpay, Status: common.TopUpStatusPending}
	require.NoError(t, order.Insert())
	done, err := model.RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
	require.NoError(t, err)
	assert.False(t, done)
	done, err = model.RechargeEpay(order.TradeNo, "alipay", "127.0.0.1")
	require.NoError(t, err)
	assert.True(t, done)
	var user model.User
	require.NoError(t, db.First(&user, 42).Error)
	assert.Equal(t, 50_000_000, user.Quota)
	_, err = model.RechargeEpay("USR42NOLEGACY", "alipay", "127.0.0.1")
	require.NoError(t, err)
	require.NoError(t, db.First(&user, 42).Error)
	assert.Equal(t, 57_300_000, user.Quota)
	order.Id, order.TradeNo, order.Status = 0, "USR42NOMANUAL", common.TopUpStatusPending
	require.NoError(t, order.Insert())
	require.NoError(t, model.ManualCompleteTopUp(order.TradeNo, "127.0.0.1"))
	require.NoError(t, model.ManualCompleteTopUp(order.TradeNo, "127.0.0.1"))
	require.NoError(t, db.First(&user, 42).Error)
	assert.Equal(t, 107_300_000, user.Quota)

	common.QuotaPerUnit = 500_000
	_, err = piknoFixedCNYQuota(50)
	require.Error(t, err)
}
