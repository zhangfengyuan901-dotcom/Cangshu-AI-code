package controller

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

const (
	piknoRHConfigRoute      = "/api/pikno/rh-config"
	piknoRHConfigCheckRoute = "/api/pikno/rh-config/check"
	piknoRHCloudOrigin      = "https://www.piknoai.com"
	piknoRHCloudConfigPath  = "/media/v1/tools/config"
)

var (
	piknoRHTransport      http.RoundTripper = http.DefaultTransport
	piknoRHKeyPattern                       = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)
	piknoRHVersionPattern                   = regexp.MustCompile(`^(?:|legacy|[a-f0-9]{32})$`)
)

type piknoRHConfigView struct {
	Configured         bool   `json:"configured"`
	Enabled            bool   `json:"enabled"`
	Ready              bool   `json:"ready"`
	Version            string `json:"version"`
	UpdatedAt          string `json:"updated_at"`
	Storage            string `json:"storage"`
	AuthorizationValid bool   `json:"authorization_valid,omitempty"`
}

// PiknoRHConfig keeps the real upstream credential out of ECS storage. A save
// request holds the bounded key only in memory while forwarding it over TLS to
// the dedicated cloud vault. Responses are decoded into an allowlisted view so
// a cloud response can never echo a credential to the browser.
func PiknoRHConfig(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	if c.GetInt("role") != common.RoleRootUser || c.GetBool("use_access_token") {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "管理员网页会话必需"})
		return
	}
	if _, ok := middleware.GetSessionAuthIdentity(c); !ok {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "管理员网页会话必需"})
		return
	}
	if c.Request.URL.RawQuery != "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "配置请求无效"})
		return
	}
	if c.Request.Method == http.MethodPost && c.GetHeader("Origin") != piknoRHCloudOrigin {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "message": "配置请求来源无效"})
		return
	}

	adminSecret := os.Getenv("PIKNO_TOOLS_ADMIN_SECRET")
	if len(adminSecret) < 32 || len(adminSecret) > 400 {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "RH 云端配置服务未就绪"})
		return
	}

	cloudPath := piknoRHCloudConfigPath
	var body []byte
	switch {
	case c.FullPath() == piknoRHConfigRoute && c.Request.Method == http.MethodGet:
	case c.FullPath() == piknoRHConfigCheckRoute && c.Request.Method == http.MethodPost:
		cloudPath += "/check"
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1)
		unexpectedBody, err := io.ReadAll(c.Request.Body)
		if err != nil || len(unexpectedBody) != 0 {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "配置请求无效"})
			return
		}
	case c.FullPath() == piknoRHConfigRoute && c.Request.Method == http.MethodPost:
		if c.ContentType() != "application/json" {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "配置请求无效"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
		var fields map[string]any
		if common.DecodeJson(c.Request.Body, &fields) != nil || len(fields) != 2 {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "配置请求无效"})
			return
		}
		apiKey, keyOK := fields["api_key"].(string)
		expectedVersion, versionOK := fields["expected_version"].(string)
		if !keyOK || !versionOK || !piknoRHKeyPattern.MatchString(apiKey) || !piknoRHVersionPattern.MatchString(expectedVersion) {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "RH Key 或配置版本无效"})
			return
		}
		digest := sha256.Sum256([]byte(apiKey))
		context, err := common.Marshal(service.PiknoRHConfigureContext{
			KeyHash:         hex.EncodeToString(digest[:]),
			ExpectedVersion: expectedVersion,
		})
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		if middleware.RequireSecurityProof(c, service.VerificationOperation{
			Scope:   service.VerificationScopePiknoRHConfigure,
			Context: context,
		}) == nil {
			return
		}
		body, err = common.Marshal(map[string]string{
			"api_key":          apiKey,
			"expected_version": expectedVersion,
		})
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
	default:
		c.Status(http.StatusMethodNotAllowed)
		return
	}

	request, err := http.NewRequestWithContext(
		c.Request.Context(),
		c.Request.Method,
		piknoRHCloudOrigin+cloudPath,
		bytes.NewReader(body),
	)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	request.Header.Set("Authorization", "Bearer "+adminSecret)
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	client := &http.Client{
		Transport: piknoRHTransport,
		Timeout:   15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "RH 云端配置服务暂不可用；请刷新状态后再操作"})
		return
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(data) > 4096 || response.StatusCode != http.StatusOK {
		status, message := http.StatusBadGateway, "RH 云端操作未完成；请刷新状态确认，不要重复提交生成任务"
		if response.StatusCode == http.StatusConflict {
			status, message = http.StatusConflict, "RH 配置已变化，请刷新后重新安全验证"
		}
		if response.StatusCode == http.StatusUnprocessableEntity {
			status, message = http.StatusUnprocessableEntity, "RH Key 授权检查失败；原配置未变，请核对 Key 和账号权限"
		}
		c.JSON(status, gin.H{"success": false, "message": message})
		return
	}

	var view piknoRHConfigView
	updatedAtValid := view.UpdatedAt == ""
	if common.Unmarshal(data, &view) != nil ||
		view.Storage != "cloud-encrypted" ||
		!piknoRHVersionPattern.MatchString(view.Version) ||
		view.Configured != (view.Version != "") ||
		(view.Ready && (!view.Configured || !view.Enabled)) ||
		len(view.UpdatedAt) > 64 {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "message": "RH 配置状态无效，请稍后刷新"})
		return
	}
	if view.UpdatedAt != "" {
		_, err = time.Parse(time.RFC3339Nano, view.UpdatedAt)
		updatedAtValid = err == nil
	}
	if !updatedAtValid || view.Configured != (view.UpdatedAt != "") ||
		(c.Request.Method == http.MethodGet && view.AuthorizationValid) ||
		(c.Request.Method == http.MethodPost && !view.AuthorizationValid) {
		c.JSON(http.StatusBadGateway, gin.H{"success": false, "message": "RH 配置状态无效，请稍后刷新"})
		return
	}

	if c.Request.Method == http.MethodPost && cloudPath == piknoRHCloudConfigPath {
		model.RecordLog(c.GetInt("id"), model.LogTypeManage, "更新 RH 云端加密凭据；未开放客户线路")
	}
	common.ApiSuccess(c, view)
}
