package model

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"maps"
	"regexp"

	"github.com/QuantumNous/new-api/common"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

const PiknoLLMModel = "pikno-chat-standard"
const PiknoLLMGroup = "chat-standard"
const PiknoLLMPriceVersion = "chat-cny-9-45-actual-v2"
const PiknoLLMBillingMode = "actual_usage_v1"
const PiknoLLMArkModel = "doubao-seed-2.1-pro"
const PiknoLLMArkPriceVersion = "chat-doubao-seed-2-1-pro-cny-30-150-6-v1"
const PiknoLLMArkInputRate = 30
const PiknoLLMArkOutputRate = 150
const PiknoLLMArkCachedInputRate = 6

const PiknoLLMUnknownReviewPolicy = "background_after_cooldown_v1"
const PiknoLLMUnknownReviewCooldownSeconds int64 = 900

// The signed Worker contract accepts at most 65,536 output tokens. This is a
// provider/protocol capability bound, narrower than the shared int32 arithmetic
// bound; it is not a customer price or balance guarantee.
const PiknoLLMMaxOutputTokens = 65_536

var ErrPiknoLLMConflict = errors.New("LLM request conflicts with an existing request")
var ErrPiknoLLMBusy = errors.New("an LLM request still requires completion or review")
var ErrPiknoLLMPermission = errors.New("LLM account or key is unavailable")
var ErrPiknoLLMQuota = errors.New("LLM wallet or key quota is not positive")
var piknoLLMRequestID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var piknoLLMBodyDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// An independent MAIN-database ledger. Never passed to media BillingSession.
// No prompt, response text, usable key, endpoint or provider payload is stored.
type PiknoLLMRequest struct {
	ID                        string `gorm:"primaryKey;size:64" json:"-"`
	UserID                    int    `gorm:"index:pikno_llm_owner_request,unique;index:pikno_llm_owner_state" json:"-"`
	RequestID                 string `gorm:"size:32;index:pikno_llm_owner_request,unique" json:"-"`
	TokenID                   int    `json:"-"`
	BodySHA256                string `gorm:"size:64" json:"-"`
	Model                     string `gorm:"size:64" json:"-"`
	PriceVersion              string `gorm:"size:64" json:"-"`
	BillingMode               string `gorm:"size:32" json:"-"`
	InputRate                 int    `json:"-"`
	OutputRate                int    `json:"-"`
	ProviderInputRate         int    `json:"-"`
	ProviderOutputRate        int    `json:"-"`
	EstimatedCostQuota        *int   `json:"-"`
	CostStatus                string `gorm:"size:48" json:"-"`
	CostEstimateRule          string `gorm:"size:48" json:"-"`
	InputLimit                int    `json:"-"`
	OutputLimit               int    `json:"-"`
	State                     string `gorm:"size:16;index:pikno_llm_owner_state" json:"-"`
	ReservedQuota             int    `json:"-"`
	ChargedQuota              int    `json:"-"`
	RefundedQuota             int    `json:"-"`
	InputTokens               int    `json:"-"`
	OutputTokens              int    `json:"-"`
	CachedTokens              int    `json:"-"`
	TokenLimited              bool   `json:"-"`
	CreatedAt                 int64  `json:"-"`
	UpdatedAt                 int64  `json:"-"`
	admissionRecordIncomplete bool   `gorm:"-" json:"-"`
}

// SQL NULL is not a recorded zero. Carry this read-only projection separately
// because scanning nullable amounts/timestamps into Go integers erases that
// distinction. This is not a schema field and is never written to the ledger.
type piknoLLMAdmissionRow struct {
	PiknoLLMRequest
	AdmissionRecordComplete bool `gorm:"column:admission_record_complete"`
}

func piknoLLMAdmissionQuery(db *gorm.DB) *gorm.DB {
	return db.Model(&PiknoLLMRequest{}).Select("*, (id IS NOT NULL AND user_id IS NOT NULL AND request_id IS NOT NULL AND token_id IS NOT NULL AND body_sha256 IS NOT NULL AND model IS NOT NULL AND price_version IS NOT NULL AND billing_mode IS NOT NULL AND input_rate IS NOT NULL AND output_rate IS NOT NULL AND provider_input_rate IS NOT NULL AND provider_output_rate IS NOT NULL AND input_limit IS NOT NULL AND output_limit IS NOT NULL AND state IS NOT NULL AND reserved_quota IS NOT NULL AND charged_quota IS NOT NULL AND refunded_quota IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cached_tokens IS NOT NULL AND token_limited IS NOT NULL AND created_at IS NOT NULL AND updated_at IS NOT NULL) AS admission_record_complete")
}

