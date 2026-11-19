package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestHamster45DesktopReadBudgetAndWriteIsolation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	clock, _ := useRateLimitMiniRedis(t)
	previous, limit, duration := common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = true, 20, 1200
	t.Cleanup(func() {
		common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = previous, limit, duration
	})
	router := gin.New()
	router.Use(func(c *gin.Context) {
		if c.Query("other") != "" {
			c.Set("id", 52)
		} else {
			c.Set("id", 51)
		}
	})
	router.GET("/context", DesktopConnectionRateLimit(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	router.POST("/activate", DesktopConnectionRateLimit(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	router.POST("/quote", UserCriticalRateLimit("desktop-context"), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	send := func(method, path string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(method, path, nil))
		return response
	}
	for i := 0; i < 30; i++ {
		require.Equal(t, 204, send("GET", "/context").Code)
		require.Equal(t, 204, send("POST", "/activate").Code)
	}
	limited := send("GET", "/context")
	require.Equal(t, 429, limited.Code)
	require.Equal(t, "60", limited.Header().Get("Retry-After"))
	require.Equal(t, 204, send("GET", "/context?other=1").Code)
	for i := 0; i < 20; i++ {
		require.Equal(t, 204, send("POST", "/quote").Code)
	}
	quote := send("POST", "/quote")
	require.Equal(t, 429, quote.Code)
	require.Equal(t, "1200", quote.Header().Get("Retry-After"))
	clock.FastForward(61 * time.Second)
	require.Equal(t, 204, send("GET", "/context").Code)
	require.Equal(t, 429, send("POST", "/quote").Code)
}

func TestHamster45DesktopReadRequiresAuthenticatedUser(t *testing.T) {
	useRateLimitMiniRedis(t)
	previous := common.CriticalRateLimitEnable
	common.CriticalRateLimitEnable = true
	t.Cleanup(func() { common.CriticalRateLimitEnable = previous })
	router := gin.New()
	router.GET("/context", DesktopConnectionRateLimit(), func(c *gin.Context) { c.Status(204) })
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest("GET", "/context", nil))
	require.Equal(t, 401, response.Code)
}
