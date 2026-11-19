package controller

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

const lanjingPaymentSignatureHeader = "X-PIKNO-Payment-Sign"

var (
	lanjingTradeNumber  = regexp.MustCompile(`^USR[1-9][0-9]*NO[A-Za-z0-9]{1,64}$`)
	lanjingOrderID      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	epayMoney           = regexp.MustCompile(`^[0-9]{1,16}(\.[0-9]{1,2})?$`)
	lanjingBridgeClient = &http.Client{
		Timeout:       25 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
)

type lanjingCheckoutRequest struct {
	TradeNo         string `json:"trade_no"`
	ProviderOrderID string `json:"provider_order_id,omitempty"`
	PaymentMethod   string `json:"payment_method"`
	Money           string `json:"money"`
	ReallyPrice     string `json:"really_price,omitempty"`
}

type lanjingCheckoutStatus struct {
	Status          string `json:"status"`
	ProviderOrderID string `json:"provider_order_id"`
	ReallyPrice     string `json:"really_price"`
	CanCreate       bool   `json:"can_create"`
}

func isLanjingPayAddress() bool {
	configured, err := url.Parse(operation_setting.PayAddress)
	return err == nil && configured.Host != "" && strings.TrimRight(configured.Path, "/") == "/pay/lanjing/epay"
}

func lanjingBridgeOrigin() string {
	if !isLanjingPayAddress() {
		return ""
	}
	origin := strings.TrimSpace(os.Getenv("PIKNO_LANJING_BRIDGE_INTERNAL_URL"))
	if origin == "" {
		origin = "http://lanjing-bridge:8080"
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.TrimRight(parsed.Path, "/") != "" {
		return ""
	}
	return strings.TrimRight(parsed.String(), "/")
}

func lanjingPaymentSignature(path string, body []byte) []byte {
	mac := hmac.New(sha256.New, []byte(operation_setting.EpayKey))
	_, _ = io.WriteString(mac, "POST\n"+path+"\n")
	_, _ = mac.Write(body)
	return mac.Sum(nil)
}

func lanjingCheckoutKey() string {
	mac := hmac.New(sha256.New, []byte(operation_setting.EpayKey))
	_, _ = io.WriteString(mac, "pikno-checkout-v2")
	return hex.EncodeToString(mac.Sum(nil))
}

func LanjingClaimCheckout(c *gin.Context) { lanjingManageCheckout(c, false) }

func LanjingBindCheckout(c *gin.Context) { lanjingManageCheckout(c, true) }

func lanjingManageCheckout(c *gin.Context, bind bool) {
	if operation_setting.EpayKey == "" || lanjingBridgeOrigin() == "" || c.Request.URL.RawQuery != "" {
		c.Status(http.StatusForbidden)
		return
	}
	values := c.Request.Header.Values(lanjingPaymentSignatureHeader)
	if len(values) != 1 || len(values[0]) != sha256.Size*2 {
		c.Status(http.StatusForbidden)
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 2049))
	if err != nil || len(body) > 2048 {
		c.Status(http.StatusBadRequest)
		return
	}
	signature, err := hex.DecodeString(values[0])
	if err != nil || !hmac.Equal(signature, lanjingPaymentSignature(c.Request.URL.Path, body)) {
		c.Status(http.StatusForbidden)
		return
	}
	var req lanjingCheckoutRequest
	if common.Unmarshal(body, &req) != nil || len(req.TradeNo) > 100 || !lanjingTradeNumber.MatchString(req.TradeNo) ||
		(req.PaymentMethod != "alipay" && req.PaymentMethod != "wxpay") || !epayMoney.MatchString(req.Money) ||
		(bind && (!lanjingOrderID.MatchString(req.ProviderOrderID) || !epayMoney.MatchString(req.ReallyPrice))) ||
		(!bind && (req.ProviderOrderID != "" || req.ReallyPrice != "")) {
		c.Status(http.StatusBadRequest)
		return
	}
	amount, err := decimal.NewFromString(req.Money)
	if err != nil || !amount.IsPositive() {
		c.Status(http.StatusBadRequest)
		return
	}
	var order *model.TopUp
	var canCreate bool
	if bind {
		actual, parseErr := decimal.NewFromString(req.ReallyPrice)
		if parseErr != nil || !actual.IsPositive() {
			c.Status(http.StatusBadRequest)
			return
		}
		order, err = model.BindLanjingCheckout(req.TradeNo, req.PaymentMethod, amount, req.ProviderOrderID, actual.StringFixed(2))
	} else {
		order, canCreate, err = model.ClaimLanjingCheckout(req.TradeNo, req.PaymentMethod, amount)
	}
	if err != nil {
		if errors.Is(err, model.ErrTopUpNotFound) || errors.Is(err, model.ErrTopUpStatusInvalid) ||
			errors.Is(err, model.ErrPaymentMethodMismatch) || errors.Is(err, model.ErrTopUpAmountMismatch) {
			c.Status(http.StatusConflict)
		} else {
			c.Status(http.StatusServiceUnavailable)
		}
		return
	}
	common.ApiSuccess(c, lanjingCheckoutStatus{Status: order.Status, ProviderOrderID: order.EpayGatewayOrderID,
		ReallyPrice: order.EpayGatewayReallyPrice, CanCreate: canCreate})
}

func EpayOrderStatus(c *gin.Context) {
	tradeNo := c.Query("trade_no")
	if len(tradeNo) > 100 || !lanjingTradeNumber.MatchString(tradeNo) {
		common.ApiErrorMsg(c, "订单号无效")
		return
	}
	order, err := model.GetUserEpayTopUp(c.GetInt("id"), tradeNo)
	if err != nil {
		common.ApiErrorMsg(c, "无法查询此充值订单")
		return
	}
	if order.Status == common.TopUpStatusClosing {
		separate := lanjingOrderLookup(c.Request.Context(), order, "/pay/lanjing/internal/lookup") == "provider_order_missing"
		if updated, err := model.GetUserEpayTopUp(order.UserId, order.TradeNo); err == nil {
			respondEpayOrderStatus(c, updated, separate && updated.Status == common.TopUpStatusClosing)
		} else {
			common.ApiErrorMsg(c, "无法查询此充值订单")
		}
		return
	}
	if reconcileLanjingCheckout(c.Request.Context(), order) {
		if updated, err := model.GetUserEpayTopUp(order.UserId, order.TradeNo); err == nil {
			order = updated
		}
	}
	respondEpayOrderStatus(c, order, false)
}

func EpayCancelOrder(c *gin.Context) {
	var req struct {
		TradeNo string `json:"trade_no"`
	}
	if c.ShouldBindJSON(&req) != nil || len(req.TradeNo) > 100 || !lanjingTradeNumber.MatchString(req.TradeNo) {
		common.ApiErrorMsg(c, "订单号无效")
		return
	}
	order, err := model.BeginLanjingCancellation(c.GetInt("id"), req.TradeNo)
	if err != nil {
		common.ApiErrorMsg(c, "此订单无法在线取消，请核对支付状态")
		return
	}
	if reconcileLanjingCheckout(c.Request.Context(), order) {
		if updated, err := model.GetUserEpayTopUp(order.UserId, order.TradeNo); err == nil {
			order = updated
		}
	}
	respondEpayOrderStatus(c, order, false)
}

func respondEpayOrderStatus(c *gin.Context, order *model.TopUp, separate bool) {
	common.ApiSuccess(c, gin.H{"trade_no": order.TradeNo, "status": order.Status, "payment_method": order.PaymentMethod,
		"money": order.Money, "checkout_state": epayCheckoutState(order), "separate_payment_allowed": separate,
		"cancellable": order.EpayClaimedAt != nil && order.Status == common.TopUpStatusPending})
}

func epayCheckoutState(order *model.TopUp) string {
	if order.PaymentProvider != model.PaymentProviderEpay || order.Status != common.TopUpStatusPending {
		return ""
	}
	if order.EpayClaimedAt == nil {
		return "legacy_review"
	}
	if *order.EpayClaimedAt == 0 && order.EpayGatewayOrderID == "" {
		return "ready"
	}
	if *order.EpayClaimedAt > 0 && lanjingOrderID.MatchString(order.EpayGatewayOrderID) && epayMoney.MatchString(order.EpayGatewayReallyPrice) {
		return "ready"
	}
	return "review"
}

// Resume signs only the owner's existing order. The bridge still performs the
// atomic claim and verifies the provider order before opening its cashier.
func EpayResumeCheckout(c *gin.Context) {
	userID := c.GetInt("id")
	if flowID := c.GetHeader("X-Hamster-Desktop-Flow"); flowID != "" {
		if err := service.ValidateDesktopRecharge(flowID, userID); err != nil {
			writeDesktopFlowError(c, err)
			return
		}
	}
	var req struct {
		TradeNo string `json:"trade_no"`
	}
	if c.ShouldBindJSON(&req) != nil || len(req.TradeNo) > 100 || !lanjingTradeNumber.MatchString(req.TradeNo) {
		common.ApiErrorMsg(c, "订单号无效")
		return
	}
	order, err := model.GetUserEpayTopUp(userID, req.TradeNo)
	if err != nil || epayCheckoutState(order) != "ready" || !isEpayTopUpEnabled() || lanjingBridgeOrigin() == "" ||
		!operation_setting.ContainsPayMethod(order.PaymentMethod) || (order.Money != 50 && order.Money != 100 && order.Money != 200) {
		common.ApiErrorMsg(c, "原订单暂不能继续支付，请刷新订单核对")
		return
	}
	checkout, err := epayCheckoutForm(order.TradeNo, order.PaymentMethod, int64(order.Money), order.Money, true)
	if err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	c.JSON(http.StatusOK, checkout)
}

// A successful provider lookup triggers the bridge's verified callback. Only
// that callback credits the wallet. An unavailable gateway keeps the local
// order pending or closing for the next reconciliation attempt.
func reconcileLanjingCheckout(ctx context.Context, order *model.TopUp) bool {
	path := "/pay/lanjing/internal/status"
	if order.Status == common.TopUpStatusClosing {
		path = "/pay/lanjing/internal/cancel"
	}
	switch status := lanjingOrderLookup(ctx, order, path); status {
	case "paid":
		return true
	case common.TopUpStatusCancelled, common.TopUpStatusExpired:
		return model.RecordLanjingTerminalState(order, status) == nil
	default:
		return false
	}
}

func lanjingOrderLookup(ctx context.Context, order *model.TopUp, path string) string {
	if order.EpayClaimedAt == nil || *order.EpayClaimedAt <= 0 || !lanjingOrderID.MatchString(order.EpayGatewayOrderID) ||
		!epayMoney.MatchString(order.EpayGatewayReallyPrice) || (order.PaymentMethod != "alipay" && order.PaymentMethod != "wxpay") ||
		(order.Status != common.TopUpStatusPending && order.Status != common.TopUpStatusClosing) {
		return ""
	}
	origin := lanjingBridgeOrigin()
	if origin == "" || operation_setting.EpayKey == "" {
		return ""
	}
	body, err := common.Marshal(lanjingCheckoutRequest{TradeNo: order.TradeNo, ProviderOrderID: order.EpayGatewayOrderID,
		PaymentMethod: order.PaymentMethod, Money: strconv.FormatFloat(order.Money, 'f', 2, 64), ReallyPrice: order.EpayGatewayReallyPrice})
	if err != nil {
		return ""
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, origin+path, bytes.NewReader(body))
	if err != nil {
		return ""
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(lanjingPaymentSignatureHeader, hex.EncodeToString(lanjingPaymentSignature(path, body)))
	response, err := lanjingBridgeClient.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ""
	}
	var result struct {
		Status string `json:"status"`
	}
	if common.DecodeJson(io.LimitReader(response.Body, 4096), &result) != nil {
		return ""
	}
	return result.Status
}

// Bounded reconciliation also runs after the checkout window has been closed.
// Advance by ID so an unavailable order cannot starve newer orders.
func StartLanjingCheckoutReconciliation() {
	ticker := time.NewTicker(45 * time.Second)
	defer ticker.Stop()
	afterID := 0
	for range ticker.C {
		if lanjingBridgeOrigin() == "" || !isEpayWebhookEnabled() {
			continue
		}
		orders, err := model.ListLanjingCheckoutsForReconciliation(time.Now().Add(-48*time.Hour).Unix(), afterID, 8)
		if err != nil {
			continue
		}
		for i := range orders {
			reconcileLanjingCheckout(context.Background(), &orders[i])
			afterID = orders[i].Id
		}
		if len(orders) < 8 {
			afterID = 0
		}
	}
}
