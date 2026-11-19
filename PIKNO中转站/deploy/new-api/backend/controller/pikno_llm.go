package controller

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

var piknoLLMTransport http.RoundTripper = http.DefaultTransport
var piknoLLMID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var piknoLLMJSONStrings = regexp.MustCompile(`"(?:[^"\\]|\\.)*"`)

type piknoLLMConfig struct {
	Enabled, Verified bool
	OutputLimit       int
}

func piknoLLMSettings() piknoLLMConfig {
	output, _ := strconv.Atoi(os.Getenv("PIKNO_LLM_MAX_OUTPUT_TOKENS"))
	verified := os.Getenv("PIKNO_LLM_MODEL_VERIFIED") == "true" && output > 0 && output <= model.PiknoLLMMaxOutputTokens
	// The new debt policy requires explicit opt-in. Updating old prepaid
	// deployments must not silently enable a different financial policy.
	enabled := os.Getenv("PIKNO_LLM_ENABLED") == "true" && os.Getenv("PIKNO_LLM_BILLING_MODE") == model.PiknoLLMBillingMode && verified && len(os.Getenv("PIKNO_ASSISTANT_BRIDGE_SECRET")) >= 32 && !common.RedisEnabled && !common.BatchUpdateEnabled
	return piknoLLMConfig{enabled, verified, output}
}

func piknoLLMError(c *gin.Context, status int, code, state string) {
	c.Header("Cache-Control", "private, no-store")
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": "PIKNO 对话请求未完成，请查询原请求状态；不要自动重新提交", "submission_state": state}})
}

func piknoLLMAccess(c *gin.Context, alias string) bool {
	if c.GetInt("id") < 1 || c.GetInt("token_id") < 1 {
		piknoLLMError(c, 401, "llm_auth_required", "not_submitted")
		return false
	}
	if common.GetContextKeyString(c, constant.ContextKeyTokenGroup) != model.PiknoLLMGroup || !piknoTokenCanUseModel(c, alias) {
		piknoLLMError(c, 403, "llm_key_forbidden", "not_submitted")
		return false
	}
	return true
}

// Capability/price inspection only. It does not mint a session, reserve quota,
// inspect the provider or generate an answer.
func PiknoLLMActivate(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	user, token, ok := piknoLLMReadAccess(c)
	if !ok {
		return
	}
	config := piknoLLMSettings()
	legacyEnabled := config.Enabled && (!token.ModelLimitsEnabled || token.GetModelLimitsMap()[model.PiknoLLMModel])
	files := legacyEnabled && os.Getenv("PIKNO_LLM_FILES_ENABLED") == "true"
	result := gin.H{"authorized": true, "enabled": legacyEnabled, "available": legacyEnabled, "model": model.PiknoLLMModel, "price_version": model.PiknoLLMPriceVersion,
		"billing_mode":       model.PiknoLLMBillingMode,
		"billing":            gin.H{"allow_debt": true, "one_inflight_per_user": true, "unknown_review_policy": model.PiknoLLMUnknownReviewPolicy, "unknown_review_cooldown_seconds": model.PiknoLLMUnknownReviewCooldownSeconds},
		"pricing":            gin.H{"currency": "CNY", "input_cny_per_million": 9, "output_cny_per_million": 45, "cached_input_cny_per_million": 9},
		"capabilities":       gin.H{"text": true, "sse": true, "image": files, "pdf": files, "video": files, "files": files, "audio": false, "tools": false, "verified": config.Verified},
		"limits":             gin.H{"max_output_tokens": max(0, config.OutputLimit), "max_request_bytes": 2 << 20, "max_messages": 128, "max_file_bytes": piknoLLMMaxFileBytes, "max_attachments": 6, "max_history_attachments": 12},
		"balance_sufficient": user.Quota > 0 && (token.UnlimitedQuota || token.RemainQuota > 0)}
	if (!token.ModelLimitsEnabled || token.GetModelLimitsMap()[model.PiknoLLMArkModel]) && piknoLLMArkChannel(config) != nil {
		result["models"] = []gin.H{piknoLLMArkCapability(config)}
	}
	c.JSON(200, result)
}

