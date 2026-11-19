package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPiknoStorefront(t *testing.T) {
	gin.SetMode(gin.TestMode)
	blocked := []string{
		"GET /api/subscription/plans", "POST /api/subscription/balance/pay", "POST /api/subscription/admin/bind",
		"GET /api/deployments/", "POST /api/deployments", "GET /api/vendors", "GET /api/rankings",
		"GET /api/user/aff", "POST /api/user/aff_transfer/", "POST /api/user/checkin", "GET /api/prefill_group/", "POST /api/ratio_sync/",
		"POST /v1/chat/completions", "POST /v1/responses", "GET /v1/responses/id", "GET /v1/realtime",
		"POST /v1/embeddings", "POST /v1/audio/speech", "POST /v1/models/gemini:generateContent", "POST /v1beta/models/gemini:generateContent",
		"POST /pg/chat/completions", "POST /mj/submit/imagine", "POST /fast/mj/submit/imagine", "POST /suno/submit/music",
		"POST /v1/video/generations", "POST /v1/videos/id/remix", "DELETE /v1/videos/id", "POST /v1/images/variations",
		"GET /api/subscription/epay/notify/extra", "DELETE /api/subscription/epay/notify",
		"POST /v1/tasks/task_id/artifacts/video/content", "DELETE /v1/tasks/task_id/artifacts/video/content",
		"GET /v1/tasks/task_id/artifacts/video/content/extra", "GET /v1/tasks/task_id/artifacts", "GET /v1/tasks/task_id",
		"POST /v1/client/context", "GET /v1/client/context/extra", "GET /v1/client/keys", "DELETE /v1/client/context",
		"POST /v1/tools/anything", "POST /v1/tools/depth/extra", "DELETE /v1/tools/digital",
	}
	allowed := []string{
		"GET /api/status", "POST /api/user/login", "POST /api/user/register", "POST /api/user/logout", "GET /api/user/self",
		"GET /v1/client/context",
		"POST /v1/tools/digital", "POST /v1/tools/depth",
		"GET /api/user/topup/info", "POST /api/user/amount", "POST /api/user/pay", "GET /api/user/epay/notify", "POST /api/stripe/webhook",
		"GET /api/subscription/epay/notify", "POST /api/subscription/epay/notify", "GET /api/subscription/epay/return", "POST /api/subscription/epay/return",
		"GET /api/token/", "POST /api/token/", "GET /api/models", "GET /api/pikno/lines", "POST /api/pikno/lines/admin/publish",
		"GET /api/pikno/settlements/self", "POST /api/pikno/settlements/admin/id/apply", "GET /api/log/self", "GET /api/task/self",
		"GET /api/channel/", "GET /api/task-plugins/", "GET /api/option/", "GET /api/user/aff-extra", "GET /api/vendors-extra",
		"GET /v1/models", "GET /v1/models/pikno-image-flare", "POST /v1/images/generations", "POST /v1/images/edits",
		"POST /v1/videos", "GET /v1/videos/task_id", "GET /v1/videos/task_id/content", "HEAD /v1/videos/task_id/content",
		"POST /v1/media/uploads", "POST /v1/media/complete", "POST /v1/media/direct-uploads", "POST /pikno-sanbao/tasks", "POST /pikno-canseedream/tasks",
		"GET /v1/tasks/task_id/artifacts/video/content", "HEAD /v1/tasks/task_id/artifacts/image/content",
		"GET /assets/index.js", "GET /media/v1/assets/id", "GET /wallet", "OPTIONS /v1/images/generations",
	}
	for _, group := range []struct {
		requests []string
		closed   bool
	}{{blocked, true}, {allowed, false}} {
		for _, request := range group.requests {
			t.Run(request, func(t *testing.T) {
				reached := false
				router := gin.New()
				router.Use(PiknoStorefrontGuard)
				router.NoRoute(func(c *gin.Context) { reached = true; c.Status(http.StatusNoContent) })
				parts := strings.SplitN(request, " ", 2)
				response := httptest.NewRecorder()
				router.ServeHTTP(response, httptest.NewRequest(parts[0], parts[1], nil))
				if group.closed {
					assert.False(t, reached)
					assert.Equal(t, http.StatusNotFound, response.Code)
					assert.Contains(t, response.Body.String(), "unsupported_feature")
				} else {
					assert.True(t, reached)
					assert.Equal(t, http.StatusNoContent, response.Code)
				}
			})
		}
	}
}

func TestPiknoStorefrontDedicatedArkChat(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("PIKNO_LLM_ARK_CHANNEL_ID", "7")
	router := gin.New()
	router.Use(PiknoStorefrontGuard)
	router.POST("/v1/chat/completions", func(c *gin.Context) {
		var request struct {
			Model string `json:"model"`
		}
		err := common.DecodeJson(c.Request.Body, &request)
		assert.NoError(t, err)
		assert.Equal(t, "doubao-seed-2.1-pro", request.Model)
		c.Status(http.StatusNoContent)
	})
	for _, tc := range []struct {
		path, mime, body string
		status           int
	}{
		{"/v1/chat/completions", "application/json; charset=utf-8", `{"model":"doubao-seed-2.1-pro"}`, 204},
		{"/v1/chat/completions", "application/json", `{"model":"another-model"}`, 404},
		{"/v1/chat/completions", "application/json", `{"model":"another-model","model":"doubao-seed-2.1-pro"}`, 404},
		{"/v1/chat/completions", "application/json", `{"model":"doubao-seed-2.1-pro","input":"` + strings.Repeat("x", 2<<20) + `"}`, 404},
		{"/v1/chat/completions", "text/plain", `{"model":"doubao-seed-2.1-pro"}`, 404},
		{"/v1/responses", "application/json", `{"model":"doubao-seed-2.1-pro"}`, 404},
	} {
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", tc.mime)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		assert.Equal(t, tc.status, res.Code)
	}
}

func TestPiknoStorefrontArtifactAccess(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previous := common.CryptoSecret
	common.CryptoSecret = "isolated-storefront-artifact-test-secret"
	t.Cleanup(func() { common.CryptoSecret = previous })
	access, err := service.IssueTaskArtifactAccess("task-1", "video")
	require.NoError(t, err)
	router := gin.New()
	router.Use(PiknoStorefrontGuard)
	router.GET("/v1/tasks/:key/artifacts/:artifact_key/content", middleware.TokenOrTaskArtifactAccessAuth("key", "artifact_key"), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	for _, tc := range []struct {
		path   string
		status int
	}{
		{"/v1/tasks/task-1/artifacts/video/content", http.StatusUnauthorized},
		{"/v1/tasks/task-1/artifacts/video/content?access=invalid", http.StatusNotFound},
		{"/v1/tasks/task-2/artifacts/video/content?access=" + access, http.StatusNotFound},
		{"/v1/tasks/task-1/artifacts/image/content?access=" + access, http.StatusNotFound},
		{"/v1/tasks/task-1/artifacts/video/content?access=" + access, http.StatusNoContent},
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, tc.path, nil))
		assert.Equal(t, tc.status, response.Code)
		assert.Equal(t, "private, no-store", response.Header().Get("Cache-Control"))
		assert.NotContains(t, response.Body.String(), access)
	}
}
