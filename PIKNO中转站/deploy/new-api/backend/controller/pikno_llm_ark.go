package controller

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

const (
	piknoLLMArkOrigin   = "https://ark.cn-beijing.volces.com"
	piknoLLMArkEndpoint = "ep-20260915150237-29rfx"
)

var piknoLLMArkPrivateMedia = regexp.MustCompile(`https://www\.piknoai\.com/media/v1/assets/[0-9a-fA-F]{32}\?ticket=[A-Za-z0-9_.%-]+`)
var piknoLLMArkInlineMedia = regexp.MustCompile(`(?i)data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+`)
var piknoLLMArkImageTransport http.RoundTripper = http.DefaultTransport
var piknoLLMArkImageSlots = make(chan struct{}, 2)
var errPiknoLLMImageRead = errors.New("could not prepare signed image")

type piknoLLMArkRoute struct {
	key string
}

func piknoLLMArkDedicatedChannel(channel *model.Channel) bool {
	id := model.PiknoLLMArkChannelID()
	return id > 0 && channel != nil && channel.Id == id
}

func piknoLLMArkChannel(config piknoLLMConfig) *piknoLLMArkRoute {
	id := model.PiknoLLMArkChannelID()
	if id < 1 || os.Getenv("PIKNO_LLM_ARK_VERIFIED") != "true" ||
		os.Getenv("PIKNO_LLM_ENABLED") != "true" || os.Getenv("PIKNO_LLM_BILLING_MODE") != model.PiknoLLMBillingMode ||
		config.OutputLimit < 1 || config.OutputLimit > model.PiknoLLMMaxOutputTokens || common.RedisEnabled || common.BatchUpdateEnabled {
		return nil
	}
	channel, err := model.CacheGetChannel(id)
	if err != nil || channel == nil || channel.Status != common.ChannelStatusEnabled || channel.Type != constant.ChannelTypeVolcEngine ||
		channel.ChannelInfo.IsMultiKey || channel.GetBaseURL() != piknoLLMArkOrigin ||
		!slices.Equal(channel.GetGroups(), []string{model.PiknoLLMGroup}) || !slices.Equal(channel.GetModels(), []string{model.PiknoLLMArkModel}) ||
		channel.Key == "" || strings.ContainsAny(channel.Key, "\r\n\t ") || strings.HasPrefix(channel.Key, "[") {
		return nil
	}
	// Keep the single accepted mapping exact, including one unambiguous key.
	// The runtime purposefully does not apply general routing or overrides.
	mapping := make(map[string]string)
	raw := []byte(channel.GetModelMapping())
	if common.Unmarshal(raw, &mapping) != nil || len(mapping) != 1 || mapping[model.PiknoLLMArkModel] != piknoLLMArkEndpoint || len(piknoLLMJSONStrings.FindAllIndex(raw, 3)) != 2 {
		return nil
	}
	return &piknoLLMArkRoute{key: channel.Key}
}

func piknoLLMArkCapability(config piknoLLMConfig) gin.H {
	media := piknoLLMArkMediaEnabled()
	return gin.H{"model": model.PiknoLLMArkModel, "label": "高性能对话", "price_version": model.PiknoLLMArkPriceVersion,
		"billing_mode": model.PiknoLLMBillingMode, "available": true,
		"pricing":      gin.H{"currency": "CNY", "input_cny_per_million": model.PiknoLLMArkInputRate, "output_cny_per_million": model.PiknoLLMArkOutputRate, "cached_input_cny_per_million": model.PiknoLLMArkCachedInputRate},
		"capabilities": gin.H{"text": true, "sse": true, "image": media, "pdf": false, "video": media, "files": media, "audio": false, "tools": false, "verified": true},
		"limits":       gin.H{"max_output_tokens": config.OutputLimit, "max_request_bytes": 2 << 20, "max_messages": 128, "max_file_bytes": piknoLLMMaxFileBytes, "max_attachments": 6, "max_history_attachments": 12},
	}
}

func (route *piknoLLMArkRoute) requestBody(ctx context.Context, raw []byte, chat bool, uid int) ([]byte, func(), error) {
	var body map[string]any
	if err := common.Unmarshal(raw, &body); err != nil {
		return nil, nil, err
	}
	body["model"] = piknoLLMArkEndpoint
	var release func()
	if !chat {
		body["store"] = false
		body["service_tier"] = "default"
		var err error
		release, err = piknoLLMInlineImages(ctx, body, uid)
		if err != nil {
			return nil, release, err
		}
	} else if body["stream"] == true {
		body["stream_options"] = gin.H{"include_usage": true}
	}
	encoded, err := common.Marshal(body)
	return encoded, release, err
}

