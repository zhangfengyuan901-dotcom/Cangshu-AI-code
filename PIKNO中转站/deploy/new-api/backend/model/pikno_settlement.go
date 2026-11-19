package model

// Staged wallet-only settlement engine. Not registered with application startup
// or relay handlers yet. All relay writers must share its reservation boundary
// before activation; mixing this with legacy pre-consumption double-charges.

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"gorm.io/gorm"
)

const PiknoSettlementRule = "pikno-unified-v1"
const PiknoLineSettlementRule = "pikno-line-success-v3"
const PiknoImageUsageSettlementRule = "pikno-image-usage-cny-v1"

var (
	ErrPiknoConflict           = errors.New("settlement version or operation conflict")
	ErrPiknoEvidence           = errors.New("task-bound final billing evidence required")
	ErrPiknoPermission         = errors.New("only piknoadmin may review settlements")
	ErrPiknoWalletInsufficient = errors.New("insufficient available wallet quota or inactive account")
	ErrPiknoImageOperationUsed = errors.New("image operation was already accepted")
)

// All amounts are integer quota, snapshotted at 1 CNY = 1,000,000 quota.
// These internal models must never be serialized directly to a customer API.
type PiknoSettlement struct {
	ID                      string `gorm:"primaryKey;size:96" json:"-"`
	UserID                  int    `gorm:"index" json:"-"`
	TokenID                 int    `json:"-"`
	ChannelID               int    `json:"-"`
	Model                   string `gorm:"size:128" json:"-"`
	LineRevision            int64  `json:"-"`
	LineProvider            string `gorm:"size:32" json:"-"`
	PriceUnit               string `gorm:"size:16" json:"-"`
	AccountRef              string `gorm:"size:128" json:"-"`
	UpstreamTaskID          string `gorm:"size:128" json:"-"`
	Rule                    string `gorm:"size:64" json:"-"`
	QuoteHash               string `gorm:"size:64" json:"-"`
	PriceMode               string `gorm:"size:32" json:"-"`
	RequestedImages         int    `json:"-"`
	ImageUsageQuota         *int   `json:"-"`
	QuoteQuota              int    `json:"-"`
	ReservedQuota           int    `json:"-"`
	TokenReservationLimited bool   `json:"-"`
	NetQuota                int    `json:"-"`
	RefundedQuota           int    `json:"-"`
	Version                 int    `json:"-"`
	GenerationState         string `gorm:"size:32" json:"-"`
	FinancialState          string `gorm:"size:32;index" json:"-"`
	SettledOutcome          string `gorm:"size:32" json:"-"`
	ReviewReason            string `gorm:"size:128" json:"-"`
	ReviewDueAt             int64  `gorm:"index" json:"-"`
	NetCostQuota            int    `json:"-"`
	UpstreamChargedQuota    int    `json:"-"`
	UpstreamRefundedQuota   int    `json:"-"`
	CreatedAt               int64  `json:"-"`
	UpdatedAt               int64  `json:"-"`
}

type PiknoSettlementEvent struct {
	ID              int64  `gorm:"primaryKey" json:"-"`
	OrderID         string `gorm:"size:96;uniqueIndex:pikno_event_operation;index" json:"-"`
	OperationID     string `gorm:"size:96;uniqueIndex:pikno_event_operation" json:"-"`
	Fingerprint     string `gorm:"size:64" json:"-"`
	Version         int    `json:"-"`
	ActorID         int    `json:"-"`
	Action          string `gorm:"size:32" json:"-"`
	Reason          string `gorm:"type:text" json:"-"`
	Evidence        string `gorm:"type:text" json:"-"`
	WalletDelta     int    `json:"-"`
	NetQuota        int    `json:"-"`
	ReservedQuota   int    `json:"-"`
	FinancialState  string `gorm:"size:32" json:"-"`
	GenerationState string `gorm:"size:32" json:"-"`
	SettledOutcome  string `gorm:"size:32" json:"-"`
	ReviewReason    string `gorm:"size:128" json:"-"`
	CreatedAt       int64  `json:"-"`
}

// Stored in the MAIN database in the same transaction as the money. An eventual
// log/email worker must use ID as its delivery idempotency key. No external sends
// occur inside the financial transaction. This is a durable queue, not delivery.
type PiknoSettlementOutbox struct {
	ID              int64  `gorm:"primaryKey"`
	EventID         int64  `gorm:"uniqueIndex"`
	UserID          int    `gorm:"index"`
	Kind            string `gorm:"size:32"`
	Payload         string `gorm:"type:text"`
	DeliveredAt     int64
	CreatedAt       int64
	LeaseToken      string `gorm:"size:64"`
	LeaseUntil      int64
	NextAttemptAt   int64 `gorm:"index"`
	FirstAttemptAt  int64
	Attempts        int
	Recipient       string `gorm:"size:254"`
	DeliveryState   string `gorm:"size:32"`
	DeliveryPayload string `gorm:"type:text"`
}