func (r piknoLLMAdmissionRow) request() PiknoLLMRequest {
	result := r.PiknoLLMRequest
	result.admissionRecordIncomplete = result.State == "unknown" && !r.AdmissionRecordComplete
	return result
}

type PiknoLLMView struct {
	RequestID         string             `json:"request_id"`
	State             string             `json:"state"`
	Status            string             `json:"status"`
	Currency          string             `json:"currency"`
	Model             string             `json:"model"`
	PriceVersion      string             `json:"price_version"`
	BillingMode       string             `json:"billing_mode"`
	ReservedQuota     int                `json:"reserved_quota"`
	ChargedQuota      int                `json:"charged_quota"`
	RefundedQuota     int                `json:"refunded_quota"`
	InputTokens       int                `json:"input_tokens"`
	OutputTokens      int                `json:"output_tokens"`
	ReviewRequired    bool               `json:"review_required"`
	AdmissionBlocking bool               `json:"admission_blocking"`
	Usage             *PiknoLLMUsageView `json:"usage"`
}

type PiknoLLMUsageView struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
	CachedTokens int `json:"cached_tokens"`
}

func piknoLLMPrice(version string) (alias string, inputRate, outputRate int) {
	switch version {
	case PiknoLLMPriceVersion:
		return PiknoLLMModel, 9, 45
	case PiknoLLMArkPriceVersion:
		return PiknoLLMArkModel, PiknoLLMArkInputRate, PiknoLLMArkOutputRate
	default:
		return "", 0, 0
	}
}

// This is admission policy, never evidence of execution or a financial result.
// Only a well-formed, current zero-reservation request may move to background
// review. Legacy reservations and damaged snapshots remain blocking. The delay
// starts when the server recorded unknown, not from a caller-provided clock.
func (r PiknoLLMRequest) AdmissionBlocking(now int64) bool {
	switch r.State {
	case "settled", "released":
		return false
	case "unknown":
		alias, inputRate, outputRate := piknoLLMPrice(r.PriceVersion)
		if r.admissionRecordIncomplete || r.UserID <= 0 || r.TokenID <= 0 || !piknoLLMRequestID.MatchString(r.RequestID) || !piknoLLMBodyDigest.MatchString(r.BodySHA256) ||
			r.ID != fmt.Sprintf("%x", sha256.Sum256(fmt.Appendf(nil, "%d:%s", r.UserID, r.RequestID))) ||
			alias == "" || r.Model != alias || r.BillingMode != PiknoLLMBillingMode ||
			r.InputRate != inputRate || r.OutputRate != outputRate || r.ProviderInputRate < 0 || r.ProviderOutputRate < 0 ||
			r.InputLimit != 0 || r.OutputLimit <= 0 || r.OutputLimit > PiknoLLMMaxOutputTokens ||
			r.ReservedQuota != 0 || r.ChargedQuota != 0 || r.RefundedQuota != 0 ||
			r.InputTokens != 0 || r.OutputTokens != 0 || r.CachedTokens != 0 || r.EstimatedCostQuota != nil ||
			r.CreatedAt <= 0 || r.UpdatedAt < r.CreatedAt || r.UpdatedAt > now {
			return true
		}
		// Subtraction is safe after validating positive, ordered timestamps.
		return now-r.UpdatedAt < PiknoLLMUnknownReviewCooldownSeconds
	default:
		return true
	}
}

func (r PiknoLLMRequest) CustomerView() PiknoLLMView {
	view := PiknoLLMView{RequestID: r.RequestID, State: r.State, Status: r.State, Currency: "CNY", Model: r.Model, PriceVersion: r.PriceVersion, BillingMode: r.BillingMode, ReservedQuota: r.ReservedQuota, ChargedQuota: r.ChargedQuota, RefundedQuota: r.RefundedQuota, InputTokens: r.InputTokens, OutputTokens: r.OutputTokens, ReviewRequired: r.State == "unknown"}
	view.AdmissionBlocking = r.AdmissionBlocking(common.GetTimestamp())
	if r.State == "settled" {
		view.Usage = &PiknoLLMUsageView{r.InputTokens, r.OutputTokens, r.CachedTokens}
	}
	return view
}

func MigratePiknoLLM(db *gorm.DB) error { return db.AutoMigrate(&PiknoLLMRequest{}) }

