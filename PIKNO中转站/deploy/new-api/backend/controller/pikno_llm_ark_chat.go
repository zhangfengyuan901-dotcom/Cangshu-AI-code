package controller

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

// PiknoLLMArkChat intercepts only the paid, opt-in alias. Other models keep
// the original distributor and billing behavior on /v1/chat/completions.
func PiknoLLMArkChat(c *gin.Context) {
	contentType, _, _ := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if contentType != "application/json" {
		c.Next()
		return
	}
	alias, err := middleware.ReadChatModel(c)
	if err != nil || alias != model.PiknoLLMArkModel {
		c.Next()
		return
	}
	c.Abort()
	c.Header("Cache-Control", "private, no-store")
	if !piknoLLMAccess(c, alias) {
		return
	}
	if version := c.GetHeader("X-PIKNO-Price-Version"); version != "" && version != model.PiknoLLMArkPriceVersion {
		piknoLLMError(c, 409, "llm_price_changed", "not_submitted")
		return
	}
	requestID := c.GetHeader("X-PIKNO-Request-Id")
	if requestID == "" {
		var generated [16]byte
		rand.Read(generated[:])
		requestID = hex.EncodeToString(generated[:])
	}
	if !piknoLLMID.MatchString(requestID) {
		piknoLLMError(c, 400, "llm_request_id_invalid", "not_submitted")
		return
	}
	c.Header("X-PIKNO-Request-Id", requestID)
	config := piknoLLMSettings()
	ark := piknoLLMArkChannel(config)
	if ark == nil {
		piknoLLMError(c, 503, "llm_unavailable", "not_submitted")
		return
	}
	body, output, stream, ok := piknoLLMArkChatBody(c, config.OutputLimit)
	if !ok {
		piknoLLMError(c, 400, "llm_invalid_request", "not_submitted")
		return
	}
	piknoLLMExecute(c, body, output, stream, requestID, model.PiknoLLMArkPriceVersion, ark, true)
}

func piknoLLMArkChatBody(c *gin.Context, outputLimit int) ([]byte, int, bool, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20))
	var body map[string]common.RawMessage
	if err != nil || common.Unmarshal(raw, &body) != nil || body == nil {
		return nil, 0, false, false
	}
	var stream bool
	var requestedOutput *int
	for field, value := range body {
		switch field {
		case "model", "messages":
		case "stream":
			if common.Unmarshal(value, &stream) != nil {
				return nil, 0, false, false
			}
		case "max_tokens", "max_completion_tokens":
			if body["max_tokens"] != nil && body["max_completion_tokens"] != nil || common.Unmarshal(value, &requestedOutput) != nil {
				return nil, 0, false, false
			}
		case "stream_options":
			var options map[string]common.RawMessage
			var includeUsage bool
			if common.Unmarshal(value, &options) != nil || len(options) != 1 || common.Unmarshal(options["include_usage"], &includeUsage) != nil {
				return nil, 0, false, false
			}
		default:
			return nil, 0, false, false
		}
	}
	if requestedOutput != nil {
		if *requestedOutput < 1 || *requestedOutput > outputLimit {
			return nil, 0, false, false
		}
		outputLimit = *requestedOutput
	}
	var messages []map[string]common.RawMessage
	if common.Unmarshal(body["messages"], &messages) != nil || len(messages) < 1 || len(messages) > 128 {
		return nil, 0, false, false
	}
	refs := make(map[string]bool)
	for _, message := range messages {
		var role string
		if len(message) != 2 || common.Unmarshal(message["role"], &role) != nil ||
			(role != "user" && role != "assistant" && role != "system") ||
			!piknoLLMArkChatContent(c, message["content"], role == "user", refs) {
			return nil, 0, false, false
		}
	}
	delete(body, "max_completion_tokens")
	body["max_tokens"], _ = common.Marshal(outputLimit)
	encoded, err := common.Marshal(body)
	return encoded, outputLimit, stream, err == nil
}

func piknoLLMArkChatContent(c *gin.Context, content common.RawMessage, user bool, refs map[string]bool) bool {
	if common.GetJsonType(content) == "string" {
		return strings.TrimSpace(common.JsonRawMessageToString(content)) != ""
	}
	var parts []map[string]common.RawMessage
	if common.Unmarshal(content, &parts) != nil || len(parts) == 0 || len(parts) > 128 {
		return false
	}
	count := 0
	for _, part := range parts {
		var kind string
		if len(part) != 2 || common.Unmarshal(part["type"], &kind) != nil {
			return false
		}
		if kind == "text" && common.GetJsonType(part["text"]) == "string" {
			continue
		}
		if !user || !piknoLLMArkMediaEnabled() || (kind != "image_url" && kind != "video_url") {
			return false
		}
		var asset map[string]common.RawMessage
		var url string
		if common.Unmarshal(part[kind], &asset) != nil || common.Unmarshal(asset["url"], &url) != nil || url == "" {
			return false
		}
		if !piknoLLMArkFPS(asset["fps"], kind == "video_url", len(asset)+1) {
			return false
		}
		count++
		if count > 6 || !piknoLLMArkMediaReference(c, url, strings.TrimSuffix(kind, "_url"), refs) {
			return false
		}
	}
	return true
}

