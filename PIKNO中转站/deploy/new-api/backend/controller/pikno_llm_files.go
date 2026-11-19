package controller

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const piknoLLMMaxFileBytes = 50 << 20

var piknoLLMFileHandle = regexp.MustCompile(`^hf1_[A-Za-z0-9_-]{32,898}[A-Za-z0-9_-]{0,898}$`)

// The customer never receives a reusable upstream credential. Every file
// operation requires the current chat Key and a ticket binding its exact bytes.
func PiknoLLMFiles(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	user, token, ok := piknoLLMReadAccess(c)
	if !ok {
		return
	}
	if token.ModelLimitsEnabled && !token.GetModelLimitsMap()[model.PiknoLLMModel] {
		piknoLLMError(c, http.StatusForbidden, "llm_key_forbidden", "not_submitted")
		return
	}
	if !piknoLLMSettings().Enabled || os.Getenv("PIKNO_LLM_FILES_ENABLED") != "true" {
		piknoLLMError(c, 503, "llm_capability_unavailable", "not_submitted")
		return
	}
	method, handle := c.Request.Method, c.Param("file")
	if c.Request.URL.RawQuery != "" || (method == http.MethodPost && handle != "") ||
		(method != http.MethodPost && ((method != http.MethodGet && method != http.MethodDelete) || !piknoLLMFileHandle.MatchString(handle))) {
		piknoLLMError(c, 400, "llm_file_invalid", "not_submitted")
		return
	}
	limit := int64(0)
	contentType := ""
	if method == http.MethodPost {
		if user.Quota <= 0 || (!token.UnlimitedQuota && token.RemainQuota <= 0) {
			piknoLLMError(c, 402, "llm_insufficient_quota", "not_submitted")
			return
		}
		contentType = c.GetHeader("Content-Type")
		mediaType, params, err := mime.ParseMediaType(contentType)
		if err != nil || mediaType != "multipart/form-data" || len(contentType) > 256 || len(params) != 1 || params["boundary"] == "" || len(params["boundary"]) > 70 {
			piknoLLMError(c, 400, "llm_file_invalid", "not_submitted")
			return
		}
		limit = piknoLLMMaxFileBytes + 65536
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, limit))
	if err != nil {
		piknoLLMError(c, 413, "llm_file_too_large", "not_submitted")
		return
	}
	path := "/internal/pikno/files"
	if handle != "" {
		path += "/" + handle
	}
	now := time.Now().Unix()
	digest := sha256.Sum256(raw)
	claims, err := common.Marshal(gin.H{"v": 2, "aud": "pikno-llm-file", "uid": user.Id, "method": method, "path": path, "content_type": contentType, "body_sha256": hex.EncodeToString(digest[:]), "iat": now, "exp": now + 60})
	if err != nil {
		piknoLLMError(c, 503, "llm_file_unavailable", "not_submitted")
		return
	}
	payload := base64.RawURLEncoding.EncodeToString(claims)
	mac := hmac.New(sha256.New, []byte(os.Getenv("PIKNO_ASSISTANT_BRIDGE_SECRET")))
	mac.Write([]byte(payload))
	req, err := http.NewRequestWithContext(c.Request.Context(), method, "https://inference.hamsterai.cc"+path, bytes.NewReader(raw))
	if err != nil {
		piknoLLMError(c, 503, "llm_file_unavailable", "not_submitted")
		return
	}
	req.Header.Set("Authorization", "Bearer "+payload+"."+base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	client := &http.Client{Transport: piknoLLMTransport, Timeout: 180 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		piknoLLMError(c, 503, "llm_file_unavailable", "not_submitted")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 && response.StatusCode != 201 {
		status := response.StatusCode
		if status < 400 || status > 599 {
			status = 502
		}
		piknoLLMError(c, status, "llm_file_unavailable", "not_submitted")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	var value struct {
		ID        string `json:"id"`
		Object    string `json:"object"`
		Status    string `json:"status"`
		Bytes     int64  `json:"bytes"`
		CreatedAt int64  `json:"created_at"`
		ExpireAt  int64  `json:"expire_at"`
		Purpose   string `json:"purpose"`
		Deleted   bool   `json:"deleted"`
	}
	if err != nil || len(data) > 65536 || common.Unmarshal(data, &value) != nil || !piknoLLMFileHandle.MatchString(value.ID) || (handle != "" && value.ID != handle) {
		piknoLLMError(c, 502, "llm_file_unavailable", "not_submitted")
		return
	}
	if method == http.MethodDelete {
		if !value.Deleted || value.Object != "file" {
			piknoLLMError(c, 502, "llm_file_unavailable", "not_submitted")
			return
		}
		c.JSON(200, gin.H{"id": value.ID, "object": "file", "deleted": true})
		return
	}
	if value.Object != "file" || value.Purpose != "user_data" || (value.Status != "processing" && value.Status != "active" && value.Status != "failed") || value.Bytes < 1 || value.Bytes > piknoLLMMaxFileBytes || value.CreatedAt < 1 || value.CreatedAt > time.Now().Unix()+5 || value.ExpireAt <= time.Now().Unix() || value.ExpireAt > time.Now().Unix()+3*86400+5 {
		piknoLLMError(c, 502, "llm_file_unavailable", "not_submitted")
		return
	}
	public := gin.H{"id": value.ID, "object": "file", "purpose": "user_data", "status": value.Status, "bytes": value.Bytes, "created_at": value.CreatedAt, "expire_at": value.ExpireAt, "filename": "attachment"}
	if value.Status == "failed" {
		public["error"] = gin.H{"code": "file_processing_failed", "message": "素材解析失败，请检查文件格式。"}
	}
	c.JSON(200, public)
}
