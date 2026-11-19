package controller

import (
	"mime"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func piknoPathWithin(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// Product boundary only. Allowed requests still run existing auth, line,
// ownership, media and settlement guards. No price or balance changes here.
func PiknoStorefrontGuard(c *gin.Context) {
	path := c.Request.URL.Path
	closed := false
	if piknoPathWithin(path, "/api/subscription") {
		// Do not strand historical payments already sent to a payment provider.
		callback := path == "/api/subscription/epay/notify" || path == "/api/subscription/epay/return"
		closed = !(callback && (c.Request.Method == http.MethodGet || c.Request.Method == http.MethodPost))
	}
	for _, prefix := range []string{"/api/rankings", "/api/deployments", "/api/vendors", "/api/prefill_group", "/api/ratio_sync", "/pg", "/v1beta", "/suno", "/mj"} {
		closed = closed || piknoPathWithin(path, prefix)
	}
	for _, endpoint := range []string{"/api/user/aff", "/api/user/aff_transfer", "/api/user/checkin"} {
		closed = closed || strings.TrimSuffix(path, "/") == endpoint
	}
	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) >= 2 && segments[1] == "mj" {
		closed = true
	}
	if piknoPathWithin(path, "/v1") {
		// The dedicated conversation alias and existing product APIs use
		// their own authentication, account and settlement checks.
		allowed := c.Request.Method == http.MethodGet && piknoPathWithin(path, "/v1/models")
		allowed = allowed || (c.Request.Method == http.MethodGet && path == "/v1/client/context")
		if c.Request.Method == http.MethodGet {
			allowed = allowed || path == "/v1/reverse/capabilities" || path == "/v1/reverse/quote"
			if len(segments) == 4 && segments[1] == "reverse" {
				allowed = allowed || (segments[2] == "tasks" && strings.HasPrefix(segments[3], "rvt_") && piknoReverseLocalID.MatchString(segments[3]))
				allowed = allowed || (segments[2] == "operations" && piknoReverseOperationID.MatchString(segments[3]))
			}
		}
		if c.Request.Method == http.MethodPost {
			allowed = path == "/v1/images/generations" || path == "/v1/images/edits" || path == "/v1/videos" || path == "/v1/media/uploads" || path == "/v1/media/complete"
			allowed = allowed || path == "/v1/tools/digital" || path == "/v1/tools/depth"
			allowed = allowed || path == "/v1/media/direct-uploads"
			allowed = allowed || path == "/v1/client/quote"
			allowed = allowed || path == "/v1/reverse/uploads" || path == "/v1/reverse/tasks"
			if path == "/v1/chat/completions" && model.PiknoLLMArkChannelID() > 0 {
				contentType, _, _ := mime.ParseMediaType(c.GetHeader("Content-Type"))
				if contentType == "application/json" {
					c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
					defer common.CleanupBodyStorage(c)
					alias, err := middleware.ReadChatModel(c)
					allowed = err == nil && alias == model.PiknoLLMArkModel
				}
			}
		}
		if len(segments) == 3 && segments[1] == "videos" && c.Request.Method == http.MethodGet {
			allowed = true
		}
		if len(segments) == 4 && segments[1] == "videos" && segments[3] == "content" && (c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead) {
			allowed = true
		}
		// Dashboard media previews use this existing read-only content route.
		// Its original capability/token authentication and ownership checks still run.
		if len(segments) == 6 && segments[1] == "tasks" && segments[3] == "artifacts" && segments[5] == "content" && (c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead) {
			allowed = true
		}
		// Preflight carries no generation request; existing CORS handlers own it.
		closed = closed || (!allowed && c.Request.Method != http.MethodOptions)
	}
	if closed {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{
			"success": false,
			"message": "当前接口未开放。仓鼠AI各项功能的价格与扣费以 PIKNO 中转站为准。",
			"error":   gin.H{"type": "unsupported_feature", "message": "This feature is not available in the PIKNO storefront"},
		})
		return
	}
	c.Next()
}
