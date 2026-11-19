package middleware

import (
	"context"
	"github.com/QuantumNous/new-api/common"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func useRateLimitMiniRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()

	previousRedisEnabled := common.RedisEnabled
	previousRedisClient := common.RDB
	redisServer := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: redisServer.Addr()})
	require.NoError(t, redisClient.Ping(context.Background()).Err())

	common.RedisEnabled = true
	common.RDB = redisClient
	t.Cleanup(func() {
		_ = redisClient.Close()
		common.RedisEnabled = previousRedisEnabled
		common.RDB = previousRedisClient
	})

	return redisServer, redisClient
}

func performRateLimitRequest(router http.Handler, path string, remoteAddr string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.RemoteAddr = remoteAddr
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestRedisIPRateLimiterThresholdTTLAndNamespace(t *testing.T) {
	gin.SetMode(gin.TestMode)
	redisServer, _ := useRateLimitMiniRedis(t)

	router := gin.New()
	require.NoError(t, router.SetTrustedProxies(nil))
	router.GET("/limited", rateLimitFactory(2, 37, "TEST"), func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})

	remoteAddr := "192.0.2.10:12345"
	legacyKey := "rateLimit:TEST192.0.2.10"
	_, err := redisServer.Push(legacyKey, "legacy-list-entry")
	require.NoError(t, err)
	assert.Equal(t, http.StatusNoContent, performRateLimitRequest(router, "/limited", remoteAddr).Code)
	assert.Equal(t, http.StatusNoContent, performRateLimitRequest(router, "/limited", remoteAddr).Code)
	limitedResponse := performRateLimitRequest(router, "/limited", remoteAddr)
	assert.Equal(t, http.StatusTooManyRequests, limitedResponse.Code)
	assert.Equal(t, "37", limitedResponse.Header().Get("Retry-After"))

	key := redisIPRateLimitKey("TEST", "192.0.2.10")
	count, err := redisServer.Get(key)
	require.NoError(t, err)
	assert.Equal(t, "3", count)
	assert.Equal(t, 37*time.Second, redisServer.TTL(key))
	assert.True(t, redisServer.Exists(legacyKey), "the v2 counter must not touch an old list key")
}

func TestRedisUserRateLimiterUsesSharedFixedWindow(t *testing.T) {
	gin.SetMode(gin.TestMode)
	redisServer, _ := useRateLimitMiniRedis(t)

	router := gin.New()
	router.GET(
		"/limited",
		func(c *gin.Context) { c.Set("id", 42) },
		userRateLimitFactory(1, 23, "USER"),
		func(c *gin.Context) { c.Status(http.StatusNoContent) },
	)

	assert.Equal(t, http.StatusNoContent, performRateLimitRequest(router, "/limited", "192.0.2.20:12345").Code)
	assert.Equal(t, http.StatusTooManyRequests, performRateLimitRequest(router, "/limited", "198.51.100.20:12345").Code)

	key := redisUserRateLimitKey("USER", 42)
	assert.True(t, redisServer.Exists(key))
	assert.Equal(t, 23*time.Second, redisServer.TTL(key))
}

func TestRedisEmailVerificationRateLimiterPreservesResponseAndTTL(t *testing.T) {
	gin.SetMode(gin.TestMode)
	redisServer, _ := useRateLimitMiniRedis(t)

	router := gin.New()
	require.NoError(t, router.SetTrustedProxies(nil))
	router.GET("/verify", EmailVerificationRateLimit(), func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})

	remoteAddr := "192.0.2.30:12345"
	assert.Equal(t, http.StatusNoContent, performRateLimitRequest(router, "/verify", remoteAddr).Code)
	assert.Equal(t, http.StatusNoContent, performRateLimitRequest(router, "/verify", remoteAddr).Code)
	response := performRateLimitRequest(router, "/verify", remoteAddr)
	assert.Equal(t, http.StatusTooManyRequests, response.Code)
	assert.JSONEq(t, `{"success":false,"message":"发送过于频繁，请等待 30 秒后再试"}`, response.Body.String())

	key := redisIPRateLimitKey(EmailVerificationRateLimitMark, "192.0.2.30")
	assert.True(t, redisServer.Exists(key))
	assert.Equal(t, time.Duration(EmailVerificationDuration)*time.Second, redisServer.TTL(key))
}