func piknoLLMArkFPS(raw common.RawMessage, video bool, fields int) bool {
	if fields == 2 {
		return raw == nil
	}
	var fps float64
	return video && fields == 3 && common.Unmarshal(raw, &fps) == nil && fps >= 0.2 && fps <= 5
}

func piknoLLMArkMediaEnabled() bool {
	return os.Getenv("PIKNO_LLM_ARK_MEDIA_VERIFIED") == "true" && os.Getenv("PIKNO_MEDIA_ENABLED") == "true" && len(os.Getenv("PIKNO_MEDIA_TICKET_KEY")) >= 32
}

func piknoLLMArkMediaReference(c *gin.Context, url, kind string, refs map[string]bool) bool {
	key := kind + "\x00" + url
	if refs[key] {
		return true
	}
	if len(refs) >= 12 {
		return false
	}
	// Only the completion endpoint can issue this ownership-bound read ticket.
	// The provider fetches it directly from the fixed PIKNO media origin.
	ticket, err := piknoValidateMediaURL(url, c.GetInt("id"), kind)
	if err != nil {
		return false
	}
	// Ark's URL inputs have smaller limits than generation reference uploads.
	if kind == "image" && ticket.Size > 10_000_000 ||
		kind == "video" && (ticket.MIME == "video/webm" || ticket.Size > 50_000_000) {
		return false
	}
	refs[key] = true
	return true
}

func piknoLLMArkChatResponse(c *gin.Context, resp *http.Response, requestID string, ark *piknoLLMArkRoute, stream bool) {
	uid := c.GetInt("id")
	if !stream {
		raw, err := io.ReadAll(io.LimitReader(resp.Body, (16<<20)+1))
		if err == nil && len(raw) <= 16<<20 {
			safe, usage, terminal, err := ark.chatChunk(raw, false, uid)
			if err == nil && piknoLLMSettle(uid, requestID, usage, terminal) {
				c.Data(200, "application/json", safe)
				return
			}
		}
		_, _ = model.FinishPiknoLLM(uid, requestID, "unknown", 0, 0)
		piknoLLMError(c, 502, "llm_outcome_unknown", "unknown")
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("X-Accel-Buffering", "no")
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 32<<20))
	scanner.Buffer(make([]byte, 64<<10), 8<<20)
	var usage *piknoLLMUsage
	var usageFrame []byte
	var finished bool
	for scanner.Scan() {
		data, ok := strings.CutPrefix(scanner.Text(), "data:")
		if !ok || strings.TrimSpace(data) == "" {
			continue
		}
		if strings.TrimSpace(data) == "[DONE]" {
			if piknoLLMSettle(uid, requestID, usage, finished) {
				_, _ = c.Writer.WriteString("data: " + string(usageFrame) + "\n\ndata: [DONE]\n\n")
				c.Writer.Flush()
				return
			}
			break
		}
		safe, frameUsage, terminal, err := ark.chatChunk([]byte(strings.TrimSpace(data)), true, uid)
		if err != nil {
			break
		}
		finished = finished || terminal
		if frameUsage != nil {
			if usage != nil || !finished {
				break
			}
			usage, usageFrame = frameUsage, safe
			continue
		}
		if usage != nil {
			break
		}
		if _, err := c.Writer.WriteString("data: " + string(safe) + "\n\n"); err != nil {
			break
		}
		c.Writer.Flush()
	}
	_, _ = model.FinishPiknoLLM(uid, requestID, "unknown", 0, 0)
	_, _ = c.Writer.WriteString("data: {\"error\":{\"code\":\"llm_outcome_unknown\",\"message\":\"请查询原请求状态，不要重新提交\"}}\n\n")
	c.Writer.Flush()
}

func (route *piknoLLMArkRoute) chatChunk(raw []byte, stream bool, uid int) ([]byte, *piknoLLMUsage, bool, error) {
	var frame struct {
		Object  string            `json:"object"`
		Error   common.RawMessage `json:"error"`
		Choices []struct {
			Finish string `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			Input   *int `json:"prompt_tokens"`
			Output  *int `json:"completion_tokens"`
			Total   *int `json:"total_tokens"`
			Details *struct {
				Cached *int `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
		} `json:"usage"`
	}
	object := "chat.completion"
	if stream {
		object = "chat.completion.chunk"
	}
	if common.Unmarshal(raw, &frame) != nil || frame.Error != nil || frame.Object != object || len(frame.Choices) > 1 {
		return nil, nil, false, io.ErrUnexpectedEOF
	}
	terminal := len(frame.Choices) == 1 && frame.Choices[0].Finish != ""
	var usage *piknoLLMUsage
	if frame.Usage != nil {
		usage = &piknoLLMUsage{Input: frame.Usage.Input, Output: frame.Usage.Output, Total: frame.Usage.Total, Details: frame.Usage.Details}
	}
	safe, err := route.publicResponse(raw, uid)
	return safe, usage, terminal, err
}