// Explicit offline deployment preparation only; startup never grants groups.
// Both ratio representations must agree before this additive transaction.
func MigratePiknoLLMGroups(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		keys := []string{"GroupRatio", "group_ratio_setting.group_ratio", "UserUsableGroups"}
		var options []Option
		if err := lockForUpdate(tx).Where(map[string]any{"key": keys}).Find(&options).Error; err != nil {
			return err
		}
		rows := map[string]string{}
		for _, o := range options {
			rows[o.Key] = o.Value
		}
		legacy, canonical := map[string]float64{}, map[string]float64{}
		usable := map[string]string{}
		if len(rows) != 3 || common.UnmarshalJsonStr(rows[keys[0]], &legacy) != nil || common.UnmarshalJsonStr(rows[keys[1]], &canonical) != nil || common.UnmarshalJsonStr(rows[keys[2]], &usable) != nil || legacy == nil || canonical == nil || usable == nil {
			return errors.New("LLM group migration requires valid existing policies")
		}
		if !maps.Equal(legacy, canonical) {
			return errors.New("LLM group migration refuses divergent ratio policies")
		}
		if rate, ok := legacy[PiknoLLMGroup]; ok && rate != 1 {
			return errors.New("LLM group already has a different ratio")
		}
		legacy[PiknoLLMGroup] = 1
		if _, ok := usable[PiknoLLMGroup]; !ok {
			usable[PiknoLLMGroup] = "对话 Key"
		}
		ratioJSON, err := common.Marshal(legacy)
		if err != nil {
			return err
		}
		usableJSON, err := common.Marshal(usable)
		if err != nil {
			return err
		}
		for _, key := range keys {
			value := string(ratioJSON)
			if key == keys[2] {
				value = string(usableJSON)
			}
			if err := tx.Model(&Option{}).Where(&Option{Key: key}).Update("value", value).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func PiknoLLMQuota(input, output int) (int, error) {
	return piknoLLMTokenQuota(input, output, 9, 45, 0, 0)
}

func piknoLLMTokenQuota(input, output, inputRate, outputRate, cachedInput, cachedRate int) (int, error) {
	if input < 0 || output < 0 || input > common.MaxQuota || output > common.MaxQuota || cachedInput < 0 || cachedInput > input {
		return 0, errors.New("invalid LLM token quantity")
	}
	if inputRate < 0 || outputRate < 0 || cachedRate < 0 {
		return 0, errors.New("invalid LLM price snapshot")
	}
	// 1 CNY = 1e6 quota, so CNY/Mtoken numerically equals quota/token.
	uncached := decimal.NewFromInt(int64(input - cachedInput)).Mul(decimal.NewFromInt(int64(inputRate)))
	cache := decimal.NewFromInt(int64(cachedInput)).Mul(decimal.NewFromInt(int64(cachedRate)))
	completion := decimal.NewFromInt(int64(output)).Mul(decimal.NewFromInt(int64(outputRate)))
	return common.QuotaFromDecimalStrict(uncached.Add(cache).Add(completion))
}

func piknoLLMKeyAllowed(user *User, token *Token, alias string) bool {
	if user.Status != common.UserStatusEnabled || token.UserId != user.Id || token.Status != common.TokenStatusEnabled || token.Group != PiknoLLMGroup || (token.ExpiredTime != -1 && token.ExpiredTime <= common.GetTimestamp()) {
		return false
	}
	return !token.ModelLimitsEnabled || token.GetModelLimitsMap()[alias]
}

func GetPiknoLLMRequest(userID int, requestID string) (*PiknoLLMRequest, error) {
	if userID <= 0 || !piknoLLMRequestID.MatchString(requestID) {
		return nil, gorm.ErrRecordNotFound
	}
	var row piknoLLMAdmissionRow
	err := piknoLLMAdmissionQuery(DB).Where("user_id = ? AND request_id = ?", userID, requestID).First(&row).Error
	r := row.request()
	return &r, err
}

func ReservePiknoLLM(userID, tokenID int, requestID, digest, version string, outputLimit int) (*PiknoLLMRequest, bool, error) {
	if err := piknoSettlementGate(); err != nil {
		return nil, false, err
	}
	alias, inputRate, outputRate := piknoLLMPrice(version)
	if userID <= 0 || tokenID <= 0 || !piknoLLMRequestID.MatchString(requestID) || len(digest) != 64 || alias == "" || outputLimit <= 0 || outputLimit > PiknoLLMMaxOutputTokens {
		return nil, false, errors.New("invalid LLM reservation")
	}
	costStatus := "user_provided_unverified"
	if version == PiknoLLMArkPriceVersion {
		costStatus = "published_rate_unverified_receipt"
	}
	var r PiknoLLMRequest
	created := false
	err := DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		var oldRow piknoLLMAdmissionRow
		err := piknoLLMAdmissionQuery(tx).Where("user_id = ? AND request_id = ?", userID, requestID).First(&oldRow).Error
		if err == nil {
			old := oldRow.request()
			if old.TokenID != tokenID || old.BodySHA256 != digest || old.PriceVersion != version {
				return ErrPiknoLLMConflict
			}
			r = old
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var token Token
		if err := lockForUpdate(tx).First(&token, tokenID).Error; err != nil {
			return err
		}
		if !piknoLLMKeyAllowed(&user, &token, alias) {
			return ErrPiknoLLMPermission
		}
		var active []piknoLLMAdmissionRow
		// Include NULL/unknown states instead of letting SQL three-valued logic
		// silently remove damaged records. The user lock serializes admission
		// with dispatch and settlement; each pending row uses the view's policy.
		if err := piknoLLMAdmissionQuery(tx).Where("user_id = ? AND (state IS NULL OR state NOT IN ?)", userID, []string{"settled", "released"}).Find(&active).Error; err != nil {
			return err
		}
		now := common.GetTimestamp()
		for _, pending := range active {
			if pending.request().AdmissionBlocking(now) {
				return ErrPiknoLLMBusy
			}
		}
		if user.Quota <= 0 || (!token.UnlimitedQuota && token.RemainQuota <= 0) {
			return ErrPiknoLLMQuota
		}
		// A zero-value durable slot serializes this user's live paid requests. It is
		// not an estimated charge or a promise that the remaining balance covers
		// the answer. Authoritative usage is charged in full, including debt.
		r = PiknoLLMRequest{ID: fmt.Sprintf("%x", sha256.Sum256(fmt.Appendf(nil, "%d:%s", userID, requestID))), UserID: userID, RequestID: requestID, TokenID: tokenID, BodySHA256: digest, Model: alias, PriceVersion: version, BillingMode: PiknoLLMBillingMode, InputRate: inputRate, OutputRate: outputRate, ProviderInputRate: 6, ProviderOutputRate: 30, CostStatus: costStatus, CostEstimateRule: "nominal_no_cache_discount", OutputLimit: outputLimit, State: "reserved", TokenLimited: !token.UnlimitedQuota, CreatedAt: now, UpdatedAt: now}
		if err := tx.Create(&r).Error; err != nil {
			return err
		}
		created = true
		return nil
	})
	return &r, created, err
}

// State is durably marked before any potentially billable network operation.
func DispatchPiknoLLM(userID int, requestID string) error {
	return DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		var r PiknoLLMRequest
		if err := lockForUpdate(tx).Where("user_id = ? AND request_id = ?", userID, requestID).First(&r).Error; err != nil {
			return err
		}
		if r.State != "reserved" {
			return ErrPiknoLLMConflict
		}
		var token Token
		if err := lockForUpdate(tx).First(&token, r.TokenID).Error; err != nil {
			return err
		}
		if !piknoLLMKeyAllowed(&user, &token, r.Model) {
			return ErrPiknoLLMPermission
		}
		if r.BillingMode != PiknoLLMBillingMode || r.ReservedQuota != 0 {
			return errors.New("LLM dispatch requires the current billing policy")
		}
		if user.Quota <= 0 || (!token.UnlimitedQuota && token.RemainQuota <= 0) {
			return ErrPiknoLLMQuota
		}
		return tx.Model(&r).Updates(map[string]any{"state": "dispatched", "updated_at": common.GetTimestamp()}).Error
	})
}

