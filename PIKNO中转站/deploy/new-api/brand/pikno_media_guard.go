package controller

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

// Runs after account/token authentication and before channel selection or billing.
func PiknoMediaGuard(c *gin.Context) {
	path := c.Request.URL.Path
	tool := path == "/v1/tools/digital" || path == "/v1/tools/depth"
	video := tool || path == "/v1/videos" || path == "/pikno-sanbao/tasks" || path == "/pikno-canseedream/tasks"
	image := path == "/v1/images/edits" || path == "/v1/images/generations"
	if c.Request.Method != http.MethodPost || (!video && !image) {
		c.Next()
		return
	}
	reject := func(code int, message string) {
		c.AbortWithStatusJSON(code, gin.H{"error": gin.H{"message": message, "type": "invalid_media_reference"}})
	}
	if c.GetInt("id") < 1 {
		reject(401, "Authentication required")
		return
	}
	mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || mediaType != "application/json" {
		reject(415, "Use JSON with completed PIKNO media URLs")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10))
	if err != nil {
		reject(413, "Video JSON exceeds 64 KiB")
		return
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(raw))
	var body map[string]json.RawMessage
	if common.Unmarshal(raw, &body) != nil || body == nil {
		reject(400, "Invalid JSON object")
		return
	}
	var requestedModel string
	if common.Unmarshal(body["model"], &requestedModel) != nil || strings.TrimSpace(requestedModel) == "" {
		reject(400, "A published PIKNO model is required")
		return
	}
	line, lineErr := model.GetPublishedPiknoLine(requestedModel)
	if lineErr != nil || (image && line.Kind != "image") || (video && line.Kind != "video") {
		reject(400, "Model is not an open PIKNO line for this endpoint")
		return
	}
	if tool && requestedModel != "pikno-tool-"+strings.TrimPrefix(path, "/v1/tools/") {
		reject(400, "Select the matching published tool line")
		return
	}
	requiredGroup := "video-standard"
	if image {
		requiredGroup = "image-standard"
	}
	if common.GetContextKeyString(c, constant.ContextKeyTokenGroup) != requiredGroup {
		reject(403, "This API key is not authorized for this generation type")
		return
	}
	if tool {
		ready, err := piknoReadToolReadiness(c.Request.Context())
		if err != nil || !ready.available(strings.TrimPrefix(path, "/v1/tools/")) {
			reject(http.StatusServiceUnavailable, "Tool execution connection is not configured; no task was submitted")
			return
		}
	}
	if image {
		allowed := map[string]bool{"model": true, "prompt": true, "n": true, "size": true, "quality": true, "response_format": true, "output_format": true, "images": true}
		if line.Provider == "packy" && line.UpstreamModel == "gpt-image-2" {
			for _, field := range []string{"output_compression", "background", "moderation", "input_fidelity", "user"} {
				allowed[field] = true
			}
			if err := validatePiknoImage2Options(body, path == "/v1/images/edits", line); err != nil {
				reject(400, err.Error())
				return
			}
		}
		for field := range body {
			if !allowed[field] {
				reject(400, "Unsupported image field")
				return
			}
		}
		var model, prompt, format string
		var n int
		if common.Unmarshal(body["model"], &model) != nil || model != requestedModel || common.Unmarshal(body["prompt"], &prompt) != nil || strings.TrimSpace(prompt) == "" {
			reject(400, "Unsupported image model or empty prompt")
			return
		}
		if body["n"] != nil && (common.Unmarshal(body["n"], &n) != nil || n != 1) {
			reject(400, "n must be 1")
			return
		}
		if body["response_format"] != nil && (common.Unmarshal(body["response_format"], &format) != nil || format != "url") {
			reject(400, "response_format must be url")
			return
		}
		var refs []string
		if body["images"] != nil && common.Unmarshal(body["images"], &refs) != nil {
			reject(400, "images must contain completed PIKNO URLs")
			return
		}
		maxRefs := 5
		if line.UpstreamModel == "gpt-image-2" {
			maxRefs = min(1, line.MaxImages)
		}
		if (path == "/v1/images/edits" && (len(refs) < 1 || len(refs) > maxRefs)) || (path == "/v1/images/generations" && len(refs) != 0) {
			reject(400, "Reference count is outside the published image line limits")
			return
		}
	}
	count := 0
	for _, field := range []string{"image_urls", "images", "video_urls", "videos", "audio_urls", "audios"} {
		value, exists := body[field]
		if !exists {
			continue
		}
		var items []json.RawMessage
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || common.Unmarshal(value, &items) != nil {
			reject(400, "Reference media must be an array")
			return
		}
		count += len(items)
		if count > 20 {
			reject(400, "Too many reference assets")
			return
		}
		kind := strings.Split(field, "_")[0]
		kind = strings.TrimSuffix(kind, "s")
		for _, item := range items {
			var reference string
			if common.Unmarshal(item, &reference) != nil {
				var object map[string]json.RawMessage
				if common.Unmarshal(item, &object) != nil || object["data_url"] != nil || common.Unmarshal(object["url"], &reference) != nil {
					reject(400, "Use completed PIKNO media URLs")
					return
				}
			}
			p, err := piknoValidateMediaURL(reference, c.GetInt("id"), kind)
			if err != nil {
				reject(403, "Invalid, expired or foreign media reference; upload and complete the asset first")
				return
			}
			if err := piknoInspectReference(c, p); err != nil {
				reject(409, "Reference asset is unavailable; upload and complete it again")
				return
			}
		}
	}
	c.Next()
}