func piknoLLMReadAccess(c *gin.Context) (*model.User, *model.Token, bool) {
	// Read-only authentication permits an exhausted key to inspect its existing
	// reservation. Recheck live account, expiry, model and IP restrictions; a
	// revoked/foreign key never gains access through the read-only middleware.
	var token model.Token
	var user model.User
	if c.GetInt("id") < 1 || c.GetInt("token_id") < 1 || model.DB.Select("id", "user_id", "status", "expired_time", "group", "model_limits_enabled", "model_limits", "allow_ips", "remain_quota", "unlimited_quota").First(&token, c.GetInt("token_id")).Error != nil || model.DB.Select("id", "status", "group", "quota").First(&user, c.GetInt("id")).Error != nil || token.UserId != user.Id || user.Status != common.UserStatusEnabled || (token.Status != common.TokenStatusEnabled && token.Status != common.TokenStatusExhausted) || token.Group != model.PiknoLLMGroup || (token.ExpiredTime != -1 && token.ExpiredTime <= common.GetTimestamp()) || (token.ModelLimitsEnabled && !token.GetModelLimitsMap()[model.PiknoLLMModel] && !token.GetModelLimitsMap()[model.PiknoLLMArkModel]) || !service.IsUserSelectableGroup(user.Group, model.PiknoLLMGroup) {
		piknoLLMError(c, 403, "llm_key_forbidden", "unknown")
		return nil, nil, false
	}
	if ips := token.GetIpLimits(); len(ips) > 0 && !common.IsIpInCIDRList(net.ParseIP(c.ClientIP()), ips) {
		piknoLLMError(c, 403, "llm_key_forbidden", "unknown")
		return nil, nil, false
	}
	return &user, &token, true
}

func PiknoLLMRequestStatus(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	_, token, ok := piknoLLMReadAccess(c)
	if !ok {
		return
	}
	r, err := model.GetPiknoLLMRequest(c.GetInt("id"), c.Param("id"))
	if err != nil || (token.ModelLimitsEnabled && !token.GetModelLimitsMap()[r.Model]) {
		piknoLLMError(c, 404, "llm_request_not_found", "unknown")
		return
	}
	c.JSON(200, r.CustomerView())
}

func PiknoLLMLegacyClosed(c *gin.Context) {
	piknoLLMError(c, http.StatusGone, "llm_upgrade_required", "not_submitted")
}