func piknoLLMInlineImages(ctx context.Context, body map[string]any, uid int) (func(), error) {
	// Ark accepts Base64 images below 10 MB and a body below 64 MB. Keep
	// larger image sets on the existing URL path and bound prepared body memory.
	const maxInlineBytes = 40_000_000
	var parts []map[string]any
	tickets := make(map[string]piknoMediaTicket)
	var expanded int
	messages, _ := body["input"].([]any)
	for _, item := range messages {
		message, _ := item.(map[string]any)
		content, _ := message["content"].([]any)
		for _, entry := range content {
			part, _ := entry.(map[string]any)
			if part["type"] != "input_image" {
				continue
			}
			url, _ := part["image_url"].(string)
			ticket, ok := tickets[url]
			if !ok {
				var err error
				ticket, err = piknoValidateMediaURL(url, uid, "image")
				if err != nil || ticket.Size > 10_000_000 {
					return nil, errPiknoLLMImageRead
				}
				tickets[url] = ticket
			}
			expanded += base64.StdEncoding.EncodedLen(int(ticket.Size)) + 32
			if expanded > maxInlineBytes {
				return nil, nil
			}
			parts = append(parts, part)
		}
	}
	if len(parts) == 0 {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	select {
	case piknoLLMArkImageSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, errPiknoLLMImageRead
	}
	release := func() { <-piknoLLMArkImageSlots }
	client := http.Client{Transport: piknoLLMArkImageTransport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	encoded := make(map[string]string, len(tickets))
	for url, ticket := range tickets {
		data, err := piknoLLMReadImage(ctx, &client, url, ticket)
		if err != nil {
			return release, errPiknoLLMImageRead
		}
		encoded[url] = "data:" + ticket.MIME + ";base64," + base64.StdEncoding.EncodeToString(data)
	}
	for _, part := range parts {
		part["image_url"] = encoded[part["image_url"].(string)]
	}
	return release, nil
}

func piknoLLMReadImage(ctx context.Context, client *http.Client, url string, ticket piknoMediaTicket) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, errPiknoLLMImageRead
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errPiknoLLMImageRead
	}
	defer resp.Body.Close()
	contentType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || resp.StatusCode != http.StatusOK || contentType != ticket.MIME ||
		resp.ContentLength >= 0 && resp.ContentLength != ticket.Size {
		return nil, errPiknoLLMImageRead
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, ticket.Size+1))
	if err != nil || int64(len(data)) != ticket.Size || !piknoDirectMIMEMatches(ticket.MIME, data) {
		return nil, errPiknoLLMImageRead
	}
	return data, nil
}

func (route *piknoLLMArkRoute) publicResponse(raw []byte, uid int) ([]byte, error) {
	var body map[string]any
	if err := common.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return common.Marshal(route.publicValue(body, uid))
}

// Keep the same public Responses fields as the Worker when going directly to Ark.
func (route *piknoLLMArkRoute) publicValue(value any, uid int) any {
	switch v := value.(type) {
	case []any:
		for index, item := range v {
			v[index] = route.publicValue(item, uid)
		}
	case map[string]any:
		for key, item := range v {
			switch key {
			case "model":
				v[key] = model.PiknoLLMArkModel
			case "error":
				if item != nil {
					v[key] = gin.H{"code": "llm_response_failed", "message": "PIKNO 对话返回未完成"}
				}
			case "reason":
				if reason, ok := item.(string); !ok || (reason != "max_output_tokens" && reason != "content_filter" && reason != "max_tool_calls") {
					v[key] = "unknown"
				}
			case "id", "item_id", "response_id":
				if id, ok := item.(string); ok && id != "" {
					// Avoid exposing raw provider identifiers or correlating accounts.
					v[key] = fmt.Sprintf("hi1_%x", sha256.Sum256(fmt.Appendf(nil, "%d\x00%s", uid, id)))
				} else {
					delete(v, key)
				}
			case "type", "object", "created_at", "status", "output", "usage", "input_tokens", "output_tokens", "total_tokens",
				"input_tokens_details", "output_tokens_details", "cached_tokens", "reasoning_tokens", "role", "content", "text", "delta", "summary",
				"sequence_number", "output_index", "content_index", "summary_index", "part", "item", "response", "max_output_tokens", "incomplete_details",
				"choices", "created", "index", "message", "finish_reason", "reasoning_content", "prompt_tokens", "completion_tokens", "prompt_tokens_details", "completion_tokens_details":
				v[key] = route.publicValue(item, uid)
			default:
				delete(v, key)
			}
		}
	case string:
		if route.key != "" {
			v = strings.ReplaceAll(v, route.key, model.PiknoLLMArkModel)
		}
		v = piknoLLMArkPrivateMedia.ReplaceAllString(v, "[附件]")
		v = piknoLLMArkInlineMedia.ReplaceAllString(v, "[附件]")
		return strings.NewReplacer(piknoLLMArkEndpoint, model.PiknoLLMArkModel, piknoLLMArkOrigin, model.PiknoLLMArkModel).Replace(v)
	}
	return value
}