// Reject invalid provider options before any quota reservation or edge request.
func validatePiknoImage2Options(body map[string]json.RawMessage, editing bool, line *model.PiknoLineConfig) error {
	values := make(map[string]string)
	for _, field := range []string{"size", "quality", "output_format", "background", "moderation", "input_fidelity", "user"} {
		if raw, ok := body[field]; ok {
			var value *string
			if common.Unmarshal(raw, &value) != nil || value == nil || *value == "" || len(*value) > 256 || strings.ContainsAny(*value, "\r\n") {
				return errors.New("Invalid image option: " + field)
			}
			values[field] = *value
		}
	}
	if size := values["size"]; size != "" && size != "auto" {
		width, height, ok := strings.Cut(size, "x")
		w, ew := strconv.Atoi(width)
		h, eh := strconv.Atoi(height)
		if !ok || ew != nil || eh != nil || w <= 0 || h <= 0 || w > 3840 || h > 3840 || w%16 != 0 || h%16 != 0 || max(w, h) > 3*min(w, h) || w*h < 655360 || w*h > 8294400 {
			return errors.New("Image dimensions are outside the supported range")
		}
	}
	if size := values["size"]; size != "" && !slices.Contains(line.Resolutions, size) {
		return errors.New("Image size is not offered by this published line")
	}
	for field, options := range map[string][]string{
		"quality":       {"auto", "low", "medium", "high"},
		"output_format": {"png", "jpeg"}, "background": {"opaque"},
		"moderation": {"auto", "low"}, "input_fidelity": {"high"},
	} {
		if value := values[field]; value != "" && !slices.Contains(options, value) {
			return errors.New("Unsupported image option: " + field)
		}
	}
	if quality := values["quality"]; quality != "" && len(line.Qualities) > 0 && !slices.Contains(line.Qualities, quality) {
		return errors.New("Image quality is not offered by this published line")
	}
	if values["input_fidelity"] != "" && !editing {
		return errors.New("input_fidelity is only supported for image editing")
	}
	if raw, ok := body["output_compression"]; ok {
		var compression *int
		if values["output_format"] != "jpeg" || common.Unmarshal(raw, &compression) != nil || compression == nil || *compression < 0 || *compression > 100 {
			return errors.New("output_compression requires jpeg and an integer from 0 to 100")
		}
	}
	return nil
}

func piknoValidateMediaURL(raw string, uid int, kind string) (piknoMediaTicket, error) {
	var p piknoMediaTicket
	invalid := errors.New("invalid media reference")
	secret := os.Getenv("PIKNO_MEDIA_TICKET_KEY")
	if os.Getenv("PIKNO_MEDIA_ENABLED") != "true" || len(secret) < 32 {
		return p, invalid
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "www.piknoai.com" || u.User != nil || u.Fragment != "" || u.RawPath != "" {
		return p, invalid
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(q) != 1 || len(q["ticket"]) != 1 {
		return p, invalid
	}
	token := q.Get("ticket")
	if len(token) > 2048 {
		return p, invalid
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return p, invalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return p, invalid
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return p, invalid
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || common.Unmarshal(data, &p) != nil {
		return p, invalid
	}
	now := time.Now().Unix()
	id, err := hex.DecodeString(p.ID)
	limits := map[string]int64{"image/png": 30 << 20, "image/jpeg": 30 << 20, "image/webp": 30 << 20, "video/mp4": 50 << 20, "video/webm": 50 << 20, "video/quicktime": 50 << 20, "audio/mpeg": 50 << 20, "audio/wav": 50 << 20, "audio/mp4": 50 << 20, "audio/aac": 50 << 20}
	if err != nil || len(id) != 16 || u.Path != "/media/v1/assets/"+p.ID || p.Version != 1 || p.Audience != "pikno-relay-media" || p.Operation != "read" || p.UserID != uid || uid < 1 || p.Issued > now+30 || p.Expires <= now || p.Expires <= p.Issued || p.Expires-p.Issued > 7200 || !strings.HasPrefix(p.MIME, kind+"/") || p.Size < 12 || p.Size > limits[p.MIME] {
		return p, invalid
	}
	return p, nil
}

func piknoInspectReference(c *gin.Context, p piknoMediaTicket) error {
	p.Operation = "inspect"
	p.Issued = time.Now().Unix()
	p.Expires = p.Issued + 60
	token, err := piknoSignMedia(p, os.Getenv("PIKNO_MEDIA_TICKET_KEY"))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), "POST", "https://www.piknoai.com/media/v1/assets/"+p.ID+"/inspect", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("media inspection failed")
	}
	defer resp.Body.Close()
	var result struct {
		ID     string `json:"id"`
		Owner  int    `json:"owner_id"`
		Size   int64  `json:"size"`
		MIME   string `json:"content_type"`
		Status string `json:"status"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&result) != nil || result.ID != p.ID || result.Owner != p.UserID || result.Size != p.Size || result.MIME != p.MIME || result.Status != "ready" {
		return errors.New("asset not ready")
	}
	return nil
}
