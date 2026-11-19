package controller

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

const piknoReverseMaxBytes int64 = 524288000

var piknoReverseTransport http.RoundTripper = http.DefaultTransport
var piknoReverseOperationID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,80}$`)
var piknoReverseLocalID = regexp.MustCompile(`^rv[ut]_[a-f0-9]{32}$`)
var piknoReverseProviderID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,160}$`)
var piknoReverseDouyinPath = regexp.MustCompile(`^/video/[0-9]+/?$`)
var piknoReverseShortPath = regexp.MustCompile(`^/[A-Za-z0-9_-]{1,128}/?$`)
var piknoReverseXiaohongshuPath = regexp.MustCompile(`^/(explore|discovery/item)/[0-9a-fA-F]{24}/?$`)
var piknoReverseXhsShortPath = regexp.MustCompile(`^/([ao]/)?[A-Za-z0-9_-]{1,128}/?$`)
var piknoReverseBilibiliPath = regexp.MustCompile(`^/video/(BV[A-Za-z0-9]+|av[0-9]+)/?$`)

type piknoReverseOptions struct {
	VideoType       string `json:"videoType"`
	TargetModel     string `json:"targetModel"`
	TaskDurationSec int    `json:"taskDurationSec"`
}

type piknoReverseConfig struct {
	Key, Reason, BillingMode string
	ProviderReady            bool
	Available                bool
}

func piknoReverseSettings() piknoReverseConfig {
	config := piknoReverseConfig{Key: os.Getenv("PIKNO_REVERSE_API_KEY"), BillingMode: os.Getenv("PIKNO_REVERSE_BILLING_MODE"), Reason: "disabled"}
	if os.Getenv("PIKNO_REVERSE_ENABLED") != "true" {
		return config
	}
	config.Reason = "provider_unconfigured"
	if len(config.Key) < 16 || len(config.Key) > 512 || strings.ContainsAny(config.Key, "\r\n\t ") {
		return config
	}
	config.ProviderReady = true
	config.Reason = "billing_unconfigured"
	if config.BillingMode != "actual_seconds_v1" {
		return config
	}
	if common.RedisEnabled || common.BatchUpdateEnabled {
		config.Reason = "wallet_coordination_required"
		return config
	}
	config.Available, config.Reason = true, "ready"
	return config
}

func piknoReverseError(c *gin.Context, status int, code, state string) {
	c.Header("Cache-Control", "private, no-store")
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": "视频反推请求未完成，请查询原操作状态；不要自动重新提交", "submission_state": state}})
}

// Read-only middleware does not enforce expiry, model or IP restrictions.
// Recheck live credentials here so an expired/revoked/restricted key cannot
// inspect another user's uploads, tasks, results or temporary credentials.
func piknoReverseAccess(c *gin.Context) bool {
	c.Header("Cache-Control", "private, no-store")
	var token model.Token
	var user model.User
	if c.GetInt("id") < 1 || c.GetInt("token_id") < 1 || model.DB.Select("id", "user_id", "status", "expired_time", "group", "model_limits_enabled", "model_limits", "allow_ips").First(&token, c.GetInt("token_id")).Error != nil || model.DB.Select("id", "status", "group").First(&user, c.GetInt("id")).Error != nil || token.UserId != user.Id || user.Status != common.UserStatusEnabled || (token.Status != common.TokenStatusEnabled && token.Status != common.TokenStatusExhausted) || token.Group != "tool-standard" || (token.ExpiredTime != -1 && token.ExpiredTime <= common.GetTimestamp()) || (token.ModelLimitsEnabled && !token.GetModelLimitsMap()["pikno-reverse"]) || !service.IsUserSelectableGroup(user.Group, "tool-standard") {
		piknoReverseError(c, http.StatusForbidden, "reverse_key_forbidden", "not_submitted")
		return false
	}
	if ips := token.GetIpLimits(); len(ips) > 0 && !common.IsIpInCIDRList(net.ParseIP(c.ClientIP()), ips) {
		piknoReverseError(c, http.StatusForbidden, "reverse_key_forbidden", "not_submitted")
		return false
	}
	return true
}

