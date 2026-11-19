package model

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Each matrix run uses its own disposable database, never production. Legacy
// tables are created using the released source models BEFORE new migrations.
func TestPiknoSettlement(t *testing.T) {
	oldDB := DB
	driver := os.Getenv("PIKNO_SETTLEMENT_TEST_DRIVER")
	var dialector gorm.Dialector
	switch driver {
	case "mysql":
		dialector = mysql.Open(os.Getenv("PIKNO_SETTLEMENT_TEST_DSN"))
		common.SetDatabaseTypes(common.DatabaseTypeMySQL, common.DatabaseTypeMySQL)
	case "postgres":
		dialector = postgres.Open(os.Getenv("PIKNO_SETTLEMENT_TEST_DSN"))
		common.SetDatabaseTypes(common.DatabaseTypePostgreSQL, common.DatabaseTypePostgreSQL)
	default:
		driver = "sqlite"
		dialector = sqlite.Open(filepath.Join(t.TempDir(), "ledger.db"))
		common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	}
	db, err := gorm.Open(dialector, &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	require.NoError(t, err)
	DB = db
	sqlDB, err := DB.DB()
	require.NoError(t, err)
	if driver == "sqlite" {
		sqlDB.SetMaxOpenConns(1)
	}
	t.Cleanup(func() {
		require.NoError(t, sqlDB.Close())
		DB = oldDB
		common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	})
	initCol()
	var version string
	if driver == "sqlite" {
		require.NoError(t, DB.Raw("select sqlite_version()").Scan(&version).Error)
	} else {
		require.NoError(t, DB.Raw("select version()").Scan(&version).Error)
	}
	t.Logf("database=%s version=%s", driver, version)
	require.NoError(t, DB.AutoMigrate(&User{}, &Token{}, &Channel{}, &Task{}))
	legacy := User{Username: "preserved_legacy", AffCode: "legacy", Password: "test-only", Status: 1, Quota: 123456, UsedQuota: 654321}
	require.NoError(t, DB.Create(&legacy).Error)
	// Representative phase-15 queue schema (before delivery columns existed).
	oldOutbox := struct {
		ID          int64  `gorm:"primaryKey"`
		EventID     int64  `gorm:"uniqueIndex"`
		UserID      int    `gorm:"index"`
		Kind        string `gorm:"size:32"`
		Payload     string `gorm:"type:text"`
		DeliveredAt int64
		CreatedAt   int64
	}{EventID: 900000, UserID: legacy.Id, Kind: "customer_status", Payload: `{"order_id":"legacy"}`, CreatedAt: 1}
	require.NoError(t, DB.Table("pikno_settlement_outboxes").Migrator().CreateTable(&oldOutbox))
	require.NoError(t, DB.Table("pikno_settlement_outboxes").Create(&oldOutbox).Error)
	require.NoError(t, MigratePiknoSettlements(DB))
	require.NoError(t, MigratePiknoSettlements(DB))
	var deliverable int64
	require.NoError(t, DB.Model(&PiknoSettlementOutbox{}).Where("event_id = ? AND next_attempt_at = 0 AND lease_until = 0 AND delivery_state = ?", 900000, "").Count(&deliverable).Error)
	assert.EqualValues(t, 1, deliverable, "upgraded queue rows must not disappear from delivery scans")
	var preserved User
	require.NoError(t, DB.First(&preserved, legacy.Id).Error)
	assert.Equal(t, legacy.Quota, preserved.Quota)
	assert.Equal(t, legacy.UsedQuota, preserved.UsedQuota)
	admin := User{Username: "piknoadmin", AffCode: "admin", Password: "test-only", Role: common.RoleRootUser, Status: common.UserStatusEnabled}
	require.NoError(t, DB.Create(&admin).Error)
	sequence := 0
	fixture := func(t *testing.T, flare bool) PiknoSettlementQuote {
		t.Helper()
		sequence++
		user := User{Username: fmtPiknoTestID("u", sequence), AffCode: fmtPiknoTestID("a", sequence), Password: "test-only", Quota: 10000000, Status: common.UserStatusEnabled}
		require.NoError(t, DB.Create(&user).Error)
		token := Token{UserId: user.Id, Key: fmtPiknoTestID("key", sequence), RemainQuota: 5000000, ExpiredTime: -1, Status: common.TokenStatusEnabled}
		require.NoError(t, DB.Create(&token).Error)
		channel := Channel{Key: "test-only", Name: fmtPiknoTestID("channel", sequence)}
		require.NoError(t, DB.Create(&channel).Error)
		q := PiknoSettlementQuote{OrderID: fmtPiknoTestID("order", sequence), UserID: user.Id, TokenID: token.Id, ChannelID: channel.Id, Model: "video", AccountRef: "account-a", UpstreamTaskID: fmtPiknoTestID("upstream", sequence), PriceMode: "cost_x2", QuoteQuota: 1520000}
		if flare {
			q.Model = "gpt-image-2.5-flare"
			q.PriceMode = "flare_fixed"
			q.RequestedImages = 1
			q.QuoteQuota = 100000
		}
		return q
	}
	evidence := func(q PiknoSettlementQuote, cost, refund int) *PiknoBillingEvidence {
		return &PiknoBillingEvidence{Reference: "private-receipt-sha256", AccountRef: q.AccountRef, UpstreamTaskID: q.UpstreamTaskID, Final: true, ChargedQuota: cost, RefundedQuota: refund}
	}
	read := func(t *testing.T, q PiknoSettlementQuote) (PiknoSettlement, User, Token) {
		t.Helper()
		var s PiknoSettlement
		var u User
		var token Token
		require.NoError(t, DB.First(&s, "id = ?", q.OrderID).Error)
		require.NoError(t, DB.First(&u, q.UserID).Error)
		require.NoError(t, DB.Unscoped().First(&token, q.TokenID).Error)
		return s, u, token
	}
	t.Run("reservation_is_not_consumption_and_duplicate_does_not_charge", func(t *testing.T) {
		q := fixture(t, false)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ReservePiknoSettlement(q)
		require.NoError(t, err)
		s, u, token := read(t, q)
		assert.Equal(t, 8480000, u.Quota)
		assert.Zero(t, u.UsedQuota)
		assert.Equal(t, 3480000, token.RemainQuota)
		assert.Zero(t, token.UsedQuota)
		assert.Equal(t, 1520000, s.ReservedQuota)
		assert.Equal(t, 1, u.RequestCount)
		q.QuoteQuota--
		_, err = ReservePiknoSettlement(q)
		require.ErrorIs(t, err, ErrPiknoConflict)
	})
	t.Run("video_quote_success_failure_and_late_terminal_are_idempotent", func(t *testing.T) {
		for _, outcome := range []string{"succeeded", "failed"} {
			q := fixture(t, false)
			q.Model, q.PriceMode = "sanbao/video/test", "video_success_quote"
			_, err := ReservePiknoSettlement(q)
			require.NoError(t, err)
			_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "timeout", ExpectedVersion: 1, Action: "observe", Outcome: "unknown"})
			require.NoError(t, err)
			s, _, _ := read(t, q)
			assert.Equal(t, "pending_review", s.FinancialState)
			cmd := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "terminal", ExpectedVersion: s.Version, Action: "observe", Outcome: outcome}
			_, err = ApplyPiknoSettlement(cmd)
			require.NoError(t, err)
			_, err = ApplyPiknoSettlement(cmd)
			require.NoError(t, err)
			s, u, tok := read(t, q)
			charge := 0
			if outcome == "succeeded" {
				charge = q.QuoteQuota
			}
			assert.Equal(t, "pikno-video-success-v2", s.Rule)
			assert.Equal(t, "settled", s.FinancialState)
			assert.Zero(t, s.ReservedQuota)
			assert.Equal(t, charge, s.NetQuota)
			assert.Equal(t, 10000000-charge, u.Quota)
			assert.Equal(t, charge, u.UsedQuota)
			assert.Equal(t, 5000000-charge, tok.RemainQuota)
			assert.Equal(t, charge, tok.UsedQuota)
			assert.Zero(t, s.NetCostQuota, "quote is a sale price, not upstream cost")
			_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "late", ExpectedVersion: s.Version, Action: "observe", Outcome: "unknown"})
			require.NoError(t, err)
			s, u, _ = read(t, q)
			assert.Equal(t, charge, s.NetQuota)
			assert.Equal(t, 10000000-charge, u.Quota)
		}
	})
	t.Run("published_line_quote_is_snapshotted_and_terminal_outcomes_are_deterministic", func(t *testing.T) {
		for _, outcome := range []string{"succeeded", "failed", "unknown"} {
			q := fixture(t, false)
			q.Model = "pikno-video-sb-test"
			q.PriceMode = "line_success_quote"
			q.LineRevision = 17
			q.LineProvider = "sanbao"
			q.PriceUnit = "second"
			q.QuoteQuota = 1_234_567
			_, err := ReservePiknoSettlement(q)
			require.NoError(t, err)
			_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "terminal", ExpectedVersion: 1, Action: "observe", Outcome: outcome})
			require.NoError(t, err)
			s, u, token := read(t, q)
			assert.Equal(t, PiknoLineSettlementRule, s.Rule)
			assert.EqualValues(t, 17, s.LineRevision)
			assert.Equal(t, "sanbao", s.LineProvider)
			assert.Equal(t, "second", s.PriceUnit)
			switch outcome {
			case "succeeded":
				assert.Equal(t, q.QuoteQuota, s.NetQuota)
				assert.Zero(t, s.ReservedQuota)
				assert.Equal(t, 10_000_000-q.QuoteQuota, u.Quota)
				assert.Equal(t, 5_000_000-q.QuoteQuota, token.RemainQuota)
			case "failed":
				assert.Zero(t, s.NetQuota)
				assert.Zero(t, s.ReservedQuota)
				assert.Equal(t, 10_000_000, u.Quota)
				assert.Equal(t, 5_000_000, token.RemainQuota)
			case "unknown":
				assert.Zero(t, s.NetQuota)
				assert.Equal(t, q.QuoteQuota, s.ReservedQuota)
				assert.Equal(t, 10_000_000-q.QuoteQuota, u.Quota)
				assert.Equal(t, 5_000_000-q.QuoteQuota, token.RemainQuota)
			}
		}
	})
	t.Run("video_manual_failure_waives_cost_and_requires_result_evidence", func(t *testing.T) {
		q := fixture(t, false)
		q.Model, q.PriceMode = "sanbao/video/test", "video_success_quote"
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		cmd := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "review", ExpectedVersion: 1, Action: "failure", ActorID: admin.Id, Reason: "verified failed"}
		_, err = ApplyPiknoSettlement(cmd)
		require.ErrorIs(t, err, ErrPiknoEvidence)
		cmd.Evidence = evidence(q, 760000, 0)
		_, err = ApplyPiknoSettlement(cmd)
		require.NoError(t, err)
		s, u, tok := read(t, q)
		assert.Zero(t, s.NetQuota)
		assert.Zero(t, s.ReservedQuota)
		assert.Equal(t, 10000000, u.Quota)
		assert.Equal(t, 5000000, tok.RemainQuota)
	})
	t.Run("video_refunds_remain_cost_times_two_capped_at_payment", func(t *testing.T) {
		q := fixture(t, false)
		q.Model, q.PriceMode = "canseedream/video/test", "video_success_quote"
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "success", ExpectedVersion: 1, Action: "observe", Outcome: "succeeded"})
		require.NoError(t, err)
		for i, refund := range []int{260000, 1000000} {
			s, _, _ := read(t, q)
			cmd := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: fmtPiknoTestID("refund", i), ExpectedVersion: s.Version, Action: "refund", ActorID: admin.Id, Reason: "confirmed refund", Evidence: evidence(q, 1000000, refund)}
			_, err = ApplyPiknoSettlement(cmd)
			require.NoError(t, err)
			_, err = ApplyPiknoSettlement(cmd)
			require.NoError(t, err)
			s, u, tok := read(t, q)
			want := q.QuoteQuota - min(q.QuoteQuota, refund*2)
			assert.Equal(t, want, s.NetQuota)
			assert.Equal(t, 10000000-want, u.Quota)
			assert.Equal(t, 5000000-want, tok.RemainQuota)
		}
	})
	t.Run("Flare_success_stays_at_ten_cents_without_upstream_cost", func(t *testing.T) {
		q := fixture(t, true)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		c := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "success", ExpectedVersion: 1, Action: "observe", Outcome: "succeeded", Images: 1}
		event, err := ApplyPiknoSettlement(c)
		require.NoError(t, err)
		assert.Equal(t, 100000, event.NetQuota)
		s, u, token := read(t, q)
		assert.Equal(t, 9900000, u.Quota)
		assert.Equal(t, 100000, u.UsedQuota)
		assert.Equal(t, 4900000, token.RemainQuota)
		assert.Equal(t, 100000, token.UsedQuota)
		assert.Zero(t, s.ReservedQuota)
		duplicate, err := ApplyPiknoSettlement(c)
		require.NoError(t, err)
		assert.Equal(t, event.ID, duplicate.ID)
		c.Images = 2
		_, err = ApplyPiknoSettlement(c)
		require.ErrorIs(t, err, ErrPiknoConflict)
	})
	t.Run("verified_video_success_is_cost_times_two", func(t *testing.T) {
		q := fixture(t, false)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "ok", ExpectedVersion: 1, Action: "observe", Outcome: "succeeded", Evidence: evidence(q, 700000, 0)})
		require.NoError(t, err)
		s, u, token := read(t, q)
		assert.Equal(t, 1400000, s.NetQuota)
		assert.Equal(t, 8600000, u.Quota)
		assert.Equal(t, 1400000, u.UsedQuota)
		assert.Equal(t, 3600000, token.RemainQuota)
	})
	t.Run("failure_waits_for_admin_then_charges_cost_once", func(t *testing.T) {
		q := fixture(t, false)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "failed", ExpectedVersion: 1, Action: "observe", Outcome: "failed", Evidence: evidence(q, 760000, 0)})
		require.NoError(t, err)
		s, u, _ := read(t, q)
		assert.Equal(t, "pending_review", s.FinancialState)
		assert.Zero(t, u.UsedQuota)
		c := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "review", ExpectedVersion: 2, Action: "failure", ActorID: q.UserID, Evidence: evidence(q, 760000, 0), Reason: "confirmed provider debit"}
		_, err = ApplyPiknoSettlement(c)
		require.ErrorIs(t, err, ErrPiknoPermission)
		c.ActorID = admin.Id
		_, err = ApplyPiknoSettlement(c)
		require.NoError(t, err)
		s, u, token := read(t, q)
		assert.Equal(t, 760000, s.NetQuota)
		assert.Equal(t, 9240000, u.Quota)
		assert.Equal(t, 760000, u.UsedQuota)
		assert.Equal(t, 4240000, token.RemainQuota)
		c.OperationID = "refund"
		c.Action = "refund"
		c.ExpectedVersion = 3
		c.Evidence = evidence(q, 760000, 260000)
		_, err = ApplyPiknoSettlement(c)
		require.NoError(t, err)
		s, u, _ = read(t, q)
		assert.Equal(t, 500000, s.NetQuota)
		assert.Equal(t, 260000, s.RefundedQuota)
		assert.Equal(t, 9500000, u.Quota)
		_, err = ApplyPiknoSettlement(c)
		require.NoError(t, err)
		c.OperationID = "full-refund"
		c.ExpectedVersion = 4
		c.Evidence = evidence(q, 760000, 760000)
		_, err = ApplyPiknoSettlement(c)
		require.NoError(t, err)
		s, u, _ = read(t, q)
		assert.Equal(t, "refunded", s.FinancialState)
		assert.Equal(t, 10000000, u.Quota)
		assert.Zero(t, u.UsedQuota)
	})
	t.Run("unknown_missing_cost_and_wrong_receipt_stay_in_review", func(t *testing.T) {
		for _, outcome := range []string{"unknown", "failed", "succeeded"} {
			q := fixture(t, false)
			_, err := ReservePiknoSettlement(q)
			require.NoError(t, err)
			wrong := evidence(q, 760000, 0)
			wrong.UpstreamTaskID = "someone-else"
			_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "observe", ExpectedVersion: 1, Action: "observe", Outcome: outcome, Evidence: wrong})
			require.NoError(t, err)
			s, u, _ := read(t, q)
			assert.Equal(t, "pending_review", s.FinancialState)
			assert.Zero(t, u.UsedQuota)
			_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "later-success", ExpectedVersion: 2, Action: "observe", Outcome: "succeeded", Evidence: evidence(q, 760000, 0)})
			require.NoError(t, err)
			s, _, _ = read(t, q)
			assert.Equal(t, "pending_review", s.FinancialState)
			_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "waive", ExpectedVersion: 3, Action: "waive", ActorID: admin.Id, Reason: "merchant absorbs unresolved cost"})
			require.NoError(t, err)
			s, u, _ = read(t, q)
			assert.Equal(t, 10000000, u.Quota)
			assert.Zero(t, s.NetQuota)
			assert.Equal(t, "succeeded", s.GenerationState)
		}
	})
	t.Run("over_quote_costs_never_silently_debit_more", func(t *testing.T) {
		q := fixture(t, true)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "review", ExpectedVersion: 1, Action: "failure", ActorID: admin.Id, Reason: "upstream billed more than customer quote", Evidence: evidence(q, 200000, 0)})
		require.NoError(t, err)
		s, u, _ := read(t, q)
		assert.Equal(t, "pending_review", s.FinancialState)
		assert.Equal(t, 9900000, u.Quota)
		assert.Zero(t, u.UsedQuota)
	})
	t.Run("deleted_token_retains_counters_and_hard_missing_token_rolls_back", func(t *testing.T) {
		q := fixture(t, true)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		require.NoError(t, DB.Delete(&Token{}, q.TokenID).Error)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "success", ExpectedVersion: 1, Action: "observe", Outcome: "succeeded", Images: 1})
		require.NoError(t, err)
		_, _, token := read(t, q)
		assert.Equal(t, 100000, token.UsedQuota)
		assert.True(t, token.DeletedAt.Valid)
		q = fixture(t, true)
		_, err = ReservePiknoSettlement(q)
		require.NoError(t, err)
		require.NoError(t, DB.Unscoped().Delete(&Token{}, q.TokenID).Error)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "waive", ExpectedVersion: 1, Action: "waive", ActorID: admin.Id, Reason: "waive"})
		require.Error(t, err)
		var user User
		require.NoError(t, DB.First(&user, q.UserID).Error)
		assert.Equal(t, 9900000, user.Quota)
		var order PiknoSettlement
		require.NoError(t, DB.First(&order, "id = ?", q.OrderID).Error)
		assert.Equal(t, 1, order.Version)
	})
	t.Run("concurrent_reviews_have_one_winner_and_stale_version_fails", func(t *testing.T) {
		q := fixture(t, false)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		start := make(chan struct{})
		results := make(chan error, 2)
		var wg sync.WaitGroup
		for _, op := range []string{"a", "b"} {
			wg.Go(func() {
				<-start
				_, err := ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: op, ExpectedVersion: 1, Action: "failure", ActorID: admin.Id, Reason: "verified", Evidence: evidence(q, 760000, 0)})
				results <- err
			})
		}
		close(start)
		wg.Wait()
		close(results)
		successes, conflicts := 0, 0
		for err := range results {
			if err == nil {
				successes++
			} else if errors.Is(err, ErrPiknoConflict) {
				conflicts++
			} else {
				t.Error(err)
			}
		}
		assert.Equal(t, 1, successes)
		assert.Equal(t, 1, conflicts)
		s, u, token := read(t, q)
		assert.Equal(t, 2, s.Version)
		assert.Equal(t, 9240000, u.Quota)
		assert.Equal(t, 4240000, token.RemainQuota)
	})
	t.Run("usage_image_review_requires_final_receipt_and_never_charges_failed_request", func(t *testing.T) {
		q := fixture(t, false)
		q.Model, q.PriceMode, q.LineProvider, q.PriceUnit = "pikno-image-flare", PiknoImageUsageSettlementRule, "packy", "token"
		q.LineRevision, q.RequestedImages, q.QuoteQuota, q.UpstreamTaskID = 1, 1, 100000, ""
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		command := PiknoSettlementCommand{
			OrderID: q.OrderID, OperationID: "review-image-failure", ExpectedVersion: 1, ActorID: admin.Id,
			Action: "failure", Reason: "verified failed image", Evidence: evidence(q, 76000, 0),
		}
		wrongID := evidence(q, 76000, 0)
		wrongID.UpstreamTaskID = "different-request"
		wrongAccount := evidence(q, 76000, 0)
		wrongAccount.AccountRef = "unrelated-account"
		nonfinal := evidence(q, 76000, 0)
		nonfinal.Final = false
		for _, invalid := range []*PiknoBillingEvidence{nil, wrongID, wrongAccount, nonfinal, evidence(q, -1, 0)} {
			rejected := command
			rejected.Evidence = invalid
			_, err := ApplyPiknoSettlement(rejected)
			require.ErrorIs(t, err, ErrPiknoEvidence)
		}
		unauthorized := command
		unauthorized.ActorID = q.UserID
		_, err = ApplyPiknoSettlement(unauthorized)
		require.ErrorIs(t, err, ErrPiknoPermission)
		preview, err := PreviewPiknoSettlement(command)
		require.NoError(t, err)
		assert.Equal(t, 100000, preview.WalletDelta)
		event, err := ApplyPiknoSettlement(command)
		require.NoError(t, err)
		assert.Equal(t, 100000, event.WalletDelta)
		assert.Contains(t, event.Evidence, "private-receipt-sha256")
		s, u, token := read(t, q)
		assert.Equal(t, "failed", s.SettledOutcome)
		assert.Zero(t, s.NetQuota)
		assert.Equal(t, 10000000, u.Quota)
		assert.Zero(t, u.UsedQuota)
		assert.Equal(t, 5000000, token.RemainQuota)
	})
	t.Run("usage_image_refunds_are_explicit_cumulative_and_capped_at_customer_charge", func(t *testing.T) {
		q := fixture(t, false)
		q.Model, q.PriceMode, q.LineProvider, q.PriceUnit = "pikno-image-flare", PiknoImageUsageSettlementRule, "packy", "token"
		q.LineRevision, q.RequestedImages, q.QuoteQuota, q.UpstreamTaskID = 1, 1, 100000, ""
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "image-usage", ExpectedVersion: 1,
			Action: "observe", Outcome: "succeeded", Images: 1, ImageUsageQuota: common.GetPointer(30050)})
		require.NoError(t, err)
		command := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "image-refund", ExpectedVersion: 2, ActorID: admin.Id,
			Action: "refund", Reason: "verified partial upstream refund", Evidence: evidence(q, 10000, 9000), FixedRefundQuota: 15000}
		rejected := command
		rejected.Evidence = evidence(q, 10000, 0)
		_, err = ApplyPiknoSettlement(rejected)
		require.ErrorIs(t, err, ErrPiknoEvidence)
		rejected = command
		rejected.FixedRefundQuota = 30051
		_, err = ApplyPiknoSettlement(rejected)
		require.Error(t, err)
		first, err := ApplyPiknoSettlement(command)
		require.NoError(t, err)
		assert.Equal(t, 15000, first.WalletDelta)
		replay, err := ApplyPiknoSettlement(command)
		require.NoError(t, err)
		assert.Equal(t, first.ID, replay.ID)
		s, u, token := read(t, q)
		assert.Equal(t, "partially_refunded", s.FinancialState)
		assert.Equal(t, 15050, s.NetQuota)
		assert.Equal(t, 9984950, u.Quota)
		assert.Equal(t, 4984950, token.RemainQuota)
		command.OperationID, command.ExpectedVersion = "image-refund-remainder", s.Version
		command.FixedRefundQuota = 14999
		_, err = ApplyPiknoSettlement(command)
		require.Error(t, err)
		command.FixedRefundQuota = 30050
		command.Evidence = evidence(q, 10000, 10000)
		_, err = ApplyPiknoSettlement(command)
		require.NoError(t, err)
		s, u, token = read(t, q)
		assert.Equal(t, "refunded", s.FinancialState)
		assert.Equal(t, 30050, s.RefundedQuota)
		assert.Zero(t, s.NetQuota)
		assert.Zero(t, u.UsedQuota)
		assert.Equal(t, 10000000, u.Quota)
		assert.Equal(t, 5000000, token.RemainQuota)
	})
	t.Run("fixed_price_refund_is_explicit_capped_and_outbox_is_private", func(t *testing.T) {
		q := fixture(t, true)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "success", ExpectedVersion: 1, Action: "observe", Outcome: "succeeded", Images: 1})
		require.NoError(t, err)
		c := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "refund", ExpectedVersion: 2, Action: "refund", ActorID: admin.Id, Reason: "private-internal-note", Evidence: evidence(q, 50000, 50000), FixedRefundQuota: 100001}
		_, err = ApplyPiknoSettlement(c)
		require.Error(t, err)
		c.FixedRefundQuota = 100000
		event, err := ApplyPiknoSettlement(c)
		require.NoError(t, err)
		var outbox PiknoSettlementOutbox
		require.NoError(t, DB.First(&outbox, "event_id = ?", event.ID).Error)
		for _, private := range []string{"account-a", "private-internal-note", "private-receipt", "upstream", "cost", "Evidence"} {
			assert.NotContains(t, outbox.Payload, private)
		}
		assert.Contains(t, outbox.Payload, `"financial_state":"refunded"`)
		_, err = ApplyPiknoSettlement(c)
		require.NoError(t, err)
		var count int64
		require.NoError(t, DB.Model(&PiknoSettlementOutbox{}).Where("event_id = ?", event.ID).Count(&count).Error)
		assert.EqualValues(t, 1, count)
		s, u, _ := read(t, q)
		assert.Equal(t, 10000000, u.Quota)
		assert.Equal(t, 100000, s.RefundedQuota)
		// A late provider success cannot recharge a fully refunded order.
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "late", ExpectedVersion: 3, Action: "observe", Outcome: "succeeded", Images: 1})
		require.NoError(t, err)
		s, u, _ = read(t, q)
		assert.Zero(t, s.NetQuota)
		assert.Equal(t, 10000000, u.Quota)
	})
	t.Run("invalid_amounts_and_identity_fail_without_reserving", func(t *testing.T) {
		q := fixture(t, true)
		for _, amount := range []int{-1, 200000, common.MaxQuota + 1} {
			invalid := q
			invalid.QuoteQuota = amount
			_, err := ReservePiknoSettlement(invalid)
			require.Error(t, err)
		}
		q.UserID = 0
		_, err := ReservePiknoSettlement(q)
		require.Error(t, err)
	})
	t.Run("reserve_before_upstream_submission_then_bind_without_second_debit", func(t *testing.T) {
		q := fixture(t, false)
		q.UpstreamTaskID = ""
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "bind", ExpectedVersion: 1, Action: "bind", UpstreamTaskID: "issued-after-reserve"})
		require.NoError(t, err)
		_, err = ReservePiknoSettlement(q)
		require.NoError(t, err)
		s, u, _ := read(t, q)
		assert.Equal(t, "issued-after-reserve", s.UpstreamTaskID)
		assert.Equal(t, 8480000, u.Quota)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "rebind", ExpectedVersion: 2, Action: "bind", UpstreamTaskID: "different-task"})
		require.ErrorIs(t, err, ErrPiknoConflict)
	})
	t.Run("outbox_write_failure_rolls_back_money_ledger_and_version", func(t *testing.T) {
		q := fixture(t, true)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		c := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "waive", ExpectedVersion: 1, Action: "waive", ActorID: admin.Id, Reason: "verified waiver"}
		require.NoError(t, DB.Callback().Create().Before("gorm:create").Register("test:outbox_failure", func(tx *gorm.DB) {
			if tx.Statement.Table == "pikno_settlement_outboxes" {
				tx.AddError(errors.New("simulated durable queue failure"))
			}
		}))
		_, err = ApplyPiknoSettlement(c)
		require.NoError(t, DB.Callback().Create().Remove("test:outbox_failure"))
		require.Error(t, err)
		s, u, token := read(t, q)
		assert.Equal(t, 1, s.Version)
		assert.Equal(t, 9900000, u.Quota)
		assert.Equal(t, 4900000, token.RemainQuota)
		var count int64
		require.NoError(t, DB.Model(&PiknoSettlementEvent{}).Where("order_id = ?", q.OrderID).Count(&count).Error)
		assert.EqualValues(t, 1, count)
		_, err = ApplyPiknoSettlement(c)
		require.NoError(t, err)
		s, u, _ = read(t, q)
		assert.Equal(t, 2, s.Version)
		assert.Equal(t, 10000000, u.Quota)
	})
	t.Run("deadline_only_queues_admin_reminder_and_never_releases_funds", func(t *testing.T) {
		q := fixture(t, false)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "unknown", ExpectedVersion: 1, Action: "observe", Outcome: "unknown"})
		require.NoError(t, err)
		s, u, token := read(t, q)
		due := s.ReviewDueAt
		require.Positive(t, due)
		_, err = QueuePiknoSettlementReviewReminders(due-1, 100)
		require.NoError(t, err)
		var count int64
		require.NoError(t, DB.Model(&PiknoSettlementEvent{}).Where("order_id = ? AND action = ?", q.OrderID, "reminder").Count(&count).Error)
		assert.Zero(t, count)
		_, err = QueuePiknoSettlementReviewReminders(due, 100)
		require.NoError(t, err)
		_, err = QueuePiknoSettlementReviewReminders(due, 100)
		require.NoError(t, err)
		require.NoError(t, DB.Model(&PiknoSettlementEvent{}).Where("order_id = ? AND action = ?", q.OrderID, "reminder").Count(&count).Error)
		assert.EqualValues(t, 1, count)
		after, afterUser, afterToken := read(t, q)
		assert.Equal(t, s.ReservedQuota, after.ReservedQuota)
		assert.Equal(t, s.Version, after.Version)
		assert.Equal(t, u.Quota, afterUser.Quota)
		assert.Equal(t, token.RemainQuota, afterToken.RemainQuota)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "waive", ExpectedVersion: 2, Action: "waive", ActorID: admin.Id, Reason: "waive unresolved charge"})
		require.NoError(t, err)
		after, _, _ = read(t, q)
		assert.Zero(t, after.ReviewDueAt)
	})
	t.Run("simultaneous_duplicate_review_returns_same_persisted_event", func(t *testing.T) {
		q := fixture(t, false)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		c := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "same-review", ExpectedVersion: 1, Action: "failure", ActorID: admin.Id, Reason: "verified cost", Evidence: evidence(q, 760000, 0)}
		start := make(chan struct{})
		type outcome struct {
			event *PiknoSettlementEvent
			err   error
		}
		results := make(chan outcome, 2)
		var wg sync.WaitGroup
		for range 2 {
			wg.Go(func() { <-start; event, err := ApplyPiknoSettlement(c); results <- outcome{event, err} })
		}
		close(start)
		wg.Wait()
		close(results)
		var ids []int64
		for got := range results {
			require.NoError(t, got.err)
			ids = append(ids, got.event.ID)
		}
		assert.Equal(t, ids[0], ids[1])
		_, user, _ := read(t, q)
		assert.Equal(t, 9240000, user.Quota)
	})
	t.Run("successful_cost_multiplier_also_applies_to_subsequent_refund", func(t *testing.T) {
		q := fixture(t, false)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "success", ExpectedVersion: 1, Action: "observe", Outcome: "succeeded", Evidence: evidence(q, 760000, 0)})
		require.NoError(t, err)
		c := PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "refund", ExpectedVersion: 2, Action: "refund", ActorID: admin.Id, Reason: "partial provider refund", Evidence: evidence(q, 760000, 260000)}
		_, err = ApplyPiknoSettlement(c)
		require.NoError(t, err)
		s, u, _ := read(t, q)
		assert.Equal(t, 1000000, s.NetQuota)
		assert.Equal(t, 520000, s.RefundedQuota)
		assert.Equal(t, 9000000, u.Quota)
		c.OperationID = "stale-provider-receipt"
		c.ExpectedVersion = 3
		c.Evidence = evidence(q, 760000, 100000)
		_, err = ApplyPiknoSettlement(c)
		require.Error(t, err)
	})
	t.Run("insufficient_balances_invalid_evidence_and_overflow_never_mutate_money", func(t *testing.T) {
		q := fixture(t, false)
		require.NoError(t, DB.Model(&User{}).Where("id = ?", q.UserID).Update("quota", 1).Error)
		_, err := ReservePiknoSettlement(q)
		require.Error(t, err)
		require.NoError(t, DB.Model(&User{}).Where("id = ?", q.UserID).Update("quota", 10000000).Error)
		require.NoError(t, DB.Model(&Token{}).Where("id = ?", q.TokenID).Update("remain_quota", 1).Error)
		_, err = ReservePiknoSettlement(q)
		require.Error(t, err)
		var user User
		require.NoError(t, DB.First(&user, q.UserID).Error)
		assert.Equal(t, 10000000, user.Quota)
		require.NoError(t, DB.Model(&Token{}).Where("id = ?", q.TokenID).Update("remain_quota", 5000000).Error)
		_, err = ReservePiknoSettlement(q)
		require.NoError(t, err)
		for _, receipt := range []*PiknoBillingEvidence{nil, evidence(q, -1, 0), evidence(q, 1, 2), evidence(q, common.MaxQuota, 0)} {
			_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "bad-evidence", ExpectedVersion: 1, Action: "success", ActorID: admin.Id, Reason: "audit", Evidence: receipt})
			require.Error(t, err)
		}
		s, user, _ := read(t, q)
		assert.Equal(t, 1, s.Version)
		assert.Zero(t, user.UsedQuota)
		assert.Equal(t, 8480000, user.Quota)
	})
	t.Run("unlimited_token_keeps_limit_counter_but_tracks_consumption", func(t *testing.T) {
		q := fixture(t, true)
		require.NoError(t, DB.Model(&Token{}).Where("id = ?", q.TokenID).Updates(map[string]any{"unlimited_quota": true, "remain_quota": 0}).Error)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "success", ExpectedVersion: 1, Action: "observe", Outcome: "succeeded", Images: 1})
		require.NoError(t, err)
		_, _, token := read(t, q)
		assert.Zero(t, token.RemainQuota)
		assert.Equal(t, 100000, token.UsedQuota)
	})
	t.Run("legacy_cache_and_batch_writers_cannot_accidentally_activate_new_engine", func(t *testing.T) {
		q := fixture(t, true)
		common.RedisEnabled = true
		_, redisErr := ReservePiknoSettlement(q)
		common.RedisEnabled = false
		common.BatchUpdateEnabled = true
		_, batchErr := ReservePiknoSettlement(q)
		common.BatchUpdateEnabled = false
		require.Error(t, redisErr)
		require.Error(t, batchErr)
	})
	t.Run("late_conflict_can_be_acknowledged_without_touching_money", func(t *testing.T) {
		q := fixture(t, true)
		_, err := ReservePiknoSettlement(q)
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "success", ExpectedVersion: 1, Action: "observe", Outcome: "succeeded", Images: 1})
		require.NoError(t, err)
		_, err = ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "late", ExpectedVersion: 2, Action: "observe", Outcome: "failed"})
		require.NoError(t, err)
		event, err := ApplyPiknoSettlement(PiknoSettlementCommand{OrderID: q.OrderID, OperationID: "ack", ExpectedVersion: 3, Action: "acknowledge", ActorID: admin.Id, Reason: "Reviewed conflicting upstream status; no billing change"})
		require.NoError(t, err)
		assert.Zero(t, event.WalletDelta)
		s, u, _ := read(t, q)
		assert.Equal(t, 100000, s.NetQuota)
		assert.Equal(t, 9900000, u.Quota)
		assert.Empty(t, s.ReviewReason)
		assert.Zero(t, s.ReviewDueAt)
	})
	// Re-running migration after populated order/event/outbox tables preserves
	// rows and unique operation keys (upgrade + repeat-startup safety).
	var before, after int64
	require.NoError(t, DB.Model(&PiknoSettlementEvent{}).Count(&before).Error)
	require.NoError(t, MigratePiknoSettlements(DB))
	require.NoError(t, MigratePiknoSettlements(DB))
	require.NoError(t, DB.Model(&PiknoSettlementEvent{}).Count(&after).Error)
	assert.Equal(t, before, after)
}

func fmtPiknoTestID(prefix string, n int) string { return fmt.Sprintf("%s-%d", prefix, n) }
