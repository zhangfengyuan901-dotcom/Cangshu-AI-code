package controller

import (
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func piknoSettlementError(c *gin.Context, err error) {
	status, message := http.StatusBadRequest, "核对信息无效，请检查凭据、金额和操作原因"
	if errors.Is(err, model.ErrPiknoPermission) {
		status, message = 403, "无权审核此订单"
	}
	if errors.Is(err, model.ErrPiknoConflict) {
		status, message = 409, "订单已更新，请刷新后重新预览"
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		status, message = 404, "订单不存在"
	}
	c.AbortWithStatusJSON(status, gin.H{"success": false, "message": message})
}

// No permissive Host-derived origin: the production origin is fixed. Local
// candidates set an explicit loopback origin. Browser-session auth is required.
func PiknoSettlementReviewGuard(c *gin.Context) {
	if err := model.AuthorizePiknoReviewer(c.GetInt("id")); err != nil {
		piknoSettlementError(c, err)
		return
	}
	identity, ok := middleware.GetSessionAuthIdentity(c)
	if !ok || strings.HasPrefix(identity.SessionID, "pat:") {
		c.AbortWithStatusJSON(403, gin.H{"success": false, "message": "请使用管理员网页登录"})
		return
	}
	if c.Request.Method == "POST" {
		origin := os.Getenv("PIKNO_SETTLEMENT_ORIGIN")
		if origin == "" {
			origin = "https://www.piknoai.com"
		}
		if c.GetHeader("Origin") != origin {
			c.AbortWithStatusJSON(403, gin.H{"success": false, "message": "请求来源校验失败"})
			return
		}
	}
	c.Next()
}

func PiknoSettlementList(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 || page > 100000 {
		page = 1
	}
	query := model.DB.Model(&model.PiknoSettlement{})
	admin := strings.Contains(c.FullPath(), "/admin")
	if admin {
		if err := model.AuthorizePiknoReviewer(c.GetInt("id")); err != nil {
			piknoSettlementError(c, err)
			return
		}
	} else {
		query = query.Where("user_id = ?", c.GetInt("id"))
	}
	if c.Query("review") == "true" {
		query = query.Where("review_reason <> ?", "")
	}
	var count int64
	if err := query.Count(&count).Error; err != nil {
		c.AbortWithStatus(503)
		return
	}
	var rows []model.PiknoSettlement
	if err := query.Order("created_at desc, id").Offset((page - 1) * 20).Limit(20).Find(&rows).Error; err != nil {
		c.AbortWithStatus(503)
		return
	}
	if admin {
		items := make([]model.PiknoSettlementAdminView, 0, len(rows))
		for _, row := range rows {
			items = append(items, row.AdminView())
		}
		common.ApiSuccess(c, gin.H{"items": items, "total": count})
		return
	}
	items := make([]model.PiknoSettlementView, 0, len(rows))
	for _, row := range rows {
		items = append(items, row.CustomerView())
	}
	common.ApiSuccess(c, gin.H{"items": items, "total": count})
}

func PiknoSettlementDetail(c *gin.Context) {
	if !strings.Contains(c.FullPath(), "/admin") {
		s, events, err := model.GetPiknoCustomerSettlement(c.GetInt("id"), c.Param("id"))
		if err != nil {
			piknoSettlementError(c, err)
			return
		}
		common.ApiSuccess(c, gin.H{"order": s.CustomerView(), "events": events})
		return
	}
	if err := model.AuthorizePiknoReviewer(c.GetInt("id")); err != nil {
		piknoSettlementError(c, err)
		return
	}
	var s model.PiknoSettlement
	if err := model.DB.First(&s, "id = ?", c.Param("id")).Error; err != nil {
		piknoSettlementError(c, err)
		return
	}
	var events []model.PiknoSettlementEvent
	if err := model.DB.Where("order_id = ?", s.ID).Order("id").Find(&events).Error; err != nil {
		c.AbortWithStatus(503)
		return
	}
	items := make([]model.PiknoLedgerAdminView, 0, len(events))
	for _, event := range events {
		items = append(items, model.PiknoLedgerAdminView{PiknoLedgerView: event.CustomerView(), ActorID: event.ActorID, Reason: event.Reason, Evidence: event.Evidence})
	}
	common.ApiSuccess(c, gin.H{"order": s.AdminView(), "events": items})
}

type piknoReviewRequest struct {
	OperationID      string `json:"operation_id"`
	Version          int    `json:"version"`
	Action           string `json:"action"`
	Reason           string `json:"reason"`
	Images           int    `json:"images"`
	EvidenceRef      string `json:"evidence_ref"`
	UpstreamTaskID   string `json:"upstream_task_id"`
	ChargedQuota     int    `json:"charged_quota"`
	RefundedQuota    int    `json:"refunded_quota"`
	FixedRefundQuota int    `json:"fixed_refund_quota"`
}

func PiknoSettlementReview(c *gin.Context) {
	var r piknoReviewRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16384)
	if err := common.DecodeJson(c.Request.Body, &r); err != nil {
		piknoSettlementError(c, err)
		return
	}
	var s model.PiknoSettlement
	if err := model.DB.First(&s, "id = ?", c.Param("id")).Error; err != nil {
		piknoSettlementError(c, err)
		return
	}
	command := model.PiknoSettlementCommand{OrderID: s.ID, OperationID: r.OperationID, ExpectedVersion: r.Version, ActorID: c.GetInt("id"), Action: r.Action, Reason: r.Reason, Images: r.Images, FixedRefundQuota: r.FixedRefundQuota}
	upstreamID := s.UpstreamTaskID
	if r.UpstreamTaskID != "" {
		upstreamID = r.UpstreamTaskID
		command.UpstreamTaskID = upstreamID
	}
	if r.Action != "waive" && r.Action != "acknowledge" {
		command.Evidence = &model.PiknoBillingEvidence{Reference: r.EvidenceRef, AccountRef: s.AccountRef, UpstreamTaskID: upstreamID, Final: true, ChargedQuota: r.ChargedQuota, RefundedQuota: r.RefundedQuota}
	}
	preview, err := model.PreviewPiknoSettlement(command)
	if err != nil {
		piknoSettlementError(c, err)
		return
	}
	if strings.HasSuffix(c.FullPath(), "/preview") {
		common.ApiSuccess(c, preview)
		return
	}
	context, err := common.Marshal(service.PiknoSettlementProofContext{Digest: preview.Digest})
	if err != nil {
		c.AbortWithStatus(500)
		return
	}
	if middleware.RequireSecurityProof(c, service.VerificationOperation{Scope: service.VerificationScopePiknoSettlementReview, Context: context}) == nil {
		return
	}
	event, err := model.ApplyPiknoSettlement(command)
	if err != nil {
		piknoSettlementError(c, err)
		return
	}
	common.ApiSuccess(c, event.CustomerView())
}