func PiknoReverseCapabilities(c *gin.Context) {
	if !piknoReverseAccess(c) {
		return
	}
	config := piknoReverseSettings()
	billing := piknoReverseQuoteView(config)
	billing["configured"] = config.Available
	c.JSON(http.StatusOK, gin.H{"available": config.Available, "reason_code": config.Reason, "model": "pikno-reverse", "billing": billing,
		"input_modes": []string{"file", "link"}, "supported_platforms": []string{"douyin", "xiaohongshu", "bilibili"},
		"limits": gin.H{"max_bytes": piknoReverseMaxBytes, "max_duration_seconds": 600, "extensions": []string{"mp4", "mov", "webm", "m4v"}}})
}

func piknoReverseQuoteView(config piknoReverseConfig) gin.H {
	return gin.H{"available": config.Available, "reason_code": config.Reason, "price_version": model.PiknoReversePriceVersion, "currency": "CNY", "unit_price_cny": "0.03", "reservation_cny": "18.00", "max_seconds": 600, "confirmation_required": true, "billing_mode": "actual_seconds_v1"}
}

func PiknoReverseQuote(c *gin.Context) {
	if piknoReverseAccess(c) {
		c.JSON(http.StatusOK, piknoReverseQuoteView(piknoReverseSettings()))
	}
}

// Fixed HTTPS control-plane origin. Source links are JSON data sent to the
// provider, never fetched here. Only the desktop uploads bytes to signed URLs.
func piknoReverseRequest(c *gin.Context, config piknoReverseConfig, method, path, idempotencyKey string, body any, result any) (int, error) {
	var payload []byte
	var err error
	if body != nil {
		payload, err = common.Marshal(body)
		if err != nil {
			return 0, errors.New("reverse request unavailable")
		}
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), method, "https://promptvv.com/api/v1/"+path, bytes.NewReader(payload))
	if err != nil {
		return 0, errors.New("reverse request unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+config.Key)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	client := &http.Client{Transport: piknoReverseTransport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return 0, errors.New("reverse upstream unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Never read or log upstream error bodies, which can contain credentials,
		// source URLs, private media names or customer text.
		return resp.StatusCode, errors.New("reverse upstream rejected request")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || common.Unmarshal(raw, result) != nil {
		return resp.StatusCode, errors.New("reverse upstream response unavailable")
	}
	return resp.StatusCode, nil
}

func piknoReverseReadJSON(c *gin.Context, fields []string, result any) bool {
	ct, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || ct != "application/json" {
		piknoReverseError(c, http.StatusUnsupportedMediaType, "reverse_json_required", "not_submitted")
		return false
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 8192))
	var object map[string]any
	if err != nil || common.Unmarshal(raw, &object) != nil || object == nil || common.Unmarshal(raw, result) != nil {
		piknoReverseError(c, http.StatusBadRequest, "reverse_invalid_request", "not_submitted")
		return false
	}
	for name := range object {
		if !slices.Contains(fields, name) {
			piknoReverseError(c, http.StatusBadRequest, "reverse_unsupported_field", "not_submitted")
			return false
		}
	}
	if slices.Contains(fields, "url") {
		link, hasLink := object["url"]
		upload, hasUpload := object["upload_id"]
		linkText, linkOK := link.(string)
		uploadText, uploadOK := upload.(string)
		if hasLink == hasUpload || (hasLink && (!linkOK || linkText == "")) || (hasUpload && (!uploadOK || uploadText == "")) {
			piknoReverseError(c, 400, "reverse_source_required", "not_submitted")
			return false
		}
	}
	if options, exists := object["options"]; exists {
		values, ok := options.(map[string]any)
		if !ok || len(values) != 3 {
			piknoReverseError(c, 400, "reverse_invalid_options", "not_submitted")
			return false
		}
		for name := range values {
			if !slices.Contains([]string{"videoType", "targetModel", "taskDurationSec"}, name) {
				piknoReverseError(c, 400, "reverse_unsupported_option", "not_submitted")
				return false
			}
		}
		if duration, exists := values["taskDurationSec"]; exists {
			value, ok := duration.(float64)
			if !ok || value < 1 || value > 300 || math.Trunc(value) != value {
				piknoReverseError(c, 400, "reverse_invalid_options", "not_submitted")
				return false
			}
		}
	}
	return true
}