type PiknoSettlementView struct {
	OrderID         string `json:"order_id"`
	GenerationState string `json:"generation_state"`
	FinancialState  string `json:"financial_state"`
	ReservedQuota   int    `json:"reserved_quota"`
	NetQuota        int    `json:"net_quota"`
	RefundedQuota   int    `json:"refunded_quota"`
	Version         int    `json:"version"`
	ReviewRequired  bool   `json:"review_required"`
	Model           string `json:"model"`
	CreatedAt       int64  `json:"created_at"`
}

func (s PiknoSettlement) CustomerView() PiknoSettlementView {
	return PiknoSettlementView{s.ID, s.GenerationState, s.FinancialState, s.ReservedQuota, s.NetQuota, s.RefundedQuota, s.Version, s.ReviewReason != "", s.Model, s.CreatedAt}
}

// Call only from a controlled migration; deliberately not added to AutoMigrate.
func MigratePiknoSettlements(db *gorm.DB) error {
	if err := db.AutoMigrate(&PiknoSettlement{}, &PiknoSettlementEvent{}, &PiknoSettlementOutbox{}, &PiknoPriceQuoteSlot{}); err != nil {
		return err
	}
	// Existing phase-15 outbox rows acquire nullable columns on upgrade. Backfill
	// explicitly; defaults on model structs do not fix previously queued records.
	for _, column := range []string{"lease_until", "next_attempt_at", "first_attempt_at", "attempts"} {
		if err := db.Model(&PiknoSettlementOutbox{}).Where(column+" IS NULL").Update(column, 0).Error; err != nil {
			return err
		}
	}
	for _, column := range []string{"lease_token", "recipient", "delivery_state", "delivery_payload"} {
		if err := db.Model(&PiknoSettlementOutbox{}).Where(column+" IS NULL").Update(column, "").Error; err != nil {
			return err
		}
	}
	return nil
}

type PiknoSettlementQuote struct {
	ConfirmedSlotID   string `json:"-"`
	ConfirmedRevision int64  `json:"-"`
	ConfirmedQuota    int    `json:"-"`
	ConfirmedExpires  int64  `json:"-"`
	OrderID           string
	UserID            int
	TokenID           int
	ChannelID         int
	Model             string
	LineRevision      int64
	LineProvider      string
	PriceUnit         string
	AccountRef        string
	UpstreamTaskID    string
	PriceMode         string
	RequestedImages   int
	QuoteQuota        int
}

// This gate prevents accidental use alongside the legacy cache/batch writers.
// Cache coordination is an explicit release prerequisite, not a silent fallback.
func piknoSettlementGate() error {
	if common.RedisEnabled || common.BatchUpdateEnabled {
		return errors.New("staged settlement requires coordinated DB-only wallet writers")
	}
	return nil
}

func validPiknoReference(s string, limit int) bool {
	return strings.TrimSpace(s) != "" && len(s) <= limit
}

