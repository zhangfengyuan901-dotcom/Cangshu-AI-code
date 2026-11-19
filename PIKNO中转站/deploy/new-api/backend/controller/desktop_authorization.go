package controller

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/gin-gonic/gin"
)

type desktopFlowRequest struct {
	FlowID         string `json:"flow_id"`
	Verifier       string `json:"verifier"`
	Challenge      string `json:"challenge"`
	Purpose        string `json:"purpose"`
	Confirmed      bool   `json:"confirmed"`
	ExpectedUserID int    `json:"expected_user_id,omitempty"`
}

func readDesktopFlow(c *gin.Context) (desktopFlowRequest, bool) {
	setAuthNoStore(c)
	var request desktopFlowRequest
	if c.Request.URL.RawQuery != "" || !strings.HasPrefix(c.GetHeader("Content-Type"), "application/json") || c.ShouldBindJSON(&request) != nil {
		writeDesktopFlowError(c, model.ErrDesktopFlowInvalid)
		return request, false
	}
	return request, true
}

func writeDesktopFlowError(c *gin.Context, err error) {
	status, code, message := http.StatusBadRequest, "DESKTOP_FLOW_INVALID", "连接已过期，请从仓鼠AI重新打开。"
	switch {
	case errors.Is(err, model.ErrDesktopAccountMismatch):
		status, code, message = http.StatusForbidden, "DESKTOP_ACCOUNT_MISMATCH", "网页账号与仓鼠AI账号不一致，请切换账号。"
	case errors.Is(err, model.ErrDesktopApprovalRequired):
		status, code, message = http.StatusConflict, "DESKTOP_APPROVAL_REQUIRED", "请先在网页完成连接授权。"
	case errors.Is(err, model.ErrDesktopFlowComplete):
		status, code, message = http.StatusConflict, "DESKTOP_FLOW_COMPLETE", "本次连接已完成。"
	case !errors.Is(err, model.ErrDesktopFlowInvalid):
		status, code, message = http.StatusServiceUnavailable, "DESKTOP_SETUP_FAILED", "连接暂未完成，请稍后重试或在账户页核对。"
	}
	c.JSON(status, gin.H{"success": false, "code": code, "message": message})
}

func StartDesktopAuthorization(c *gin.Context) {
	request, ok := readDesktopFlow(c)
	if !ok {
		return
	}
	var identity *service.AuthIdentity
	if c.GetHeader("Authorization") != "" {
		value, ok := middleware.GetSessionAuthIdentity(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"success": false, "code": "LOGIN_REQUIRED", "message": "请重新登录仓鼠AI账户。"})
			return
		}
		identity = &value
	}
	origin, err := url.Parse(system_setting.ServerAddress)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || strings.TrimRight(origin.Path, "/") != "" {
		writeDesktopFlowError(c, model.ErrDesktopSetupFailed)
		return
	}
	flow, err := service.StartDesktopAuthorization(request.Challenge, request.Purpose, identity, request.ExpectedUserID)
	if err != nil {
		writeDesktopFlowError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"flow_id": flow.ID, "expires_at": flow.ExpiresAt, "interval": 3, "verification_url": strings.TrimRight(origin.String(), "/") + "/hub/billing#desktop=" + flow.ID})
}

func desktopBrowserIdentity(c *gin.Context) (service.AuthIdentity, bool) {
	identity, ok := middleware.GetSessionAuthIdentity(c)
	if !ok || c.GetBool("use_access_token") {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "code": "LOGIN_REQUIRED", "message": "请先登录中转站账户。"})
		return identity, false
	}
	return identity, true
}

func InspectDesktopAuthorization(c *gin.Context) { inspectDesktopAuthorization(c, false) }
func ApproveDesktopAuthorization(c *gin.Context) { inspectDesktopAuthorization(c, true) }

func inspectDesktopAuthorization(c *gin.Context, approve bool) {
	request, ok := readDesktopFlow(c)
	if !ok {
		return
	}
	identity, ok := desktopBrowserIdentity(c)
	if !ok {
		return
	}
	if approve && !request.Confirmed {
		writeDesktopFlowError(c, model.ErrDesktopApprovalRequired)
		return
	}
	flow, err := service.InspectDesktopAuthorization(request.FlowID, identity, approve)
	if err != nil {
		writeDesktopFlowError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"flow_id": flow.ID, "status": flow.Status, "purpose": flow.Purpose, "account_matched": true,
		"requires_approval": flow.Purpose == "connect" && flow.Status == "pending", "expires_at": flow.ExpiresAt})
}

func ExchangeDesktopAuthorization(c *gin.Context) {
	request, ok := readDesktopFlow(c)
	if !ok {
		return
	}
	flow, bundle, keys, err := service.ExchangeDesktopAuthorization(request.FlowID, request.Verifier, c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		writeDesktopFlowError(c, err)
		return
	}
	if flow.Status == "pending" {
		common.ApiSuccess(c, gin.H{"status": "pending", "expires_at": flow.ExpiresAt})
		return
	}
	if flow.Purpose == "recharge" {
		common.ApiSuccess(c, gin.H{"status": "ready", "user_id": flow.UserID})
		return
	}
	if bundle == nil {
		writeDesktopFlowError(c, model.ErrDesktopFlowInvalid)
		return
	}
	user, err := model.GetSelfUserById(flow.UserID)
	if err != nil {
		writeDesktopFlowError(c, err)
		return
	}
	projected := make([]gin.H, 0, len(keys))
	for _, key := range keys {
		projected = append(projected, gin.H{"id": key.Id, "group": key.Group, "key": key.Key})
	}
	service.WriteRefreshCookie(c, bundle.RefreshToken)
	common.ApiSuccess(c, gin.H{"status": "ready", "access_token": bundle.AccessToken, "token_type": bundle.TokenType,
		"access_expires_at": bundle.AccessExpiresAt, "session": bundle.Session, "user": buildSelfUserData(user), "keys": projected})
}

func AcknowledgeDesktopAuthorization(c *gin.Context) {
	request, ok := readDesktopFlow(c)
	if !ok {
		return
	}
	identity, ok := desktopBrowserIdentity(c)
	if !ok {
		return
	}
	if err := service.AcknowledgeDesktopAuthorization(request.FlowID, request.Verifier, identity); err != nil {
		writeDesktopFlowError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"status": "complete"})
}