func piknoReverseNewOperation(c *gin.Context, config piknoReverseConfig, kind, operationID, resource, uploadID string, body any) (*model.PiknoReverseOperation, bool) {
	raw, err := common.Marshal(body)
	nonce := make([]byte, 16)
	if err != nil {
		piknoReverseError(c, 503, "reverse_unavailable", "not_submitted")
		return nil, false
	}
	if _, err = rand.Read(nonce); err != nil {
		piknoReverseError(c, 503, "reverse_unavailable", "not_submitted")
		return nil, false
	}
	prefix := "rvu_"
	if kind == "task" {
		prefix = "rvt_"
	}
	digest := sha256.Sum256(raw)
	accountRef := sha256.Sum256([]byte(config.Key))
	resourceDigest := sha256.Sum256(fmt.Appendf(nil, "%d:%s:%s", c.GetInt("id"), kind, resource))
	row := &model.PiknoReverseOperation{ID: prefix + hex.EncodeToString(nonce), UserID: c.GetInt("id"), TokenID: c.GetInt("token_id"), ProviderAccountRef: hex.EncodeToString(accountRef[:]), OperationID: operationID, ResourceKey: hex.EncodeToString(resourceDigest[:]), Kind: kind, RequestSHA256: hex.EncodeToString(digest[:]), UploadID: uploadID}
	row, created, err := model.ClaimPiknoReverseOperation(row)
	if errors.Is(err, model.ErrPiknoReverseConflict) {
		piknoReverseError(c, 409, "reverse_operation_conflict", "unknown")
		return nil, false
	}
	if errors.Is(err, model.ErrPiknoReverseQuota) {
		piknoReverseError(c, 402, "reverse_reservation_insufficient", "not_submitted")
		return nil, false
	}
	if err != nil {
		piknoReverseError(c, 503, "reverse_persistence_unavailable", "unknown")
		return nil, false
	}
	if !created {
		c.JSON(http.StatusOK, piknoReverseView(row))
		return nil, false
	}
	return row, true
}

func piknoReverseView(row *model.PiknoReverseOperation) gin.H {
	view := gin.H{"operation_id": row.OperationID, "kind": row.Kind, "status": row.State}
	if row.Kind == "upload" {
		view["upload_id"] = row.ID
		if row.State == "ready" && row.ExpiresAt > time.Now().Unix() {
			view["upload_url"], view["method"], view["expires_at"] = row.UploadURL, "PUT", row.ExpiresAt
			view["headers"] = gin.H{"Content-Type": row.ContentType}
		} else if row.State == "ready" {
			view["status"] = "expired"
		}
		return view
	}
	view["id"], view["progress"] = row.ID, 0
	financial := row.FinancialState
	if row.State == "unknown" || (row.State == "done" && financial != "settled") {
		financial = "pending"
	}
	billing := gin.H{"status": financial, "price_version": row.PriceVersion, "currency": "CNY", "reservation_cny": decimal.NewFromInt(int64(row.ReservedQuota)).Div(decimal.NewFromInt(1000000)).StringFixed(2), "charged_cny": decimal.NewFromInt(int64(row.ChargedQuota)).Div(decimal.NewFromInt(1000000)).String(), "refunded_cny": decimal.NewFromInt(int64(row.RefundedQuota)).Div(decimal.NewFromInt(1000000)).String()}
	if row.ChargedSeconds != "" {
		billing["charged_seconds"] = row.ChargedSeconds
	}
	view["billing"] = billing
	if row.State == "analyzing" {
		view["progress"] = 50
	}
	if row.State == "done" {
		view["progress"], view["result"] = 100, gin.H{"text": row.ResultText}
	}
	return view
}