// ReservePiknoSettlement debits available quota, but NOT accumulated spending.
// OrderID is the submission idempotency key. A duplicate with changed parameters
// conflicts instead of reserving again. No upstream request is made here.
func ReservePiknoSettlement(q PiknoSettlementQuote) (*PiknoSettlement, error) {
	if err := piknoSettlementGate(); err != nil {
		return nil, err
	}
	if q.UserID <= 0 || q.TokenID <= 0 || q.ChannelID <= 0 || !validPiknoReference(q.OrderID, 96) || !validPiknoReference(q.Model, 128) || !validPiknoReference(q.AccountRef, 128) || len(q.UpstreamTaskID) > 128 || q.QuoteQuota < 0 || q.QuoteQuota > common.MaxQuota {
		return nil, errors.New("invalid settlement quote")
	}
	switch q.PriceMode {
	case PiknoImageUsageSettlementRule:
		if q.Model != "pikno-image-flare" || q.LineProvider != "packy" || q.LineRevision <= 0 || q.PriceUnit != "token" || q.RequestedImages != 1 || q.QuoteQuota <= 0 || q.ConfirmedSlotID != "" {
			return nil, errors.New("invalid image usage reservation")
		}
	case "flare_fixed":
		if q.Model != "gpt-image-2.5-flare" || q.RequestedImages < 1 || q.RequestedImages > dto.MaxImageN || q.QuoteQuota != q.RequestedImages*100000 {
			return nil, errors.New("Flare success price must be CNY 0.10 per image")
		}
	case "cost_x2":
		if q.Model == "gpt-image-2.5-flare" {
			return nil, errors.New("Flare must retain fixed pricing")
		}
	case "video_success_quote":
		if q.QuoteQuota <= 0 || (!strings.HasPrefix(q.Model, "sanbao/video/") && !strings.HasPrefix(q.Model, "canseedream/video/")) {
			return nil, errors.New("quoted video pricing requires a supported video and positive quote")
		}
	case "line_success_quote":
		tool := q.LineProvider == "hamster-tools" && (q.Model == "pikno-tool-digital" || q.Model == "pikno-tool-depth") && q.PriceUnit == "request" && q.RequestedImages == 0
		zeroAllowed := false
		if q.QuoteQuota == 0 && tool {
			line, err := GetPublishedPiknoLine(q.Model)
			zeroAllowed = err == nil && PiknoLineAllowsZeroQuote(line) && line.ChannelID == q.ChannelID && line.Revision == q.LineRevision
		}
		if (q.QuoteQuota <= 0 && !zeroAllowed) || q.LineRevision <= 0 || (q.LineProvider != "packy" && q.LineProvider != "sanbao" && q.LineProvider != "canseedream" && !tool) || (q.PriceUnit != "request" && q.PriceUnit != "second" && q.PriceUnit != "image") || (q.RequestedImages < 0 || q.RequestedImages > dto.MaxImageN) {
			return nil, errors.New("published line pricing requires a positive quote and valid image quantity")
		}
	default:
		return nil, errors.New("unsupported settlement price mode")
	}
	quoteJSON, err := common.Marshal(q)
	if err != nil {
		return nil, err
	}
	quoteHash := fmt.Sprintf("%x", sha256.Sum256(quoteJSON))
	var result PiknoSettlement
	err = DB.Transaction(func(tx *gorm.DB) error {
		// Serialize reservations for one customer, including first-order inserts.
		var user User
		if err := lockForUpdate(tx).First(&user, q.UserID).Error; err != nil {
			return err
		}
		var old PiknoSettlement
		err := tx.First(&old, "id = ?", q.OrderID).Error
		if err == nil {
			if q.PriceMode == PiknoImageUsageSettlementRule {
				return ErrPiknoImageOperationUsed
			}
			if old.QuoteHash != quoteHash {
				return ErrPiknoConflict
			}
			result = old
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if user.Status != common.UserStatusEnabled {
			return errors.New("insufficient available wallet quota or inactive account")
		}
		if user.Quota < q.QuoteQuota {
			return ErrPiknoWalletInsufficient
		}
		var token Token
		if err := lockForUpdate(tx).First(&token, q.TokenID).Error; err != nil {
			return err
		}
		if token.UserId != user.Id || token.Status != common.TokenStatusEnabled || (token.ExpiredTime != -1 && token.ExpiredTime < common.GetTimestamp()) {
			return errors.New("invalid token or insufficient token quota")
		}
		if !token.UnlimitedQuota && token.RemainQuota < q.QuoteQuota {
			if q.PriceMode == PiknoImageUsageSettlementRule {
				return ErrPiknoWalletInsufficient
			}
			return errors.New("invalid token or insufficient token quota")
		}
		if err := validatePiknoConfirmedReservation(tx, q, &token); err != nil {
			return err
		}
		var channel Channel
		if err := tx.First(&channel, q.ChannelID).Error; err != nil {
			return err
		}
		if err := tx.Model(&User{}).Where("id = ?", user.Id).Updates(map[string]any{"quota": gorm.Expr("quota - ?", q.QuoteQuota), "request_count": gorm.Expr("request_count + 1")}).Error; err != nil {
			return err
		}
		if !token.UnlimitedQuota {
			if err := tx.Model(&Token{}).Where("id = ?", token.Id).Update("remain_quota", gorm.Expr("remain_quota - ?", q.QuoteQuota)).Error; err != nil {
				return err
			}
		}
		now := common.GetTimestamp()
		result = PiknoSettlement{ID: q.OrderID, UserID: q.UserID, TokenID: q.TokenID, ChannelID: q.ChannelID, Model: q.Model, LineRevision: q.LineRevision, LineProvider: q.LineProvider, PriceUnit: q.PriceUnit, AccountRef: q.AccountRef, UpstreamTaskID: q.UpstreamTaskID, Rule: PiknoSettlementRule, PriceMode: q.PriceMode, RequestedImages: q.RequestedImages, QuoteQuota: q.QuoteQuota, ReservedQuota: q.QuoteQuota, Version: 1, GenerationState: "unknown", FinancialState: "reserved", CreatedAt: now, UpdatedAt: now}
		result.TokenReservationLimited = !token.UnlimitedQuota
		if q.PriceMode == "video_success_quote" {
			result.Rule = "pikno-video-success-v2"
		} else if q.PriceMode == "line_success_quote" {
			result.Rule = PiknoLineSettlementRule
		} else if q.PriceMode == PiknoImageUsageSettlementRule {
			result.Rule = PiknoImageUsageSettlementRule
		}
		result.QuoteHash = quoteHash
		if err := tx.Create(&result).Error; err != nil {
			return err
		}
		event := PiknoSettlementEvent{OrderID: result.ID, OperationID: "reserve", Version: 1, Action: "reserve", WalletDelta: -q.QuoteQuota, ReservedQuota: q.QuoteQuota, FinancialState: "reserved", CreatedAt: now}
		return tx.Create(&event).Error
	})
	return &result, err
}

// Evidence is server-sourced or entered by a privileged reviewer. None of these
// fields certify an HTTP response by themselves. The future receipt adapter must
// authenticate the provider response before invoking this internal engine.
type PiknoBillingEvidence struct {
	Reference      string
	AccountRef     string
	UpstreamTaskID string
	Final          bool
	ChargedQuota   int
	RefundedQuota  int
}

type PiknoSettlementCommand struct {
	OrderID         string
	OperationID     string
	ExpectedVersion int
	ActorID         int    // zero for trusted internal observation; never bind from customer JSON
	Action          string // observe, success, failure, waive, refund
	Outcome         string // upstream observation only: succeeded, failed, unknown
	Images          int
	ImageUsageQuota *int `json:",omitempty"`
	Evidence        *PiknoBillingEvidence
	Reason          string
	// For fixed-price Flare and usage-priced images, the reviewer supplies a
	// cumulative customer refund bounded by the original payment.
	FixedRefundQuota int
	UpstreamTaskID   string // bind action after successful submission, before polling
}

func (e *PiknoBillingEvidence) validate(s PiknoSettlement, requireTaskID bool) error {
	if e == nil || !e.Final || !validPiknoReference(e.Reference, 512) ||
		((requireTaskID || s.UpstreamTaskID != "") && !validPiknoReference(s.UpstreamTaskID, 128)) ||
		e.AccountRef != s.AccountRef || e.UpstreamTaskID != s.UpstreamTaskID ||
		e.ChargedQuota < 0 || e.ChargedQuota > common.MaxQuota || e.RefundedQuota < 0 || e.RefundedQuota > e.ChargedQuota {
		return ErrPiknoEvidence
	}
	return nil
}

func (e *PiknoBillingEvidence) netCost(s PiknoSettlement) (int, error) {
	if err := e.validate(s, true); err != nil {
		return 0, err
	}
	return e.ChargedQuota - e.RefundedQuota, nil
}

// ApplyPiknoSettlement writes money, token counters, immutable event and outbox
// atomically. Financial decisions never overwrite the observed generation state.
func ApplyPiknoSettlement(c PiknoSettlementCommand) (*PiknoSettlementEvent, error) {
	if err := piknoSettlementGate(); err != nil {
		return nil, err
	}
	if !validPiknoReference(c.OrderID, 96) || !validPiknoReference(c.OperationID, 96) || c.OperationID == "reserve" || c.ExpectedVersion < 1 || len(c.Reason) > 2000 {
		return nil, errors.New("invalid settlement command")
	}
	encoded, err := common.Marshal(c)
	if err != nil {
		return nil, err
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(encoded))
	var result PiknoSettlementEvent
	err = DB.Transaction(func(tx *gorm.DB) error {
		if c.Action != "observe" && c.Action != "bind" {
			var actor User
			if c.ActorID <= 0 || tx.First(&actor, c.ActorID).Error != nil || actor.Username != "piknoadmin" || actor.Role != common.RoleRootUser || actor.Status != common.UserStatusEnabled {
				return ErrPiknoPermission
			}
			if strings.TrimSpace(c.Reason) == "" {
				return errors.New("review reason is required")
			}
		} else if c.ActorID != 0 {
			return ErrPiknoPermission
		}
		var s PiknoSettlement
		if err := lockForUpdate(tx).First(&s, "id = ?", c.OrderID).Error; err != nil {
			return err
		}
		err := lockForUpdate(tx).Where("order_id = ? AND operation_id = ?", c.OrderID, c.OperationID).First(&result).Error
		if err == nil {
			if result.Fingerprint != fingerprint {
				return ErrPiknoConflict
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if s.Version != c.ExpectedVersion {
			return ErrPiknoConflict
		}
		beforeReserved, beforeNet := s.ReservedQuota, s.NetQuota
		if err := s.decide(c); err != nil {
			return err
		}
		var user User
		if err := lockForUpdate(tx).Unscoped().First(&user, s.UserID).Error; err != nil {
			return err
		}
		// Soft-deleted/revoked tokens retain their audit counters. Missing tokens
		// fail the entire transaction, rather than silently skipping quota repair.
		var token Token
		if err := lockForUpdate(tx).Unscoped().First(&token, s.TokenID).Error; err != nil {
			return err
		}
		walletDelta := beforeReserved + beforeNet - s.ReservedQuota - s.NetQuota
		if walletDelta < 0 && s.PriceMode == PiknoImageUsageSettlementRule && (user.Quota < -walletDelta || (s.TokenReservationLimited && token.RemainQuota < -walletDelta)) {
			// Keep the measurement for review. Never turn an unpaid amount into a
			// settled debit or let a completion create a negative wallet balance.
			s.NetQuota, s.ReservedQuota = beforeNet, beforeReserved
			s.FinancialState, s.SettledOutcome, s.ReviewReason = "pending_review", "", "insufficient_balance_for_image_usage"
			walletDelta = 0
		}
		usedDelta := s.NetQuota - beforeNet
		if walletDelta < 0 && user.Quota < -walletDelta {
			return errors.New("insufficient available wallet quota")
		}
		if user.Quota > common.MaxWalletQuota-walletDelta || user.UsedQuota > common.MaxWalletQuota-max(usedDelta, 0) || user.UsedQuota+usedDelta < 0 {
			return errors.New("invalid wallet accounting bounds")
		}
		if err := tx.Unscoped().Model(&User{}).Where("id = ?", s.UserID).Updates(map[string]any{"quota": gorm.Expr("quota + ?", walletDelta), "used_quota": gorm.Expr("used_quota + ?", usedDelta)}).Error; err != nil {
			return err
		}
		if token.UserId != s.UserID || token.UsedQuota > common.MaxWalletQuota-max(usedDelta, 0) || token.UsedQuota+usedDelta < 0 || token.UnlimitedQuota == s.TokenReservationLimited || (s.TokenReservationLimited && (token.RemainQuota+walletDelta < 0 || token.RemainQuota > common.MaxWalletQuota-walletDelta)) {
			return errors.New("token accounting mismatch")
		}
		values := map[string]any{"used_quota": gorm.Expr("used_quota + ?", usedDelta)}
		if s.TokenReservationLimited {
			values["remain_quota"] = gorm.Expr("remain_quota + ?", walletDelta)
		}
		if err := tx.Unscoped().Model(&Token{}).Where("id = ?", token.Id).Updates(values).Error; err != nil {
			return err
		}
		var channel Channel
		if err := lockForUpdate(tx).First(&channel, s.ChannelID).Error; err != nil {
			return err
		}
		if channel.UsedQuota > common.MaxWalletQuota-int64(max(usedDelta, 0)) || channel.UsedQuota+int64(usedDelta) < 0 {
			return errors.New("channel accounting mismatch")
		}
		if err := tx.Model(&Channel{}).Where("id = ?", channel.Id).Update("used_quota", gorm.Expr("used_quota + ?", usedDelta)).Error; err != nil {
			return err
		}
		s.Version++
		s.UpdatedAt = common.GetTimestamp()
		if s.ReviewReason == "" {
			s.ReviewDueAt = 0
		} else if s.ReviewDueAt == 0 {
			s.ReviewDueAt = s.UpdatedAt + 86400
		}
		updated := tx.Model(&PiknoSettlement{}).Where("id = ? AND version = ?", s.ID, c.ExpectedVersion).Select("*").Updates(&s)
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrPiknoConflict
		}
		// Managed task history reports actual net consumption, never the quote.
		// Keep it in the same financial transaction so reviews/refunds cannot
		// leave a stale "consumed" amount in the existing task log interface.
		var task Task
		taskErr := tx.Where("task_id = ? AND user_id = ? AND channel_id = ?", s.ID, s.UserID, s.ChannelID).First(&task).Error
		if taskErr != nil && !errors.Is(taskErr, gorm.ErrRecordNotFound) {
			return taskErr
		}
		if taskErr == nil && task.PrivateData.BillingSource == "pikno_unified_v1" {
			if err := tx.Model(&Task{}).Where("id = ?", task.ID).Update("quota", s.NetQuota).Error; err != nil {
				return err
			}
		}
		evidence := ""
		if c.Evidence != nil {
			body, err := common.Marshal(c.Evidence)
			if err != nil {
				return err
			}
			evidence = string(body)
		}
		result = PiknoSettlementEvent{OrderID: s.ID, OperationID: c.OperationID, Fingerprint: fingerprint, Version: s.Version, ActorID: c.ActorID, Action: c.Action, Reason: c.Reason, Evidence: evidence, WalletDelta: walletDelta, NetQuota: s.NetQuota, ReservedQuota: s.ReservedQuota, FinancialState: s.FinancialState, CreatedAt: s.UpdatedAt}
		result.GenerationState, result.SettledOutcome, result.ReviewReason = s.GenerationState, s.SettledOutcome, s.ReviewReason
		if err := tx.Create(&result).Error; err != nil {
			return err
		}
		body, err := common.Marshal(s.CustomerView())
		if err != nil {
			return err
		}
		if c.Action == "bind" {
			return nil
		}
		return tx.Create(&PiknoSettlementOutbox{EventID: result.ID, UserID: s.UserID, Kind: "customer_status", Payload: string(body), CreatedAt: s.UpdatedAt}).Error
	})
	return &result, err
}

func (s *PiknoSettlement) decide(c PiknoSettlementCommand) error {
	if s.Rule != PiknoSettlementRule && !(s.Rule == "pikno-video-success-v2" && s.PriceMode == "video_success_quote") && !(s.Rule == PiknoLineSettlementRule && s.PriceMode == "line_success_quote") && !(s.Rule == PiknoImageUsageSettlementRule && s.PriceMode == PiknoImageUsageSettlementRule) {
		return errors.New("unsupported historical settlement rule")
	}
	// A timed-out submission can lack an upstream task ID. Only a privileged
	// reviewed command may bind the ID recovered from its billing receipt.
	if c.ActorID > 0 && c.UpstreamTaskID != "" {
		if !validPiknoReference(c.UpstreamTaskID, 128) || (s.UpstreamTaskID != "" && s.UpstreamTaskID != c.UpstreamTaskID) {
			return ErrPiknoConflict
		}
		s.UpstreamTaskID = c.UpstreamTaskID
	}
	if c.Action == "bind" {
		if !validPiknoReference(c.UpstreamTaskID, 128) || (s.UpstreamTaskID != "" && s.UpstreamTaskID != c.UpstreamTaskID) {
			return ErrPiknoConflict
		}
		s.UpstreamTaskID = c.UpstreamTaskID
		return nil
	}
	settled := s.SettledOutcome != ""
	if c.ImageUsageQuota != nil && (s.PriceMode != PiknoImageUsageSettlementRule || c.Action != "observe" || c.Outcome != "succeeded" || *c.ImageUsageQuota <= 0 || *c.ImageUsageQuota > common.MaxQuota) {
		return ErrPiknoEvidence
	}
	if c.Action == "acknowledge" {
		if !settled || s.ReviewReason == "" {
			return ErrPiknoConflict
		}
		s.ReviewReason = ""
		return nil
	}
	if c.Action == "observe" {
		if c.Outcome != "succeeded" && c.Outcome != "failed" && c.Outcome != "unknown" {
			return errors.New("invalid observed outcome")
		}
		if settled {
			// Late/conflicting observations never charge again or undo a review.
			if c.Outcome != s.SettledOutcome {
				s.ReviewReason = "late_conflicting_observation"
			}
			if c.Outcome != "unknown" {
				s.GenerationState = c.Outcome
			}
			return nil
		}
		if s.PriceMode == PiknoImageUsageSettlementRule && s.GenerationState == "succeeded" && c.Outcome == "failed" {
			return ErrPiknoConflict
		}
		if c.Outcome != "unknown" || s.GenerationState == "unknown" {
			s.GenerationState = c.Outcome
		}
		if s.PriceMode == PiknoImageUsageSettlementRule {
			if c.Outcome == "failed" {
				s.NetQuota, s.ReservedQuota = 0, 0
				s.FinancialState, s.SettledOutcome, s.ReviewReason = "settled", "failed", ""
				return nil
			}
			if c.ImageUsageQuota != nil {
				if s.ImageUsageQuota != nil && *s.ImageUsageQuota != *c.ImageUsageQuota {
					return ErrPiknoConflict
				}
				s.ImageUsageQuota = c.ImageUsageQuota
				s.NetQuota, s.ReservedQuota = *c.ImageUsageQuota, 0
				s.FinancialState, s.SettledOutcome, s.ReviewReason = "settled", "succeeded", ""
				return nil
			}
			s.FinancialState = "pending_review"
			if s.ImageUsageQuota == nil {
				s.ReviewReason = "missing_final_image_usage"
			}
			return nil
		}
		// A confirmed terminal result can resolve an earlier query timeout.
		// Historical cost_x2 orders retain their original manual-review policy.
		if (s.PriceMode == "video_success_quote" || s.PriceMode == "line_success_quote") && c.Outcome != "unknown" {
			s.NetQuota = 0
			if c.Outcome == "succeeded" {
				s.NetQuota = s.QuoteQuota
			}
			s.ReservedQuota = 0
			s.FinancialState, s.SettledOutcome, s.ReviewReason = "settled", c.Outcome, ""
			return nil
		}
		if s.FinancialState == "pending_review" {
			return nil
		}
		if c.Outcome != "succeeded" {
			s.FinancialState = "pending_review"
			s.ReviewReason = "upstream_outcome_requires_review"
			return nil
		}
	} else if c.Action != "refund" && settled {
		return ErrPiknoConflict
	}
	if s.PriceMode == PiknoImageUsageSettlementRule {
		switch c.Action {
		case "success":
			if s.GenerationState != "succeeded" || s.ImageUsageQuota == nil {
				return ErrPiknoEvidence
			}
			s.NetQuota, s.ReservedQuota = *s.ImageUsageQuota, 0
			s.FinancialState, s.SettledOutcome, s.ReviewReason = "settled", "succeeded", ""
			return nil
		case "failure":
			if s.GenerationState == "succeeded" || s.ImageUsageQuota != nil {
				return ErrPiknoConflict
			}
			// A synchronous image receipt can lack a provider task ID. A final
			// receipt reference is still required for this privileged decision.
			if err := c.Evidence.validate(*s, false); err != nil {
				return err
			}
			s.NetQuota, s.ReservedQuota = 0, 0
			s.FinancialState, s.SettledOutcome, s.ReviewReason = "settled", "failed", ""
			return nil
		case "refund":
			if s.SettledOutcome != "succeeded" || s.ImageUsageQuota == nil {
				return ErrPiknoConflict
			}
			if err := c.Evidence.validate(*s, false); err != nil {
				return err
			}
			if c.Evidence.RefundedQuota <= 0 || c.Evidence.RefundedQuota < s.UpstreamRefundedQuota ||
				(s.UpstreamChargedQuota > 0 && c.Evidence.ChargedQuota != s.UpstreamChargedQuota) {
				return ErrPiknoEvidence
			}
			paid := *s.ImageUsageQuota
			if paid <= 0 || paid > common.MaxQuota || s.RefundedQuota < 0 ||
				s.RefundedQuota > paid || s.NetQuota != paid-s.RefundedQuota ||
				c.FixedRefundQuota <= 0 || c.FixedRefundQuota < s.RefundedQuota || c.FixedRefundQuota > paid {
				return errors.New("refund exceeds customer payment or reverses prior refund")
			}
			s.NetQuota, s.RefundedQuota = paid-c.FixedRefundQuota, c.FixedRefundQuota
			s.UpstreamChargedQuota, s.UpstreamRefundedQuota = c.Evidence.ChargedQuota, c.Evidence.RefundedQuota
			s.FinancialState = "partially_refunded"
			if s.NetQuota == 0 {
				s.FinancialState = "refunded"
			}
			return nil
		}
	}
	if c.Action == "refund" {
		if !settled {
			return errors.New("cannot refund an unsettled order")
		}
		cost, err := c.Evidence.netCost(*s)
		if err != nil {
			return err
		}
		if c.Evidence.RefundedQuota <= 0 {
			return ErrPiknoEvidence
		}
		target := 0
		if (s.PriceMode == "video_success_quote" || s.PriceMode == "line_success_quote") && s.SettledOutcome == "succeeded" {
			paid := s.NetQuota + s.RefundedQuota
			if c.Evidence.RefundedQuota < s.UpstreamRefundedQuota || (s.UpstreamChargedQuota > 0 && c.Evidence.ChargedQuota != s.UpstreamChargedQuota) {
				return errors.New("refund evidence does not extend the original debit")
			}
			refund := int(min(int64(paid), int64(c.Evidence.RefundedQuota)*2))
			if refund < s.RefundedQuota {
				return errors.New("refund cannot reverse prior refund")
			}
			target = paid - refund
			s.UpstreamChargedQuota = c.Evidence.ChargedQuota
		} else if s.PriceMode == "flare_fixed" && s.SettledOutcome == "succeeded" {
			paid := s.NetQuota + s.RefundedQuota
			if c.FixedRefundQuota < s.RefundedQuota || c.FixedRefundQuota > paid {
				return errors.New("refund exceeds customer payment or reverses prior refund")
			}
			target = paid - c.FixedRefundQuota
		} else {
			if c.Evidence.ChargedQuota != s.UpstreamChargedQuota || c.Evidence.RefundedQuota < s.UpstreamRefundedQuota {
				return errors.New("refund evidence does not extend the original debit")
			}
			if cost > s.NetCostQuota {
				return errors.New("refund cannot increase upstream net cost")
			}
			target = cost
			if s.SettledOutcome == "succeeded" {
				if cost > common.MaxQuota/2 {
					return errors.New("cost overflow")
				}
				target = cost * 2
			}
		}
		if target > s.NetQuota {
			return errors.New("refund cannot increase customer charge")
		}
		s.RefundedQuota += s.NetQuota - target
		s.NetQuota, s.NetCostQuota = target, cost
		s.UpstreamRefundedQuota = c.Evidence.RefundedQuota
		s.FinancialState = "partially_refunded"
		if target == 0 {
			s.FinancialState = "refunded"
		}
		return nil
	}
	if c.Action == "waive" {
		s.ReservedQuota, s.NetQuota = 0, 0
		s.FinancialState, s.SettledOutcome, s.ReviewReason = "settled", "waived", ""
		return nil
	}
	if c.Action != "observe" && c.Action != "success" && c.Action != "failure" {
		return errors.New("unsupported settlement action")
	}
	outcome := "succeeded"
	if c.Action == "failure" {
		outcome = "failed"
	}
	target, cost := 0, 0
	if s.PriceMode == "video_success_quote" || s.PriceMode == "line_success_quote" {
		if c.Evidence == nil || !validPiknoReference(c.Evidence.Reference, 512) || c.Evidence.AccountRef != s.AccountRef || s.UpstreamTaskID == "" || c.Evidence.UpstreamTaskID != s.UpstreamTaskID {
			return ErrPiknoEvidence
		}
		if outcome == "succeeded" {
			target = s.QuoteQuota
		}
	} else if s.PriceMode == "flare_fixed" && outcome == "succeeded" {
		if c.Images < 1 || c.Images > s.RequestedImages {
			return errors.New("invalid delivered image count")
		}
		if c.Action != "observe" && (c.Evidence == nil || !validPiknoReference(c.Evidence.Reference, 512) || c.Evidence.AccountRef != s.AccountRef || c.Evidence.UpstreamTaskID != s.UpstreamTaskID) {
			return ErrPiknoEvidence
		}
		target = c.Images * 100000
	} else {
		var err error
		cost, err = c.Evidence.netCost(*s)
		if err != nil {
			if c.Action != "observe" {
				return err
			}
			s.FinancialState, s.ReviewReason = "pending_review", "missing_final_billing_evidence"
			return nil
		}
		target = cost
		if outcome == "succeeded" {
			if cost > common.MaxQuota/2 {
				return errors.New("cost overflow")
			}
			target = cost * 2
		}
	}
	if target > s.QuoteQuota {
		s.FinancialState, s.ReviewReason = "pending_review", "charge_exceeds_accepted_quote"
		return nil
	}
	s.NetQuota, s.ReservedQuota, s.NetCostQuota = target, 0, cost
	if c.Evidence != nil && !(s.PriceMode == "flare_fixed" && outcome == "succeeded") {
		s.UpstreamChargedQuota, s.UpstreamRefundedQuota = c.Evidence.ChargedQuota, c.Evidence.RefundedQuota
	}
	s.FinancialState, s.SettledOutcome, s.ReviewReason = "settled", outcome, ""
	return nil
}

// QueuePiknoSettlementReviewReminders is a bounded scheduler tick. Due orders
// remain reserved until a human reviews them. A tick never charges or refunds.
// Next reminder is 24 hours later; the row lock prevents duplicate queue entries
// from concurrent workers. The actual scheduler/email consumer is not wired yet.
func QueuePiknoSettlementReviewReminders(now int64, limit int) (int, error) {
	if now <= 0 || now > 1<<53-86400 || limit < 1 || limit > 100 {
		return 0, errors.New("invalid reminder scan")
	}
	var due []PiknoSettlement
	if err := DB.Where("review_due_at > 0 AND review_due_at <= ?", now).Order("review_due_at, id").Limit(limit).Find(&due).Error; err != nil {
		return 0, err
	}
	queued := 0
	for _, candidate := range due {
		added := false
		err := DB.Transaction(func(tx *gorm.DB) error {
			var s PiknoSettlement
			if err := lockForUpdate(tx).First(&s, "id = ?", candidate.ID).Error; err != nil {
				return err
			}
			if s.ReviewDueAt == 0 || s.ReviewDueAt > now || s.ReviewReason == "" {
				return nil
			}
			var admin User
			if err := tx.Where("username = ? AND role = ? AND status = ?", "piknoadmin", common.RoleRootUser, common.UserStatusEnabled).First(&admin).Error; err != nil {
				return err
			}
			event := PiknoSettlementEvent{OrderID: s.ID, OperationID: fmt.Sprintf("reminder-%d-%d", s.Version, s.ReviewDueAt), Version: s.Version, Action: "reminder", NetQuota: s.NetQuota, ReservedQuota: s.ReservedQuota, FinancialState: s.FinancialState, CreatedAt: now}
			if err := tx.Create(&event).Error; err != nil {
				return err
			}
			body, err := common.Marshal(s.CustomerView())
			if err != nil {
				return err
			}
			if err := tx.Create(&PiknoSettlementOutbox{EventID: event.ID, UserID: admin.Id, Kind: "admin_review_reminder", Payload: string(body), CreatedAt: now}).Error; err != nil {
				return err
			}
			if err := tx.Model(&PiknoSettlement{}).Where("id = ?", s.ID).Update("review_due_at", now+86400).Error; err != nil {
				return err
			}
			added = true
			return nil
		})
		if err != nil {
			return queued, err
		}
		if added {
			queued++
		}
	}
	return queued, nil
}
