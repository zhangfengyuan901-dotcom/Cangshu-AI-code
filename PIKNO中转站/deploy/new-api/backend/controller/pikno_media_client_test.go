package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestPiknoMediaClientContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name       string
		uid, token int
		group      string
		status     int
	}{
		{"unauthenticated", 0, 0, "", http.StatusUnauthorized},
		{"dashboard_session_not_api_key", 4, 0, "video-standard", http.StatusUnauthorized},
		{"missing_user", 0, 5, "image-standard", http.StatusUnauthorized},
		{"unscoped_key", 4, 5, "default", http.StatusForbidden},
		{"auto_key", 4, 5, "auto", http.StatusForbidden},
		{"image_key", 4, 5, "image-standard", http.StatusOK},
		{"video_key", 4, 5, "video-standard", http.StatusOK},
		{"tool_key", 4, 5, "tool-standard", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Set("id", tc.uid)
			c.Set("token_id", tc.token)
			c.Set("token_key", "never-return-this-key")
			common.SetContextKey(c, constant.ContextKeyTokenGroup, tc.group)
			PiknoClientContext(c)
			assert.Equal(t, tc.status, response.Code)
			assert.Equal(t, "private, no-store", response.Header().Get("Cache-Control"))
			assert.NotContains(t, response.Body.String(), "never-return-this-key")
			assert.NotContains(t, response.Body.String(), "token_id")
			assert.NotContains(t, response.Body.String(), "balance")
			if tc.status == http.StatusOK {
				assert.JSONEq(t, `{"user_id":4,"group":"`+tc.group+`"}`, response.Body.String())
			}
		})
	}
}