func PiknoReverseUpload(c *gin.Context) {
	if !piknoReverseAccess(c) {
		return
	}
	config := piknoReverseSettings()
	if !config.Available {
		piknoReverseError(c, 503, "reverse_"+config.Reason, "not_submitted")
		return
	}
	var input struct {
		Filename        string  `json:"filename"`
		SizeBytes       int64   `json:"size_bytes"`
		ContentType     string  `json:"content_type"`
		DurationSeconds float64 `json:"duration_seconds"`
		OperationID     string  `json:"operation_id"`
	}
	if !piknoReverseReadJSON(c, []string{"filename", "size_bytes", "content_type", "duration_seconds", "operation_id"}, &input) {
		return
	}
	ext := strings.ToLower(filepath.Ext(input.Filename))
	contentTypes := map[string]string{".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/x-m4v"}
	if len(input.Filename) == 0 || len(input.Filename) > 255 || strings.ContainsAny(input.Filename, "/\\\r\n\x00") || contentTypes[ext] == "" || input.SizeBytes < 12 || input.SizeBytes > piknoReverseMaxBytes || math.IsNaN(input.DurationSeconds) || math.IsInf(input.DurationSeconds, 0) || input.DurationSeconds < 0 || input.DurationSeconds > 600 || !piknoReverseOperationID.MatchString(input.OperationID) || (input.ContentType != "" && input.ContentType != contentTypes[ext] && input.ContentType != "application/octet-stream") {
		piknoReverseError(c, 400, "reverse_invalid_upload", "not_submitted")
		return
	}
	if input.ContentType == "" {
		input.ContentType = contentTypes[ext]
	}
	row, ok := piknoReverseNewOperation(c, config, "upload", input.OperationID, input.OperationID, "", input)
	if !ok {
		return
	}
	var upstream struct {
		UploadKey string `json:"upload_key"`
		UploadURL string `json:"upload_url"`
		Method    string `json:"method"`
		ExpiresIn int64  `json:"expires_in"`
		MaxBytes  int64  `json:"max_bytes"`
	}
	status, err := piknoReverseRequest(c, config, http.MethodPost, "uploads", "pikno-reverse-upload-"+row.ID, gin.H{"filename": input.Filename, "size_bytes": input.SizeBytes}, &upstream)
	parsed, parseErr := url.Parse(upstream.UploadURL)
	if err != nil || status != http.StatusCreated || len(upstream.UploadKey) < 1 || len(upstream.UploadKey) > 2048 || len(upstream.UploadURL) > 16384 || parseErr != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || parsed.Port() != "" || net.ParseIP(parsed.Hostname()) != nil || strings.EqualFold(parsed.Hostname(), "localhost") || upstream.Method != "PUT" || upstream.ExpiresIn < 1 || upstream.ExpiresIn > 1800 || (upstream.MaxBytes != 0 && upstream.MaxBytes < input.SizeBytes) {
		piknoReverseError(c, 502, "reverse_upload_unknown", "unknown")
		return
	}
	err = model.UpdatePiknoReverseOperation(row, map[string]any{"state": "ready", "provider_upload_key": upstream.UploadKey, "upload_url": upstream.UploadURL, "content_type": input.ContentType, "expires_at": time.Now().Unix() + upstream.ExpiresIn})
	if err != nil {
		piknoReverseError(c, 503, "reverse_persistence_unavailable", "unknown")
		return
	}
	c.JSON(http.StatusCreated, piknoReverseView(row))
}