func TestRedisFixedWindowIsAtomicUnderConcurrency(t *testing.T) {
	redisServer, _ := useRateLimitMiniRedis(t)
	const (
		requestCount = 20
		maximumCount = 7
		duration     = int64(41)
	)
	key := redisIPRateLimitKey("CONCURRENT", "192.0.2.40")

	var allowedCount atomic.Int64
	errorsFound := make(chan error, requestCount)
	var waitGroup sync.WaitGroup
	waitGroup.Add(requestCount)
	for range requestCount {
		go func() {
			defer waitGroup.Done()
			allowed, _, _, err := redisFixedWindowTake(context.Background(), key, maximumCount, duration)
			if err != nil {
				errorsFound <- err
				return
			}
			if allowed {
				allowedCount.Add(1)
			}
		}()
	}
	waitGroup.Wait()
	close(errorsFound)
	for err := range errorsFound {
		require.NoError(t, err)
	}

	assert.Equal(t, int64(maximumCount), allowedCount.Load())
	count, err := redisServer.Get(key)
	require.NoError(t, err)
	assert.Equal(t, "20", count)
	assert.Equal(t, time.Duration(duration)*time.Second, redisServer.TTL(key))
}

func TestRedisFixedWindowResetsAtBoundary(t *testing.T) {
	redisServer, _ := useRateLimitMiniRedis(t)
	const duration = int64(10)
	key := redisIPRateLimitKey("BOUNDARY", "192.0.2.50")

	for range 2 {
		allowed, _, _, err := redisFixedWindowTake(context.Background(), key, 2, duration)
		require.NoError(t, err)
		assert.True(t, allowed)
	}
	allowed, _, _, err := redisFixedWindowTake(context.Background(), key, 2, duration)
	require.NoError(t, err)
	assert.False(t, allowed)

	// This reset is intentional fixed-window behavior. A client can consume one
	// full allowance immediately before and another immediately after a boundary.
	redisServer.FastForward(time.Duration(duration) * time.Second)
	for range 2 {
		allowed, _, _, err = redisFixedWindowTake(context.Background(), key, 2, duration)
		require.NoError(t, err)
		assert.True(t, allowed)
	}
}

func TestRedisFixedWindowRepairsCounterWithoutTTL(t *testing.T) {
	redisServer, _ := useRateLimitMiniRedis(t)
	const duration = int64(29)
	key := redisIPRateLimitKey("MISSING-TTL", "192.0.2.51")
	redisServer.Set(key, "5")

	allowed, count, ttl, err := redisFixedWindowTake(context.Background(), key, 3, duration)
	require.NoError(t, err)
	assert.False(t, allowed)
	assert.Equal(t, int64(6), count)
	assert.Equal(t, duration, ttl)
	assert.Equal(t, time.Duration(duration)*time.Second, redisServer.TTL(key))

	redisServer.FastForward(time.Duration(duration) * time.Second)
	assert.False(t, redisServer.Exists(key), "a recovered counter must not remain permanently rate-limited")
}

func TestRedisFailurePolicies(t *testing.T) {
	gin.SetMode(gin.TestMode)
	_, redisClient := useRateLimitMiniRedis(t)
	require.NoError(t, redisClient.Close())

	router := gin.New()
	require.NoError(t, router.SetTrustedProxies(nil))
	router.GET("/ip", rateLimitFactory(1, 30, "FAIL-IP"), func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})
	router.GET(
		"/user",
		func(c *gin.Context) { c.Set("id", 7) },
		userRateLimitFactory(1, 30, "FAIL-USER"),
		func(c *gin.Context) { c.Status(http.StatusNoContent) },
	)
	router.GET("/email", EmailVerificationRateLimit(), func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})

	ipResponse := performRateLimitRequest(router, "/ip", "192.0.2.60:12345")
	assert.Equal(t, http.StatusInternalServerError, ipResponse.Code)
	assert.Empty(t, ipResponse.Body.String())
	userResponse := performRateLimitRequest(router, "/user", "192.0.2.61:12345")
	assert.Equal(t, http.StatusInternalServerError, userResponse.Code)
	assert.Empty(t, userResponse.Body.String())
	assert.Equal(t, http.StatusNoContent, performRateLimitRequest(router, "/email", "192.0.2.62:12345").Code)
}

