package service

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type hamster54Mailer struct{ kinds []string }

func (m *hamster54Mailer) Send(_ context.Context, item *model.PiknoSettlementOutbox) error {
	m.kinds = append(m.kinds, item.Kind)
	return nil
}

func TestHamster54ConsumptionMailDisabled(t *testing.T) {
	old := model.DB
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "mail.db")), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	t.Cleanup(func() { model.DB = old; sqlDB, _ := db.DB(); _ = sqlDB.Close() })
	require.NoError(t, db.AutoMigrate(&model.PiknoSettlementOutbox{}))
	now := common.GetTimestamp()
	for i := 1; i <= 25; i++ {
		row := model.PiknoSettlementOutbox{EventID: int64(i), Kind: "customer_status", Payload: `{"order_id":"synthetic"}`, Recipient: "customer@example.invalid"}
		require.NoError(t, db.Create(&row).Error)
	}
	admin := model.PiknoSettlementOutbox{EventID: 26, Kind: "admin_review_reminder", Recipient: "admin@example.invalid"}
	require.NoError(t, db.Create(&admin).Error)
	var before []model.PiknoSettlementOutbox
	require.NoError(t, db.Where("kind = ?", "customer_status").Order("id").Find(&before).Error)
	mailer := &hamster54Mailer{}
	require.NoError(t, DeliverPiknoSettlementMail(context.Background(), mailer, now))
	require.Equal(t, []string{"admin_review_reminder"}, mailer.kinds, "disabled records must not starve administrator mail")
	var after []model.PiknoSettlementOutbox
	require.NoError(t, db.Where("kind = ?", "customer_status").Order("id").Find(&after).Error)
	require.Equal(t, before, after, "no claim, fabricated sent state or deletion for disabled consumption mail")
	var saved model.PiknoSettlementOutbox
	require.NoError(t, db.First(&saved, admin.ID).Error)
	require.Equal(t, "sent", saved.DeliveryState)
	require.NoError(t, DeliverPiknoSettlementMail(context.Background(), mailer, now+60))
	require.Len(t, mailer.kinds, 1)
	require.ErrorContains(t, (PiknoResendMailer{}).Send(context.Background(), &before[0]), "consumption emails are disabled")
}