func PiknoReverseSubmit(c *gin.Context) {
	if !piknoReverseAccess(c) {
		return
	}
	config := piknoReverseSettings()
	if !config.Available {
		piknoReverseError(c, 503, "reverse_"+config.Reason, "not_submitted")
		return
	}
	var input struct {
		UploadID         *string             `json:"upload_id,omitempty"`
		URL              *string             `json:"url,omitempty"`
		Options          piknoReverseOptions `json:"options"`
		OperationID      string              `json:"operation_id"`
		PriceVersion     string              `json:"price_version"`
		BillingConfirmed bool                `json:"billing_confirmed"`
	}
	if !piknoReverseReadJSON(c, []string{"upload_id", "url", "options", "operation_id", "price_version", "billing_confirmed"}, &input) {
		return
	}
	if input.PriceVersion != model.PiknoReversePriceVersion || !input.BillingConfirmed {
		piknoReverseError(c, 409, "reverse_billing_confirmation_required", "not_submitted")
		return
	}
	if !piknoReverseOperationID.MatchString(input.OperationID) || !slices.Contains([]string{"general", "short", "dance", "ecommerce", "script", "drama", "anime"}, input.Options.VideoType) || !slices.Contains([]string{"allRef", "firstFrame", "firstFrameRef"}, input.Options.TargetModel) || input.Options.TaskDurationSec < 1 || input.Options.TaskDurationSec > 300 {
		piknoReverseError(c, 400, "reverse_invalid_task", "not_submitted")
		return
	}
	uploadID := ""
	resource := "link:" + input.OperationID
	if input.URL != nil {
		if !piknoReverseSupportedLink(*input.URL) {
			piknoReverseError(c, 400, "reverse_unsupported_link", "not_submitted")
			return
		}
	} else if input.UploadID != nil {
		uploadID = *input.UploadID
		resource = uploadID
		if !piknoReverseLocalID.MatchString(uploadID) || !strings.HasPrefix(uploadID, "rvu_") {
			piknoReverseError(c, 400, "reverse_invalid_task", "not_submitted")
			return
		}
	} else {
		piknoReverseError(c, 400, "reverse_source_required", "not_submitted")
		return
	}
	// A replay can recover its durable operation even after the upload expires.
	if _, err := model.GetPiknoReverseOperation(c.GetInt("id"), input.OperationID); err == nil {
		_, _ = piknoReverseNewOperation(c, config, "task", input.OperationID, resource, uploadID, input)
		return
	}
	upstreamBody := gin.H{"dims": gin.H{"model": "flagship", "videoType": input.Options.VideoType, "targetModel": input.Options.TargetModel, "taskDurationSec": input.Options.TaskDurationSec}}
	if input.URL != nil {
		upstreamBody["url"] = *input.URL
	} else {
		upload, err := model.GetPiknoReverseResource(c.GetInt("id"), uploadID, "upload")
		accountRef := sha256.Sum256([]byte(config.Key))
		if err != nil || upload.State != "ready" || upload.ExpiresAt <= time.Now().Unix() || upload.ProviderUploadKey == "" || upload.ProviderAccountRef != hex.EncodeToString(accountRef[:]) {
			piknoReverseError(c, 409, "reverse_upload_unavailable", "not_submitted")
			return
		}
		upstreamBody["upload_key"] = upload.ProviderUploadKey
	}
	row, ok := piknoReverseNewOperation(c, config, "task", input.OperationID, resource, uploadID, input)
	if !ok {
		return
	}
	var upstream struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	upstreamBody["client_reference_id"] = row.ID
	status, err := piknoReverseRequest(c, config, http.MethodPost, "analyze", "pikno-reverse-task-"+row.ID, upstreamBody, &upstream)
	if err != nil || status != http.StatusAccepted || !piknoReverseProviderID.MatchString(upstream.ID) || !slices.Contains([]string{"queued", "analyzing"}, upstream.Status) {
		piknoReverseError(c, 502, "reverse_submission_unknown", "unknown")
		return
	}
	if err := model.UpdatePiknoReverseOperation(row, map[string]any{"state": upstream.Status, "provider_job_id": upstream.ID}); err != nil {
		piknoReverseError(c, 503, "reverse_persistence_unavailable", "unknown")
		return
	}
	c.JSON(http.StatusAccepted, piknoReverseView(row))
}