// Media references are opaque, account-bound handles checked by the Worker
// before dispatch. Never forward arbitrary URLs, tools or billing modifiers.
func piknoLLMBody(c *gin.Context, config piknoLLMConfig, expectedAlias ...string) ([]byte, int, bool, error) {
	modelAlias := model.PiknoLLMModel
	if len(expectedAlias) > 0 {
		modelAlias = expectedAlias[0]
	}
	ct, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || ct != "application/json" {
		return nil, 0, false, errors.New("JSON required")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20))
	if err != nil {
		return nil, 0, false, err
	}
	var body map[string]json.RawMessage
	if common.Unmarshal(raw, &body) != nil || body == nil {
		return nil, 0, false, errors.New("invalid object")
	}
	// Some supported SDK versions emit optional arguments as explicit null.
	// Remove absent capabilities before validation, never forward them upstream.
	// Required fields remain required even when null.
	for field, value := range body {
		if field != "model" && field != "input" && field != "max_output_tokens" && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			delete(body, field)
		}
	}
	for field := range body {
		switch field {
		case "model", "input", "instructions", "max_output_tokens", "stream":
		default:
			return nil, 0, false, errors.New("unsupported field")
		}
	}
	var alias string
	var output *int
	var stream *bool
	if common.Unmarshal(body["model"], &alias) != nil || alias != modelAlias || common.Unmarshal(body["max_output_tokens"], &output) != nil || output == nil || *output < 1 || *output > config.OutputLimit {
		return nil, 0, false, errors.New("unsupported model or output limit")
	}
	if value, ok := body["stream"]; ok {
		if common.Unmarshal(value, &stream) != nil || stream == nil {
			return nil, 0, false, errors.New("invalid stream")
		}
	}
	var instructions string
	if value, ok := body["instructions"]; ok {
		if common.Unmarshal(value, &instructions) != nil {
			return nil, 0, false, errors.New("invalid instructions")
		}
	}
	var text string
	media := make(map[string]bool)
	if common.Unmarshal(body["input"], &text) != nil {
		var messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
			Type    string          `json:"type,omitempty"`
		}
		// Decode into exact maps as well, so file/reference extras cannot hide
		// behind Go's normal unknown-field tolerance.
		var strict []map[string]json.RawMessage
		if common.Unmarshal(body["input"], &messages) != nil || common.Unmarshal(body["input"], &strict) != nil || len(messages) < 1 || len(messages) > 128 {
			return nil, 0, false, errors.New("text input required")
		}
		for index, message := range messages {
			messageMedia := make(map[string]bool)
			for field := range strict[index] {
				if field != "role" && field != "content" && field != "type" {
					return nil, 0, false, errors.New("unsupported message")
				}
			}
			if (message.Role != "user" && message.Role != "assistant" && message.Role != "system" && message.Role != "developer") || (message.Type != "" && message.Type != "message") {
				return nil, 0, false, errors.New("unsupported role")
			}
			var content string
			if common.Unmarshal(message.Content, &content) != nil {
				var parts []map[string]json.RawMessage
				if common.Unmarshal(message.Content, &parts) != nil || len(parts) < 1 || len(parts) > 128 {
					return nil, 0, false, errors.New("text content required")
				}
				for _, part := range parts {
					var kind, value string
					if common.Unmarshal(part["type"], &kind) != nil {
						return nil, 0, false, errors.New("invalid content part")
					}
					if kind == "input_text" {
						if len(part) != 2 || common.Unmarshal(part["text"], &value) != nil {
							return nil, 0, false, errors.New("invalid text part")
						}
						content += value
						continue
					}
					if modelAlias == model.PiknoLLMArkModel {
						assetKind := strings.TrimPrefix(kind, "input_")
						if !piknoLLMArkMediaEnabled() || message.Role != "user" || (kind != "input_image" && kind != "input_video") || common.Unmarshal(part[assetKind+"_url"], &value) != nil ||
							!piknoLLMArkFPS(part["fps"], kind == "input_video", len(part)) || !piknoLLMArkMediaReference(c, value, assetKind, media) {
							return nil, 0, false, errors.New("unsupported media reference")
						}
					} else if len(part) != 2 || os.Getenv("PIKNO_LLM_FILES_ENABLED") != "true" || message.Role != "user" || (kind != "input_image" && kind != "input_video" && kind != "input_file") || common.Unmarshal(part["file_id"], &value) != nil || !piknoLLMFileHandle.MatchString(value) {
						return nil, 0, false, errors.New("unsupported media reference")
					} else {
						media[value] = true
					}
					messageMedia[value] = true
					if len(media) > 12 || len(messageMedia) > 6 {
						return nil, 0, false, errors.New("too many media references")
					}
				}
			}
			text += content
			delete(strict[index], "type")
		}
		body["input"], err = common.Marshal(strict)
		if err != nil {
			return nil, 0, false, err
		}
	}
	if (strings.TrimSpace(text) == "" && len(media) == 0) || len(text)+len(instructions) > 2<<20 {
		return nil, 0, false, errors.New("invalid text")
	}
	canonical, err := common.Marshal(body)
	if err != nil {
		return nil, 0, false, err
	}
	return canonical, *output, stream != nil && *stream, err
}

