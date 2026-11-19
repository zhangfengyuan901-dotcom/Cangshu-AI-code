package model

import (
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func TestPiknoLLMArkPriceSnapshot(t *testing.T) {
	for _, dialect := range []common.DatabaseType{common.DatabaseTypeSQLite, common.DatabaseTypeMySQL, common.DatabaseTypePostgreSQL} {
		t.Run(string(dialect), func(t *testing.T) {
			var driver gorm.Dialector
			switch dialect {
			case common.DatabaseTypeSQLite:
				driver = sqlite.Open(":memory:")
			case common.DatabaseTypeMySQL:
				dsn := os.Getenv("TEST_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_MYSQL_DSN not configured")
				}
				driver = mysql.Open(dsn)
			case common.DatabaseTypePostgreSQL:
				dsn := os.Getenv("TEST_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_POSTGRES_DSN not configured")
				}
				driver = postgres.Open(dsn)
			}
			db, err := gorm.Open(driver, &gorm.Config{NamingStrategy: schema.NamingStrategy{TablePrefix: "llm_price_test_"}})
			require.NoError(t, err)
			pool, err := db.DB()
			require.NoError(t, err)
			pool.SetMaxOpenConns(1)
			previousDB, previousType := DB, common.MainDatabaseType()
			DB = db
			common.SetMainDatabaseType(dialect)
			t.Cleanup(func() {
				DB = previousDB
				common.SetMainDatabaseType(previousType)
				assert.NoError(t, db.Migrator().DropTable(&PiknoLLMRequest{}, &Token{}, &User{}))
				assert.NoError(t, pool.Close())
			})
			require.NoError(t, db.AutoMigrate(&User{}, &Token{}, &PiknoLLMRequest{}))

			user := User{Username: "llm_price_fixture", Status: common.UserStatusEnabled, Quota: 1000}
			require.NoError(t, db.Create(&user).Error)
			token := Token{UserId: user.Id, Group: PiknoLLMGroup, Key: "llm-price-fixture", Status: common.TokenStatusEnabled,
				RemainQuota: 1000, ModelLimitsEnabled: true, ModelLimits: PiknoLLMModel}
			require.NoError(t, db.Create(&token).Error)
			legacyID, arkID, digest := strings.Repeat("a", 32), strings.Repeat("b", 32), strings.Repeat("e", 64)
			_, _, err = ReservePiknoLLM(user.Id, token.Id, arkID, digest, PiknoLLMArkPriceVersion, 10)
			require.ErrorIs(t, err, ErrPiknoLLMPermission)

			legacy, created, err := ReservePiknoLLM(user.Id, token.Id, legacyID, digest, PiknoLLMPriceVersion, 10)
			require.NoError(t, err)
			require.True(t, created)
			require.NoError(t, DispatchPiknoLLM(user.Id, legacyID))
			_, err = FinishPiknoLLM(user.Id, legacyID, "unknown", 0, 0)
			require.NoError(t, err)
			_, _, err = ReservePiknoLLM(user.Id, token.Id, legacyID, digest, PiknoLLMArkPriceVersion, 10)
			require.ErrorIs(t, err, ErrPiknoLLMConflict)

			require.NoError(t, db.Model(&token).Update("model_limits", PiknoLLMArkModel).Error)
			_, _, err = ReservePiknoLLM(user.Id, token.Id, arkID, digest, PiknoLLMArkPriceVersion, 10)
			require.ErrorIs(t, err, ErrPiknoLLMBusy)
			now := common.GetTimestamp()
			cooldownComplete := now - PiknoLLMUnknownReviewCooldownSeconds
			require.NoError(t, db.Model(legacy).Updates(map[string]any{"created_at": cooldownComplete - 1, "updated_at": cooldownComplete}).Error)
			ark, created, err := ReservePiknoLLM(user.Id, token.Id, arkID, digest, PiknoLLMArkPriceVersion, 10)
			require.NoError(t, err)
			require.True(t, created)
			assert.Equal(t, PiknoLLMArkModel, ark.CustomerView().Model)
			assert.Equal(t, PiknoLLMArkPriceVersion, ark.CustomerView().PriceVersion)
			require.NoError(t, DispatchPiknoLLM(user.Id, arkID))
			_, err = FinishPiknoLLM(user.Id, arkID, "usage", 10, 2, 11)
			require.Error(t, err)
			ark, err = FinishPiknoLLM(user.Id, arkID, "unknown", 0, 0)
			require.NoError(t, err)
			assert.True(t, ark.AdmissionBlocking(ark.UpdatedAt))
			assert.False(t, ark.AdmissionBlocking(ark.UpdatedAt+PiknoLLMUnknownReviewCooldownSeconds))
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, 1000, user.Quota)

			for _, billing := range []struct {
				id     string
				charge int
			}{{legacyID, 180}, {arkID, 504}} {
				for range 2 {
					request, err := FinishPiknoLLM(user.Id, billing.id, "usage", 10, 2, 4)
					require.NoError(t, err)
					assert.Equal(t, billing.charge, request.CustomerView().ChargedQuota)
					assert.Equal(t, &PiknoLLMUsageView{InputTokens: 10, OutputTokens: 2, CachedTokens: 4}, request.CustomerView().Usage)
				}
			}
			require.NoError(t, db.First(&user, user.Id).Error)
			require.NoError(t, db.First(&token, token.Id).Error)
			assert.Equal(t, 316, user.Quota)
			assert.Equal(t, 684, user.UsedQuota)
			assert.Equal(t, 316, token.RemainQuota)
			assert.Equal(t, 684, token.UsedQuota)
		})
	}
}
