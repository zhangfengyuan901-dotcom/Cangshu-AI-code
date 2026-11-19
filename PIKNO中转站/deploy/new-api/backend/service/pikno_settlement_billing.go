package service

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const BillingSourcePikno = "pikno_unified_v1"

func PiknoSettlementEnabled() bool { return os.Getenv("PIKNO_SETTLEMENT_ENABLED") == "true" }

// Wallet-only rollout. Refuse startup rather than silently mixing authoritative
// SQL balances with Redis reservations or delayed legacy batch writes.
func InitPiknoSettlement() error {
	if err := model.MigratePiknoLines(model.DB); err != nil {
		return err
	}
	if !PiknoSettlementEnabled() {
		return nil
	}
	if common.RedisEnabled || common.BatchUpdateEnabled || os.Getenv("BATCH_UPDATE_ENABLED") == "true" {
		return errors.New("PIKNO settlement requires DB-only wallet mode")
	}
	return model.MigratePiknoSettlements(model.DB)
}

type PiknoBillingSession struct {
	info       *relaycommon.RelayInfo
	order      *model.PiknoSettlement
	dispatched bool
	completed  bool
	async      bool
}

func IsPiknoBilling(info *relaycommon.RelayInfo) bool {
	return info != nil && info.BillingSource == BillingSourcePikno
}

// Called with the final, validated outbound image count or task quote, after
// channel selection. The key fingerprint snapshots the upstream account without
// persisting usable credentials. No cross-channel retry is allowed after send.
func NewPiknoBillingSession(info *relaycommon.RelayInfo, quota int) error {
	if info == nil || info.ChannelMeta == nil || info.ChannelId <= 0 || info.ApiKey == "" || info.IsPlayground || info.TokenId <= 0 {
		return errors.New("PIKNO billing requires a selected channel and customer token")
	}
	if info.Billing != nil {
		return errors.New("billing session already exists")
	}
	async := info.TaskRelayInfo != nil && info.PublicTaskID != ""
	id := info.RequestId
	if async {
		id = info.PublicTaskID
	} else {
		if id == "" {
			id = common.GetRandomString(32)
		}
		id = "req_" + id
	}
	q := model.PiknoSettlementQuote{ConfirmedSlotID: info.PiknoConfirmedSlot, ConfirmedRevision: info.PiknoConfirmedRevision, ConfirmedQuota: info.PiknoConfirmedQuota, ConfirmedExpires: info.PiknoConfirmedExpires, OrderID: id, UserID: info.UserId, TokenID: info.TokenId, ChannelID: info.ChannelId, Model: info.OriginModelName, AccountRef: fmt.Sprintf("%x", sha256.Sum256([]byte(info.ChannelBaseUrl+"\x00"+info.ApiKey))), PriceMode: "cost_x2", QuoteQuota: quota}
	if info.PiknoImageOperation != "" && (async || info.PiknoLineRevision <= 0 || info.PiknoConfirmedSlot != "") {
		return errors.New("invalid image usage billing context")
	}
	if info.PiknoLineRevision > 0 {
		line, err := model.GetPublishedPiknoLine(info.OriginModelName)
		if err != nil || line.Revision != info.PiknoLineRevision || line.ChannelID != info.ChannelId || info.PiknoLineQuoteQuota != quota || (quota <= 0 && !(quota == 0 && async && model.PiknoLineAllowsZeroQuote(line))) {
			if info.PiknoConfirmedSlot != "" {
				return model.ErrPiknoQuoteChanged
			}
			return errors.New("published line changed before reservation; retry the request")
		}
		q.PriceMode = "line_success_quote"
		q.LineRevision = line.Revision
		q.LineProvider = line.Provider
		q.PriceUnit = info.PiknoLinePriceUnit
		if info.PiknoImageOperation != "" {
			if !PiknoImageUsageAvailable(line) {
				return errors.New("image usage billing is unavailable")
			}
			// The operation key is scoped to the wallet and never sent upstream.
			digest := sha256.Sum256([]byte(fmt.Sprintf("%d\x00%s", info.UserId, info.PiknoImageOperation)))
			q.OrderID = fmt.Sprintf("img_%x", digest)
			q.PriceMode, q.PriceUnit = model.PiknoImageUsageSettlementRule, "token"
		}
		if !async {
			q.RequestedImages = info.ImageRequestCount
			if q.RequestedImages < 1 || q.RequestedImages > dto.MaxImageN {
				return errors.New("invalid image quantity")
			}
		}
	} else {
		if async && (strings.HasPrefix(info.OriginModelName, "sanbao/video/") || strings.HasPrefix(info.OriginModelName, "canseedream/video/")) {
			q.PriceMode = "video_success_quote"
		}
		if info.OriginModelName == "gpt-image-2.5-flare" {
			if async {
				return errors.New("Flare requires its fixed-price HTTP image route")
			}
			count := info.ImageRequestCount
			if count < 1 || count > dto.MaxImageN {
				return errors.New("invalid image quantity")
			}
			q.PriceMode = "flare_fixed"
			q.RequestedImages = count
			q.QuoteQuota = count * 100000
		}
	}
	if q.QuoteQuota <= 0 && !(async && q.PriceMode == "line_success_quote" && q.Model == "pikno-tool-depth" && q.QuoteQuota == 0) {
		return errors.New("a positive accepted quote is required")
	}
	order, err := model.ReservePiknoSettlement(q)
	if err != nil {
		return err
	}
	info.BillingSource = BillingSourcePikno
	info.FinalPreConsumedQuota = order.ReservedQuota
	info.Billing = &PiknoBillingSession{info: info, order: order, async: async}
	return nil
}