// Platform video-page paths and official short links only. Keep the original
// URL and signed query intact; URL normalization must not alter idempotency.
// This validator does no DNS lookup, media download or redirect resolution.
func piknoReverseSupportedLink(raw string) bool {
	if len(raw) == 0 || len(raw) > 4096 || !utf8.ValidString(raw) || strings.ContainsAny(raw, "\\#") || strings.IndexFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Opaque != "" || parsed.User != nil || parsed.Hostname() == "" || parsed.Fragment != "" || parsed.RawFragment != "" || (parsed.Port() != "" && parsed.Port() != "443") {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if !strings.EqualFold(parsed.Host, host) && !strings.EqualFold(parsed.Host, host+":443") {
		return false
	}
	if parsed.RawPath != "" || strings.Contains(parsed.EscapedPath(), "%") {
		return false
	}
	var pattern *regexp.Regexp
	switch host {
	case "douyin.com", "www.douyin.com":
		pattern = piknoReverseDouyinPath
	case "v.douyin.com", "b23.tv":
		pattern = piknoReverseShortPath
	case "xiaohongshu.com", "www.xiaohongshu.com":
		pattern = piknoReverseXiaohongshuPath
	case "xhslink.com":
		pattern = piknoReverseXhsShortPath
	case "bilibili.com", "www.bilibili.com":
		pattern = piknoReverseBilibiliPath
	default:
		return false
	}
	if !pattern.MatchString(parsed.Path) {
		return false
	}
	query, err := url.QueryUnescape(parsed.RawQuery)
	if err != nil {
		return false
	}
	for range 3 {
		if !utf8.ValidString(query) || strings.Contains(query, "\\") || strings.IndexFunc(query, unicode.IsControl) >= 0 {
			return false
		}
		lower := strings.ToLower(query)
		if strings.Contains(lower, "http://") || strings.Contains(lower, "https://") {
			return false
		}
		decoded, err := url.QueryUnescape(query)
		if err != nil {
			return false
		}
		if decoded == query {
			return true
		}
		query = decoded
	}
	// Further encoding layers are ambiguous. Do not let a second URL or control
	// character appear just beyond the bounded decoding checks above.
	return false
}

func piknoReverseRefresh(c *gin.Context, row *model.PiknoReverseOperation) bool {
	config := piknoReverseSettings()
	if row.Kind != "task" || row.FinancialState == "settled" || row.FinancialState == "released" || !config.ProviderReady {
		return true
	}
	accountRef := sha256.Sum256([]byte(config.Key))
	if row.ProviderAccountRef != hex.EncodeToString(accountRef[:]) {
		return true
	}
	if row.ProviderJobID == "" {
		var listing struct {
			Items []struct {
				ID                string `json:"id"`
				ClientReferenceID string `json:"client_reference_id"`
			} `json:"items"`
			HasMore *bool `json:"has_more"`
		}
		_, err := piknoReverseRequest(c, config, http.MethodGet, "jobs?client_reference_id="+url.QueryEscape(row.ID), "", nil, &listing)
		matches, matchedID := 0, ""
		for _, item := range listing.Items {
			if item.ClientReferenceID == row.ID && piknoReverseProviderID.MatchString(item.ID) {
				matches++
				matchedID = item.ID
			}
		}
		// A partial, ambiguous or undocumented list is never proof of acceptance.
		if err != nil || listing.HasMore == nil || *listing.HasMore || matches != 1 {
			return true
		}
		row.ProviderJobID = matchedID
	}
	var job struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Result *struct {
			Text string `json:"text"`
		} `json:"result"`
		ChargedSeconds json.RawMessage `json:"charged_seconds"`
	}
	_, err := piknoReverseRequest(c, config, http.MethodGet, "jobs/"+url.PathEscape(row.ProviderJobID), "", nil, &job)
	if err != nil || job.ID != row.ProviderJobID || !slices.Contains([]string{"queued", "analyzing", "done", "error", "cancelled"}, job.Status) || (job.Status == "done" && (job.Result == nil || strings.TrimSpace(job.Result.Text) == "")) {
		piknoReverseError(c, 502, "reverse_status_unavailable", row.State)
		return false
	}
	var seconds *decimal.Decimal
	// Preserve the provider's JSON decimal value, including fractional seconds.
	// Invalid/missing/out-of-range duration leaves the reservation pending.
	if len(job.ChargedSeconds) > 0 && len(job.ChargedSeconds) <= 64 && job.ChargedSeconds[0] != '"' {
		value, parseErr := decimal.NewFromString(string(job.ChargedSeconds))
		if parseErr == nil && value.Exponent() >= -9 && value.Exponent() <= 9 && !value.IsNegative() && value.LessThanOrEqual(decimal.NewFromInt(600)) {
			seconds = &value
		}
	}
	text := ""
	if job.Result != nil {
		text = job.Result.Text
	}
	if err := model.ObservePiknoReverseTask(row, job.Status, job.ID, text, seconds); err != nil {
		piknoReverseError(c, 503, "reverse_persistence_unavailable", row.State)
		return false
	}
	return true
}

func PiknoReverseTask(c *gin.Context) {
	if !piknoReverseAccess(c) {
		return
	}
	row, err := model.GetPiknoReverseResource(c.GetInt("id"), c.Param("id"), "task")
	if err != nil {
		piknoReverseError(c, 404, "reverse_task_not_found", "unknown")
		return
	}
	if piknoReverseRefresh(c, row) {
		c.JSON(http.StatusOK, piknoReverseView(row))
	}
}

func PiknoReverseOperation(c *gin.Context) {
	if !piknoReverseAccess(c) {
		return
	}
	row, err := model.GetPiknoReverseOperation(c.GetInt("id"), c.Param("operation_id"))
	if err != nil {
		piknoReverseError(c, 404, "reverse_operation_not_found", "unknown")
		return
	}
	if piknoReverseRefresh(c, row) {
		c.JSON(http.StatusOK, piknoReverseView(row))
	}
}