// Evidence is authoritative bounded usage, proven-not-submitted, an authenticated
// rejection before execution, or unknown. A rejection is not a missing POST.
// There is deliberately no time-based or caller-selected refund operation.
func FinishPiknoLLM(userID int, requestID, outcome string, input, output int, cached ...int) (*PiknoLLMRequest, error) {
	if err := piknoSettlementGate(); err != nil {
		return nil, err
	}
	var r PiknoLLMRequest
	err := DB.Transaction(func(tx *gorm.DB) error {
		var user User
		if err := lockForUpdate(tx).First(&user, userID).Error; err != nil {
			return err
		}
		if err := lockForUpdate(tx).Where("user_id = ? AND request_id = ?", userID, requestID).First(&r).Error; err != nil {
			return err
		}
		if r.State == "settled" || r.State == "released" {
			return nil
		}
		if outcome == "unknown" {
			r.State = "unknown"
			r.UpdatedAt = common.GetTimestamp()
			return tx.Model(&r).Updates(map[string]any{"state": r.State, "updated_at": r.UpdatedAt}).Error
		}
		if (r.BillingMode != "" && r.BillingMode != PiknoLLMBillingMode) || r.ReservedQuota < 0 || r.ReservedQuota > common.MaxQuota || (r.BillingMode == PiknoLLMBillingMode && r.ReservedQuota != 0) {
			return errors.New("invalid LLM billing policy snapshot")
		}
		charge := 0
		switch outcome {
		case "not_submitted", "rejected_before_execution":
			if input != 0 || output != 0 || (outcome == "rejected_before_execution" && r.State == "reserved") {
				return errors.New("invalid LLM release evidence")
			}
		case "usage":
			if input < 0 || output < 0 || output > r.OutputLimit || r.State == "reserved" || (r.BillingMode == "" && input > r.InputLimit) {
				return errors.New("LLM usage exceeds its accepted bounds")
			}
			if len(cached) > 1 || (len(cached) == 1 && (cached[0] < 0 || cached[0] > input)) {
				return errors.New("invalid cached token usage")
			}
			cachedInput, cachedRate := 0, 0
			if r.Model == PiknoLLMArkModel || r.PriceVersion == PiknoLLMArkPriceVersion {
				if r.Model != PiknoLLMArkModel || r.PriceVersion != PiknoLLMArkPriceVersion || r.BillingMode != PiknoLLMBillingMode ||
					r.InputRate != PiknoLLMArkInputRate || r.OutputRate != PiknoLLMArkOutputRate {
					return errors.New("invalid Ark LLM price snapshot")
				}
				cachedRate = PiknoLLMArkCachedInputRate
				if len(cached) == 1 {
					cachedInput = cached[0]
				}
			}
			var err error
			charge, err = piknoLLMTokenQuota(input, output, r.InputRate, r.OutputRate, cachedInput, cachedRate)
			if err != nil {
				return err
			}
			if r.BillingMode == "" && charge > r.ReservedQuota {
				return errors.New("LLM charge exceeds reservation")
			}
			// This is only the user's nominal cost estimate. No receipt, cache
			// price or context tier has been verified, so it is never actual cost.
			estimate, err := piknoLLMTokenQuota(input, output, r.ProviderInputRate, r.ProviderOutputRate, 0, 0)
			if err != nil {
				return err
			}
			r.EstimatedCostQuota = &estimate
		default:
			return errors.New("unsupported LLM outcome")
		}
		// The signed difference can debit an accepted actual-usage request past
		// zero. Only a positive difference is a refund. Legacy prepaid rows keep
		// their original reservation and may only refund the unspent portion.
		delta := r.ReservedQuota - charge
		userQuota, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(user.Quota)).Add(decimal.NewFromInt(int64(delta))))
		if err != nil {
			return err
		}
		userUsed, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(user.UsedQuota)).Add(decimal.NewFromInt(int64(charge))))
		if err != nil {
			return err
		}
		requestCount := user.RequestCount
		if outcome == "usage" {
			requestCount, err = common.QuotaFromDecimalStrict(decimal.NewFromInt(int64(requestCount)).Add(decimal.NewFromInt(1)))
			if err != nil {
				return err
			}
		}
		var token Token
		// A key revoked or deleted after execution still owes that execution's
		// usage. It gains no new access: this only settles the original row.
		if err := lockForUpdate(tx.Unscoped()).Where("id = ? AND user_id = ?", r.TokenID, userID).First(&token).Error; err != nil {
			return err
		}
		tokenUsed, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(token.UsedQuota)).Add(decimal.NewFromInt(int64(charge))))
		if err != nil {
			return err
		}
		tokenUpdates := map[string]any{"used_quota": tokenUsed}
		if r.TokenLimited {
			remain, err := common.WalletQuotaFromDecimalStrict(decimal.NewFromInt(int64(token.RemainQuota)).Add(decimal.NewFromInt(int64(delta))))
			if err != nil {
				return err
			}
			tokenUpdates["remain_quota"] = remain
		}
		if err := tx.Model(&User{}).Where("id = ?", userID).Updates(map[string]any{"quota": userQuota, "used_quota": userUsed, "request_count": requestCount}).Error; err != nil {
			return err
		}
		if err := tx.Unscoped().Model(&Token{}).Where("id = ? AND user_id = ?", r.TokenID, userID).Updates(tokenUpdates).Error; err != nil {
			return err
		}
		r.State = "released"
		if outcome == "usage" {
			r.State = "settled"
		}
		r.ChargedQuota = charge
		r.RefundedQuota = max(delta, 0)
		r.InputTokens = input
		r.OutputTokens = output
		if len(cached) == 1 {
			r.CachedTokens = cached[0]
		}
		r.UpdatedAt = common.GetTimestamp()
		return tx.Save(&r).Error
	})
	return &r, err
}