func TestAssistantFileStatusRateLimitIsolation(t *testing.T) {
	clock, _ := useRateLimitMiniRedis(t)
	old, number, duration := common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = true, 20, 1200
	t.Cleanup(func() {
		common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = old, number, duration
	})
	router := gin.New()
	router.Use(func(c *gin.Context) {
		if c.Query("anonymous") != "" {
			return
		}
		if c.Query("other") != "" {
			c.Set("id", 258)
		} else {
			c.Set("id", 158)
		}
	})
	router.GET("/files", AssistantFileStatusRateLimit(), func(c *gin.Context) { c.Status(204) })
	router.POST("/files", UserCriticalRateLimit("assistant-files"), func(c *gin.Context) { c.Status(204) })
	send := func(method, url string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(method, url, nil))
		return w
	}
	require.Equal(t, 401, send("GET", "/files?anonymous=1").Code)
	for i := 0; i < 120; i++ {
		require.Equal(t, 204, send("GET", "/files").Code)
	}
	limited := send("GET", "/files")
	require.Equal(t, 429, limited.Code)
	require.Equal(t, "60", limited.Header().Get("Retry-After"))
	require.Equal(t, 204, send("GET", "/files?other=1").Code)
	for i := 0; i < 20; i++ {
		require.Equal(t, 204, send("POST", "/files").Code)
	}
	require.Equal(t, 429, send("POST", "/files").Code)
	clock.FastForward(61 * time.Second)
	require.Equal(t, 204, send("GET", "/files").Code)
	require.Equal(t, 429, send("POST", "/files").Code)
}

func TestAssistantChatStatusRateLimitBudget(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, backend := range []string{"redis", "memory"} {
		t.Run(backend, func(t *testing.T) {
			oldEnabled, oldNumber, oldDuration := common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
			oldRedisEnabled := common.RedisEnabled
			common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = true, 20, 1200
			t.Cleanup(func() {
				common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = oldEnabled, oldNumber, oldDuration
				common.RedisEnabled = oldRedisEnabled
			})

			var advance func(time.Duration)
			if backend == "redis" {
				clock, _ := useRateLimitMiniRedis(t)
				advance = clock.FastForward
			} else {
				common.RedisEnabled = false
				// Initialize outside the fake-clock bubble so a cleanup ticker
				// cannot keep that bubble alive after the test returns.
				inMemoryRateLimiter.Init(common.RateLimitKeyExpirationDuration)
				advance = time.Sleep
			}

			run := func(t *testing.T) {
				router := gin.New()
				router.Use(func(c *gin.Context) {
					if c.Query("anonymous") != "" {
						return
					}
					if c.Query("other") != "" {
						c.Set("id", 593)
					} else {
						c.Set("id", 592)
					}
				})
				router.GET("/requests/:id", AssistantChatStatusRateLimit(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
				writes := []struct{ path, scope string }{
					{"/responses", "assistant-llm"},
					{"/files", "assistant-files"},
					{"/quote", "desktop-context"},
					{"/uploads", "media-upload"},
				}
				for _, write := range writes {
					router.POST(write.path, UserCriticalRateLimit(write.scope), func(c *gin.Context) { c.Status(http.StatusNoContent) })
				}
				send := func(method, path string) *httptest.ResponseRecorder {
					response := httptest.NewRecorder()
					router.ServeHTTP(response, httptest.NewRequest(method, path, nil))
					return response
				}

				assert.Equal(t, http.StatusUnauthorized, send(http.MethodGet, "/requests/original?anonymous=1").Code)
				for range 60 {
					require.Equal(t, http.StatusNoContent, send(http.MethodGet, "/requests/original").Code)
				}
				limited := send(http.MethodGet, "/requests/another")
				assert.Equal(t, http.StatusTooManyRequests, limited.Code)
				assert.Equal(t, "60", limited.Header().Get("Retry-After"))
				assert.Equal(t, http.StatusNoContent, send(http.MethodGet, "/requests/original?other=1").Code)
				for _, write := range writes {
					for range 20 {
						require.Equal(t, http.StatusNoContent, send(http.MethodPost, write.path).Code, write.path)
					}
					limited = send(http.MethodPost, write.path)
					assert.Equal(t, http.StatusTooManyRequests, limited.Code, write.path)
					assert.Equal(t, "1200", limited.Header().Get("Retry-After"), write.path)
				}
				advance(60 * time.Second)
				assert.Equal(t, http.StatusNoContent, send(http.MethodGet, "/requests/original").Code)
				for _, write := range writes {
					assert.Equal(t, http.StatusTooManyRequests, send(http.MethodPost, write.path).Code, write.path)
				}

				common.CriticalRateLimitEnable = false
				router.GET("/unlimited", AssistantChatStatusRateLimit(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
				for range 61 {
					require.Equal(t, http.StatusNoContent, send(http.MethodGet, "/unlimited").Code)
				}
			}
			if backend == "memory" {
				synctest.Test(t, run)
			} else {
				run(t)
			}
		})
	}
}