// This guard runs directly before the outbound call, never after it. A timeout
// must not cause a second potentially billable upstream generation.
func PiknoBeforeDispatch(info *relaycommon.RelayInfo) error {
	if !PiknoSettlementEnabled() {
		return nil
	}
	s, ok := info.Billing.(*PiknoBillingSession)
	if !ok || s.dispatched || info.ChannelId != s.order.ChannelID || fmt.Sprintf("%x", sha256.Sum256([]byte(info.ChannelBaseUrl+"\x00"+info.ApiKey))) != s.order.AccountRef {
		return errors.New("PIKNO submission is not reserved or was already dispatched")
	}
	s.dispatched = true
	return nil
}

func (s *PiknoBillingSession) GetPreConsumedQuota() int { return s.order.QuoteQuota }
func (s *PiknoBillingSession) NeedsRefund() bool        { return !s.completed }
func (s *PiknoBillingSession) Reserve(quota int) error {
	if quota < 0 || quota > common.MaxQuota {
		return errors.New("invalid settlement quote")
	}
	// A submit-time estimate is not a final receipt. Persist the task even if
	// its estimate changes; the engine never charges beyond the accepted quote.
	return nil
}
func (s *PiknoBillingSession) Refund(_ *gin.Context) {
	if s.completed {
		return
	}
	outcome := "unknown"
	if s.info.PiknoExplicitFailure {
		outcome = "failed"
	}
	if err := PiknoObserveSettlement(s.order.ID, outcome, 0); err != nil {
		common.SysError("PIKNO failed submission requires reconciliation")
		return
	}
	s.completed = true
}
func (s *PiknoBillingSession) Settle(_ int) error {
	if s.completed || s.async {
		return nil
	}
	outcome, count := "unknown", 0
	if s.info.PiknoDeliveredImages != nil {
		outcome, count = "succeeded", *s.info.PiknoDeliveredImages
	}
	var actualQuota *int
	if s.order.PriceMode == model.PiknoImageUsageSettlementRule && count == s.order.RequestedImages {
		if amount, err := PiknoImageUsageQuota(s.info.PiknoImageUsage); err == nil {
			actualQuota = &amount
		}
	}
	if err := piknoObserveSettlement(s.order.ID, outcome, count, actualQuota); err != nil {
		return err
	}
	s.completed = true
	return nil
}

// Observation IDs are server-defined and include the outcome/count. Optimistic
// races are retried by the durable reconciler; never fall back to legacy money.
func PiknoObserveSettlement(id, outcome string, images int) error {
	return piknoObserveSettlement(id, outcome, images, nil)
}

