package controller

import (
    "fmt"
    "net/http"
    "net/http/httptest"
    "os"
    "reflect"
    "strings"
    "testing"

    "github.com/QuantumNous/new-api/common"
    "github.com/QuantumNous/new-api/model"
    "github.com/QuantumNous/new-api/setting/operation_setting"
    "github.com/gin-gonic/gin"
    "github.com/glebarez/sqlite"
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
    sqlDB.SetMaxOpenConns(1)
    t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
    model.DB, model.LOG_DB = db, db
    common.SetMainDatabaseType(dbType)
    common.SetLogDatabaseType(dbType)
    require.NoError(t, db.AutoMigrate(&model.User{}, &model.Log{}))
    require.NoError(t, db.Create(&model.User{Id: 42, Username: "fixed_cny_test", Quota: 0, Status: common.UserStatusEnabled}).Error)

    // Start with the exact released TopUp fields, then prove the additive
    // migration preserves an existing pending legacy order on both startups.
    var fields []reflect.StructField
    typ := reflect.TypeOf(model.TopUp{})
    for i := 0; i < typ.NumField(); i++ {
        if field := typ.Field(i); field.Name != "CreditedQuota" { fields = append(fields, field) }
    }
    legacy := reflect.New(reflect.StructOf(fields)).Interface()
    require.NoError(t, db.Table("top_ups").AutoMigrate(legacy))
    require.NoError(t, db.Table("top_ups").Create(map[string]any{
        "user_id": 42, "amount": 1, "money": 7.3, "trade_no": "USR42NOLEGACY",
        "payment_method": "alipay", "payment_provider": model.PaymentProviderEpay,
        "status": common.TopUpStatusPending,
    }).Error)
    for range 2 { require.NoError(t, db.AutoMigrate(&model.TopUp{})) }
    legacyOrder := model.GetTopUpByTradeNo("USR42NOLEGACY")
    require.NotNil(t, legacyOrder)
    assert.Nil(t, legacyOrder.CreditedQuota)
    assert.Equal(t, int64(1), legacyOrder.Amount)

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
