package middleware

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestMediaUploadRateLimitsKeepSeparateUsersOperationsAndCriticalBudgets(t *testing.T) {
	for _, redisMode := range []bool{false, true} {
		t.Run(strconv.FormatBool(redisMode), func(t *testing.T) {
			oldRedis, oldEnabled, oldNum, oldDuration := common.RedisEnabled, common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
			common.RedisEnabled, common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = false, true, 20, 1200
			t.Cleanup(func() {
				common.RedisEnabled, common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = oldRedis, oldEnabled, oldNum, oldDuration
			})
			var advance func(time.Duration)
			if redisMode {
				server, _ := useRateLimitMiniRedis(t)
				advance = server.FastForward
			}
			gin.SetMode(gin.TestMode)
			engine := gin.New()
			engine.Use(func(c *gin.Context) {
				id, _ := strconv.Atoi(c.GetHeader("X-Synthetic-User"))
				if id > 0 {
					c.Set("id", id)
				}
			})
			ok := func(c *gin.Context) { c.Status(http.StatusNoContent) }
			engine.POST("/uploads", MediaUploadRateLimit("ticket"), ok)
			engine.POST("/complete", MediaUploadRateLimit("complete"), ok)
			engine.POST("/critical", UserCriticalRateLimit("unchanged-sensitive-test"), ok)
			send := func(path string, id int) *httptest.ResponseRecorder {
				r := httptest.NewRequest(http.MethodPost, path, nil)
				r.Header.Set("X-Synthetic-User", strconv.Itoa(id))
				r.RemoteAddr = "192.0.2.250:1234"
				w := httptest.NewRecorder()
				engine.ServeHTTP(w, r)
				return w
			}
			for range 61 {
				require.Equal(t, http.StatusUnauthorized, send("/uploads", 0).Code)
			}
			uid := 740010
			if redisMode {
				uid++
			}
			for range 60 {
				require.Equal(t, http.StatusNoContent, send("/uploads", uid).Code)
				require.Equal(t, http.StatusNoContent, send("/complete", uid).Code)
			}
			for _, endpoint := range []string{"/uploads", "/complete"} {
				limited := send(endpoint, uid)
				require.Equal(t, http.StatusTooManyRequests, limited.Code)
				require.Equal(t, "60", limited.Header().Get("Retry-After"))
				require.Equal(t, http.StatusNoContent, send(endpoint, uid+10).Code, "another account has its own budget")
			}
			for range 20 {
				require.Equal(t, http.StatusNoContent, send("/critical", uid).Code)
			}
			critical := send("/critical", uid)
			require.Equal(t, http.StatusTooManyRequests, critical.Code)
			require.Equal(t, "1200", critical.Header().Get("Retry-After"))
			if advance != nil {
				advance(time.Minute)
				require.Equal(t, http.StatusNoContent, send("/uploads", uid).Code)
				require.Equal(t, http.StatusNoContent, send("/complete", uid).Code)
				require.Equal(t, http.StatusTooManyRequests, send("/critical", uid).Code)
			}
		})
	}
}