func piknoLLMTicket(uid int, requestID, digest string, output int) (string, error) {
	now := time.Now().Unix()
	claims, err := common.Marshal(gin.H{"v": 2, "aud": "pikno-llm-execute", "uid": uid, "request_id": requestID, "jti": requestID, "body_sha256": digest, "model_alias": model.PiknoLLMModel, "billing_mode": model.PiknoLLMBillingMode, "route_policy": "pikno-text-three-actual-usage-v2", "max_output_tokens": output, "iat": now, "exp": now + 60})
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(claims)
	mac := hmac.New(sha256.New, []byte(os.Getenv("PIKNO_ASSISTANT_BRIDGE_SECRET")))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

type piknoLLMUsage struct {
	Input   *int `json:"input_tokens"`
	Output  *int `json:"output_tokens"`
	Total   *int `json:"total_tokens"`
	Details *struct {
		Cached *int `json:"cached_tokens"`
	} `json:"input_tokens_details"`
}

func piknoLLMResponse(raw []byte, alias string) ([]byte, *piknoLLMUsage, bool, error) {
	var object map[string]json.RawMessage
	if common.Unmarshal(raw, &object) != nil || object == nil {
		return nil, nil, false, errors.New("invalid response")
	}
	var status string
	_ = common.Unmarshal(object["status"], &status)
	terminal := status == "completed" || status == "incomplete" || status == "failed"
	var usage *piknoLLMUsage
	if value, ok := object["usage"]; ok {
		if common.Unmarshal(value, &usage) != nil {
			return nil, nil, false, errors.New("invalid usage")
		}
	}
	object["model"], _ = common.Marshal(alias)
	if _, ok := object["error"]; ok {
		object["error"], _ = common.Marshal(gin.H{"code": "llm_response_failed", "message": "PIKNO 对话返回未完成"})
	}
	safe, err := common.Marshal(object)
	return safe, usage, terminal, err
}

func piknoLLMSettle(uid int, requestID string, usage *piknoLLMUsage, terminal bool) bool {
	if !terminal || usage == nil || usage.Input == nil || usage.Output == nil || usage.Total == nil || *usage.Input < 0 || *usage.Output < 0 || *usage.Total < 0 || *usage.Input > common.MaxQuota || *usage.Output > common.MaxQuota || int64(*usage.Total) != int64(*usage.Input)+int64(*usage.Output) {
		return false
	}
	if usage.Details != nil && usage.Details.Cached != nil && (*usage.Details.Cached < 0 || *usage.Details.Cached > *usage.Input) {
		return false
	}
	cached := 0
	if usage.Details != nil && usage.Details.Cached != nil {
		cached = *usage.Details.Cached
	}
	_, err := model.FinishPiknoLLM(uid, requestID, "usage", *usage.Input, *usage.Output, cached)
	return err == nil
}

func PiknoLLMResponses(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	version := c.GetHeader("X-PIKNO-Price-Version")
	alias := model.PiknoLLMModel
	if version == model.PiknoLLMArkPriceVersion {
		alias = model.PiknoLLMArkModel
	}
	if !piknoLLMAccess(c, alias) {
		return
	}
	requestID := c.GetHeader("X-PIKNO-Request-Id")
	if !piknoLLMID.MatchString(requestID) {
		piknoLLMError(c, 400, "llm_request_id_required", "not_submitted")
		return
	}
	c.Header("X-PIKNO-Request-Id", requestID)
	if version != model.PiknoLLMPriceVersion && version != model.PiknoLLMArkPriceVersion {
		piknoLLMError(c, 409, "llm_price_changed", "not_submitted")
		return
	}
	config := piknoLLMSettings()
	var ark *piknoLLMArkRoute
	available := config.Enabled
	if alias == model.PiknoLLMArkModel {
		ark = piknoLLMArkChannel(config)
		available = ark != nil
	}
	if !available {
		piknoLLMError(c, 503, "llm_unavailable", "not_submitted")
		return
	}
	body, output, stream, err := piknoLLMBody(c, config, alias)
	if err != nil {
		piknoLLMError(c, 400, "llm_invalid_request", "not_submitted")
		return
	}
	piknoLLMExecute(c, body, output, stream, requestID, version, ark, false)
}

func piknoLLMExecute(c *gin.Context, body []byte, output int, stream bool, requestID, version string, ark *piknoLLMArkRoute, chat bool) {
	alias := model.PiknoLLMModel
	if ark != nil {
		alias = model.PiknoLLMArkModel
	}
	digest := sha256.Sum256(body)
	hexDigest := hex.EncodeToString(digest[:])
	uid := c.GetInt("id")
	reservation, created, err := model.ReservePiknoLLM(uid, c.GetInt("token_id"), requestID, hexDigest, version, output)
	if err != nil {
		code, status := "llm_quota_or_request_rejected", 403
		if errors.Is(err, model.ErrPiknoLLMConflict) {
			code, status = "llm_request_conflict", 409
		}
		if errors.Is(err, model.ErrPiknoLLMBusy) {
			code, status = "llm_request_pending", 409
		}
		if errors.Is(err, model.ErrPiknoLLMQuota) {
			code, status = "llm_insufficient_balance", http.StatusPaymentRequired
		}
		piknoLLMError(c, status, code, "not_submitted")
		return
	}
	if !created {
		c.JSON(http.StatusConflict, gin.H{"error": gin.H{"code": "llm_already_submitted", "submission_state": reservation.State, "message": "请查询原请求，不要重新提交"}, "request": reservation.CustomerView()})
		return
	}
	upstreamURL := "https://inference.hamsterai.cc/internal/pikno/responses"
	var credential string
	var releaseImageSlot func()
	if ark != nil {
		upstreamURL = piknoLLMArkOrigin + "/api/v3/responses"
		credential = ark.key
		if chat {
			upstreamURL = piknoLLMArkOrigin + "/api/v3/chat/completions"
		}
		body, releaseImageSlot, err = ark.requestBody(c.Request.Context(), body, chat, uid)
		if releaseImageSlot != nil {
			defer func() {
				if releaseImageSlot != nil {
					releaseImageSlot()
				}
			}()
		}
	} else {
		credential, err = piknoLLMTicket(uid, requestID, hexDigest, output)
	}
	var req *http.Request
	if err == nil {
		req, err = http.NewRequestWithContext(c.Request.Context(), http.MethodPost, upstreamURL, bytes.NewReader(body))
	}
	if err != nil {
		_, _ = model.FinishPiknoLLM(uid, requestID, "not_submitted", 0, 0)
		if errors.Is(err, errPiknoLLMImageRead) {
			logger.LogWarn(c.Request.Context(), "pikno_ark request_phase=image_read_failed")
		}
		piknoLLMError(c, 503, "llm_not_submitted", "not_submitted")
		return
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	if ark != nil {
		req.GetBody = nil
	}
	req.Header.Set("Content-Type", "application/json")
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	}
	if err = model.DispatchPiknoLLM(uid, requestID); err != nil {
		_, _ = model.FinishPiknoLLM(uid, requestID, "not_submitted", 0, 0)
		if errors.Is(err, model.ErrPiknoLLMQuota) {
			piknoLLMError(c, http.StatusPaymentRequired, "llm_insufficient_balance", "not_submitted")
		} else {
			piknoLLMError(c, 403, "llm_not_submitted", "not_submitted")
		}
		return
	}
	client := &http.Client{Transport: piknoLLMTransport, Timeout: 660 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if releaseImageSlot != nil {
		releaseImageSlot()
		releaseImageSlot = nil
	}
	if err != nil {
		if ark != nil {
			logger.LogWarn(c.Request.Context(), "pikno_ark request_phase=transport_failed")
		}
		_, _ = model.FinishPiknoLLM(uid, requestID, "unknown", 0, 0)
		piknoLLMError(c, 502, "llm_outcome_unknown", "unknown")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if ark != nil {
			logger.LogWarn(c.Request.Context(), "pikno_ark request_phase=provider_rejected upstream_http=%d", resp.StatusCode)
			_, _ = model.FinishPiknoLLM(uid, requestID, "unknown", 0, 0)
			piknoLLMError(c, 502, "llm_outcome_unknown", "unknown")
			return
		}
		outcome := "unknown"
		var result struct {
			Error struct {
				Code  string `json:"code"`
				State string `json:"submission_state"`
			} `json:"error"`
		}
		// Trust only a complete receipt from the fixed authenticated Worker.
		// A submitted-but-rejected execution is distinct from no provider POST;
		// neither bare HTTP status nor a truncated/contradictory body releases.
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 4097))
		var envelope map[string]json.RawMessage
		var fields map[string]json.RawMessage
		validReceipt := readErr == nil && len(raw) <= 4096 && common.Unmarshal(raw, &result) == nil && common.Unmarshal(raw, &envelope) == nil && len(envelope) == 1 && common.Unmarshal(envelope["error"], &fields) == nil
		if validReceipt {
			// The JSON decoder intentionally follows last-key-wins semantics.
			// Scan complete JSON string tokens before accepting a release: only
			// these four bare keys may occur, each once. Escaped quotes inside a
			// string value are not keys, and escaped spellings of keys are refused.
			seen := make(map[string]bool, 4)
			for _, span := range piknoLLMJSONStrings.FindAllIndex(raw, -1) {
				after := bytes.TrimSpace(raw[span[1]:])
				if len(after) == 0 || after[0] != ':' {
					continue
				}
				key := string(raw[span[0]:span[1]])
				if (key != `"error"` && key != `"code"` && key != `"submission_state"` && key != `"message"`) || seen[key] {
					validReceipt = false
					break
				}
				seen[key] = true
			}
			if message, present := fields["message"]; present {
				var text string
				message = bytes.TrimSpace(message)
				if len(message) == 0 || message[0] != '"' || common.Unmarshal(message, &text) != nil {
					validReceipt = false
				}
			}
		}
		if validReceipt {
			submissionState := resp.Header.Get("X-PIKNO-Submission-State")
			executionState := resp.Header.Get("X-PIKNO-Execution-State")
			if submissionState == "not_submitted" && executionState == "" && result.Error.Code == "llm_not_submitted" && result.Error.State == "not_submitted" {
				outcome = "not_submitted"
			} else if executionState == "rejected_before_execution" && submissionState == "" && result.Error.Code == "llm_rejected_before_execution" && result.Error.State == "rejected_before_execution" {
				outcome = "rejected_before_execution"
			}
		}
		if _, err = model.FinishPiknoLLM(uid, requestID, outcome, 0, 0); err != nil {
			_, _ = model.FinishPiknoLLM(uid, requestID, "unknown", 0, 0)
			outcome = "unknown"
		}
		piknoLLMError(c, 502, "llm_"+outcome, outcome)
		return
	}
	if chat {
		piknoLLMArkChatResponse(c, resp, requestID, ark, stream)
		return
	}
	if stream {
		piknoLLMStream(c, resp, uid, requestID, ark)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (16<<20)+1))
	if err != nil || len(raw) > 16<<20 {
		_, _ = model.FinishPiknoLLM(uid, requestID, "unknown", 0, 0)
		piknoLLMError(c, 502, "llm_outcome_unknown", "unknown")
		return
	}
	safe, usage, terminal, err := piknoLLMResponse(raw, alias)
	if err == nil && ark != nil {
		safe, err = ark.publicResponse(safe, uid)
	}
	if err != nil || !piknoLLMSettle(uid, requestID, usage, terminal) {
		_, _ = model.FinishPiknoLLM(uid, requestID, "unknown", 0, 0)
		piknoLLMError(c, 502, "llm_outcome_unknown", "unknown")
		return
	}
	c.Data(200, "application/json", safe)
}