func piknoObserveSettlement(id, outcome string, images int, actualQuota *int) error {
	op := fmt.Sprintf("observed-%s-%d", outcome, images)
	if actualQuota != nil {
		op = fmt.Sprintf("%s-usage-%d", op, *actualQuota)
	}
	var event model.PiknoSettlementEvent
	err := model.DB.Where("order_id = ? AND operation_id = ?", id, op).First(&event).Error
	if err == nil {
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	var order model.PiknoSettlement
	if err := model.DB.First(&order, "id = ?", id).Error; err != nil {
		return err
	}
	_, err = model.ApplyPiknoSettlement(model.PiknoSettlementCommand{OrderID: id, OperationID: op, ExpectedVersion: order.Version, Action: "observe", Outcome: outcome, Images: images, ImageUsageQuota: actualQuota})
	return err
}

func PiknoRecordTask(task *model.Task) error {
	if task.PrivateData.BillingSource != BillingSourcePikno {
		return nil
	}
	var order model.PiknoSettlement
	if err := model.DB.First(&order, "id = ?", task.TaskID).Error; err != nil {
		return err
	}
	if order.UserID != task.UserId || order.ChannelID != task.ChannelId {
		return errors.New("task settlement identity mismatch")
	}
	if order.UpstreamTaskID == "" && task.PrivateData.UpstreamTaskID != "" {
		if _, err := model.ApplyPiknoSettlement(model.PiknoSettlementCommand{OrderID: order.ID, OperationID: "task-bind", ExpectedVersion: order.Version, Action: "bind", UpstreamTaskID: task.PrivateData.UpstreamTaskID}); err != nil {
			return err
		}
	}
	if order.PriceMode == "video_success_quote" || order.PriceMode == "line_success_quote" {
		if task.Status != model.TaskStatusSuccess && task.Status != model.TaskStatusFailure {
			return nil
		}
		if order.UpstreamTaskID != "" && order.UpstreamTaskID != task.PrivateData.UpstreamTaskID {
			return PiknoObserveSettlement(order.ID, "unknown", 0)
		}
		if order.LineProvider == "hamster-tools" {
			var raw struct {
				ID      string `json:"id"`
				Status  string `json:"status"`
				Outputs []struct {
					Type string `json:"type"`
					URL  string `json:"url"`
				} `json:"outputs"`
			}
			if common.Unmarshal(task.Data, &raw) != nil || raw.ID == "" || raw.ID != task.PrivateData.UpstreamTaskID {
				return PiknoObserveSettlement(order.ID, "unknown", 0)
			}
			if raw.Status == "failed" && task.Status == model.TaskStatusFailure {
				return PiknoObserveSettlement(order.ID, "failed", 0)
			}
			if raw.Status == "completed" && task.Status == model.TaskStatusSuccess && len(raw.Outputs) == 1 && raw.Outputs[0].Type == "video" {
				u, err := url.Parse(raw.Outputs[0].URL)
				if err == nil && u.Scheme == "https" && u.Host == "www.piknoai.com" && u.User == nil && u.Fragment == "" && strings.HasPrefix(u.Path, "/media/v1/assets/") && u.Query().Get("ticket") != "" {
					return PiknoObserveSettlement(order.ID, "succeeded", 0)
				}
			}
			return PiknoObserveSettlement(order.ID, "unknown", 0)
		}
		// The host may mark local polling exhaustion as FAILURE. Only a matching
		// provider terminal response can release money or charge the quote.
		var raw struct {
			ID       string `json:"id"`
			Status   string `json:"status"`
			VideoURL string `json:"video_url"`
			Content  struct {
				VideoURL string `json:"video_url"`
			} `json:"content"`
			Data struct {
				ID       string `json:"id"`
				Status   string `json:"status"`
				VideoURL string `json:"video_url"`
			} `json:"data"`
		}
		if err := common.Unmarshal(task.Data, &raw); err != nil {
			return PiknoObserveSettlement(order.ID, "unknown", 0)
		}
		id, status, media := raw.ID, raw.Status, raw.Content.VideoURL
		if strings.HasPrefix(order.Model, "sanbao/video/") || order.LineProvider == "sanbao" {
			id, status, media = raw.Data.ID, raw.Data.Status, raw.Data.VideoURL
		}
		if id == "" || id != task.PrivateData.UpstreamTaskID {
			return PiknoObserveSettlement(order.ID, "unknown", 0)
		}
		if status == "failed" && task.Status == model.TaskStatusFailure {
			return PiknoObserveSettlement(order.ID, "failed", 0)
		}
		if status == "succeeded" && task.Status == model.TaskStatusSuccess {
			u, err := url.Parse(media)
			if err == nil && u.Scheme == "https" && u.Host != "" {
				return PiknoObserveSettlement(order.ID, "succeeded", 0)
			}
		}
		return PiknoObserveSettlement(order.ID, "unknown", 0)
	}
	if task.Status == model.TaskStatusSuccess {
		return PiknoObserveSettlement(order.ID, "succeeded", 0)
	}
	if task.Status == model.TaskStatusFailure {
		return PiknoObserveSettlement(order.ID, "failed", 0)
	}
	return nil
}

// Keyset scan prevents long-running tasks from starving later terminal tasks.
// Covers process death between task persistence and accounting, and abandoned
// HTTP reservations. Timeouts only enter review: funds are never auto-released.
func ReconcilePiknoSettlements(cursor string, now int64) (string, error) {
	var orders []model.PiknoSettlement
	if err := model.DB.Where("id > ? AND settled_outcome = ?", cursor, "").Order("id").Limit(100).Find(&orders).Error; err != nil {
		return cursor, err
	}
	if len(orders) == 0 {
		return "", nil
	}
	var scanErr error
	for _, order := range orders {
		cursor = order.ID
		var task model.Task
		err := model.DB.Where("task_id = ? AND user_id = ?", order.ID, order.UserID).First(&task).Error
		if err == nil {
			if err = PiknoRecordTask(&task); err != nil {
				scanErr = err
				continue
			}
		}
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			scanErr = err
			continue
		}
		if order.FinancialState == "reserved" && now-order.CreatedAt >= 86400 {
			if err := PiknoObserveSettlement(order.ID, "unknown", 0); err != nil {
				scanErr = err
			}
		}
	}
	return cursor, scanErr
}
