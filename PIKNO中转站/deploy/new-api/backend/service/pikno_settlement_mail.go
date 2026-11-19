package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"os"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

type PiknoSettlementMailer interface {
	Send(context.Context, *model.PiknoSettlementOutbox) error
}
type PiknoResendMailer struct {
	Client *http.Client
	Key    string
	From   string
}

func (m PiknoResendMailer) Send(ctx context.Context, item *model.PiknoSettlementOutbox) error {
	if item.Kind == "customer_status" {
		return errors.New("customer consumption emails are disabled")
	}
	if m.Key == "" || m.From == "" {
		return errors.New("settlement mail sender is not configured")
	}
	var view model.PiknoSettlementView
	if err := common.UnmarshalJsonStr(item.Payload, &view); err != nil {
		return err
	}
	state := map[string]string{"reserved": "额度已预留", "pending_review": "待人工核对", "settled": "已结算", "partially_refunded": "已部分退款", "refunded": "已全额退款"}[view.FinancialState]
	if state == "" {
		return errors.New("unsupported financial notification state")
	}
	subject := "PIKNO 订单账务通知"
	if item.Kind == "admin_review_reminder" {
		subject = "PIKNO 待核对订单提醒"
	}
	body := fmt.Sprintf("<p>订单：%s</p><p>账务状态：%s</p><p>预留：¥%.6f；净消费：¥%.6f；累计退款：¥%.6f</p><p>预留不代表最终消费。请登录 <a href=\"https://www.piknoai.com/settlements\">PIKNO 账单</a> 查看最新状态。</p>", html.EscapeString(view.OrderID), state, float64(view.ReservedQuota)/1000000, float64(view.NetQuota)/1000000, float64(view.RefundedQuota)/1000000)
	payload, err := common.Marshal(map[string]any{"from": m.From, "to": []string{item.Recipient}, "subject": subject, "html": body})
	if err != nil {
		return err
	}
	if err := model.FreezePiknoSettlementMail(item, string(payload)); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.resend.com/emails", bytes.NewBufferString(item.DeliveryPayload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", fmt.Sprintf("pikno-settlement-%d", item.ID))
	response, err := m.Client.Do(req)
	if err != nil {
		return errors.New("settlement mail network failure")
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return fmt.Errorf("settlement mail rejected: HTTP %d", response.StatusCode)
	}
	return nil
}

// Bounded batch; email failure does not replay financial operations. Recipient,
// payload and idempotency key stay fixed across attempts and process restarts.
func DeliverPiknoSettlementMail(ctx context.Context, mailer PiknoSettlementMailer, now int64) error {
	var items []model.PiknoSettlementOutbox
	if err := model.DB.Where("delivered_at = 0 AND next_attempt_at <= ? AND lease_until <= ? AND delivery_state <> ? AND kind <> ?", now, now, "manual_review", "customer_status").Order("id").Limit(20).Find(&items).Error; err != nil {
		return err
	}
	for _, candidate := range items {
		item, err := model.ClaimPiknoSettlementMail(candidate.ID, now)
		if err != nil {
			return err
		}
		if item == nil {
			continue
		}
		err = mailer.Send(ctx, item)
		if finishErr := model.FinishPiknoSettlementMail(item, common.GetTimestamp(), err == nil); finishErr != nil {
			return finishErr
		}
	}
	return nil
}

func RunPiknoSettlementNotifications(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	cursor := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		var err error
		cursor, err = ReconcilePiknoSettlements(cursor, common.GetTimestamp())
		if err != nil {
			common.SysError("PIKNO financial reconciliation requires attention")
		}
		if _, err := model.QueuePiknoSettlementReviewReminders(common.GetTimestamp(), 100); err != nil {
			common.SysError("PIKNO review reminder scan failed")
		}
		key := os.Getenv("PIKNO_SETTLEMENT_RESEND_KEY")
		if key == "" && common.SMTPServer == "smtp.resend.com" {
			key = common.SMTPToken
		}
		if key == "" {
			continue
		}
		mailer := PiknoResendMailer{Client: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, Key: key, From: common.SMTPFrom}
		if err := DeliverPiknoSettlementMail(ctx, mailer, common.GetTimestamp()); err != nil {
			common.SysError("PIKNO settlement notification delivery requires attention")
		}
	}
}