func piknoLLMStream(c *gin.Context, resp *http.Response, uid int, requestID string, ark *piknoLLMArkRoute) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("X-Accel-Buffering", "no")
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 32<<20))
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	settled := false
	alias := model.PiknoLLMModel
	if ark != nil {
		alias = model.PiknoLLMArkModel
	}
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var event map[string]json.RawMessage
		if common.UnmarshalJsonStr(data, &event) != nil {
			break
		}
		var kind string
		if common.Unmarshal(event["type"], &kind) != nil || kind == "" || kind == "error" || kind == "response.error" || event["error"] != nil {
			break
		}
		expectedStatus := ""
		switch kind {
		case "response.completed":
			expectedStatus = "completed"
		case "response.failed":
			expectedStatus = "failed"
		case "response.incomplete":
			expectedStatus = "incomplete"
		}
		if response, ok := event["response"]; ok {
			var metadata struct{ Status string }
			if common.Unmarshal(response, &metadata) != nil {
				break
			}
			if expectedStatus != "" {
				if metadata.Status != expectedStatus {
					break
				}
			} else if (kind != "response.created" && kind != "response.in_progress") || (metadata.Status != "" && metadata.Status != "in_progress") {
				// Initial provider events may omit status. They are never proof
				// of terminal usage, even if another event later claims success.
				break
			}
			safe, usage, terminal, err := piknoLLMResponse(response, alias)
			if err != nil || (expectedStatus == "" && terminal) {
				break
			}
			event["response"] = safe
			if expectedStatus != "" {
				if !terminal || !piknoLLMSettle(uid, requestID, usage, true) {
					break
				}
				settled = true
			}
		} else if expectedStatus != "" || kind == "response.created" || kind == "response.in_progress" {
			break
		}
		safe, err := common.Marshal(event)
		if err == nil && ark != nil {
			safe, err = ark.publicResponse(safe, uid)
		}
		if err != nil {
			break
		}
		if _, err = c.Writer.WriteString("data: " + string(safe) + "\n\n"); err != nil {
			break
		}
		c.Writer.Flush()
		if settled {
			// The first authoritative terminal closes this operation. Never
			// forward or use later events to overwrite its result or usage.
			break
		}
	}
	if settled {
		_, _ = c.Writer.WriteString("data: [DONE]\n\n")
		c.Writer.Flush()
	} else {
		_, _ = model.FinishPiknoLLM(uid, requestID, "unknown", 0, 0)
		_, _ = c.Writer.WriteString("data: {\"type\":\"error\",\"code\":\"llm_outcome_unknown\",\"message\":\"请查询原请求状态，不要重新提交\"}\n\n")
		c.Writer.Flush()
	}
}
