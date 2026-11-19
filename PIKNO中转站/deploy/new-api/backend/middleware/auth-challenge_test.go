package middleware

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func authChallengeFixture(t *testing.T) (*gin.Engine, *miniredis.Miniredis) {
	t.Helper()
	t.Setenv("AUTH_CHALLENGE_PROVIDER", common.LocalAuthChallengeProvider)
	server := miniredis.RunT(t)
	server.Select(1)
	t.Setenv("AUTH_CHALLENGE_REDIS_URL", "redis://"+server.Addr()+"/1")
	t.Setenv("REDIS_CONN_STRING", "")
	oldRedis, oldEnabled, oldTurnstile := common.RDB, common.RedisEnabled, common.TurnstileCheckEnabled
	common.RDB = nil
	common.RedisEnabled = false
	common.TurnstileCheckEnabled = false // local mode must enforce independently.
	t.Cleanup(func() {
		common.RDB, common.RedisEnabled, common.TurnstileCheckEnabled = oldRedis, oldEnabled, oldTurnstile
	})
	router := gin.New()
	router.GET("/api/auth/challenge", IssueLocalAuthChallenge)
	router.POST("/api/auth/challenge/verify", VerifyLocalAuthChallenge)
	router.POST("/api/user/login", TurnstileCheck(), func(c *gin.Context) { c.JSON(200, gin.H{"success": true}) })
	router.POST("/api/user/register", TurnstileCheck(), func(c *gin.Context) { c.JSON(200, gin.H{"success": true}) })
	router.GET("/api/verification", TurnstileCheck(), func(c *gin.Context) { c.JSON(200, gin.H{"success": true}) })
	router.GET("/api/reset_password", TurnstileCheck(), func(c *gin.Context) { c.JSON(200, gin.H{"success": true}) })
	router.POST("/api/user/checkin", TurnstileCheck(), func(c *gin.Context) { c.JSON(200, gin.H{"success": true}) })
	return router, server
}

func TestLocalAuthChallengeDedicatedRedisLeavesApplicationRedisDisabled(t *testing.T) {
	router, server := authChallengeFixture(t)
	id, cookie := issuedChallenge(t, router, server)
	token := answerChallenge(t, router, id, cookie)
	assert.Equal(t, 200, challengeRequest(router, "POST", "/api/user/login?turnstile="+token, "{}", cookie).Code)
	assert.False(t, common.RedisEnabled)
	assert.Nil(t, common.RDB)
	assert.NotEmpty(t, server.Keys())
	server.Select(0)
	assert.Empty(t, server.Keys(), "authentication storage and budgets must not use the application DB")
}

func TestLocalAuthChallengeDedicatedRedisConfigurationFailsClosed(t *testing.T) {
	router, server := authChallengeFixture(t)
	// A working application Redis is deliberately present. Missing or broken
	// auth storage must still fail closed rather than silently falling back.
	common.RDB = redis.NewClient(&redis.Options{Addr: server.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = common.RDB.Close() })
	applicationClient := common.RDB
	for _, url := range []string{"", "https://synthetic-secret@redis.invalid/1"} {
		t.Setenv("AUTH_CHALLENGE_REDIS_URL", url)
		w := challengeRequest(router, "GET", "/api/auth/challenge", "", nil)
		assert.Equal(t, 503, w.Code)
		assert.NotContains(t, w.Body.String(), "synthetic-secret")
		assert.NotContains(t, w.Body.String(), "redis.invalid")
		assert.Empty(t, w.Result().Cookies())
		assert.Same(t, applicationClient, common.RDB)
		assert.False(t, common.RedisEnabled)
	}
	server.Select(0)
	assert.Empty(t, server.Keys())
	server.Select(1)
	assert.Empty(t, server.Keys())
}

func TestLocalAuthChallengeDedicatedRedisLazyConcurrentAndBounded(t *testing.T) {
	_, server := authChallengeFixture(t)
	t.Setenv("AUTH_CHALLENGE_PROVIDER", "")
	client, err := common.AuthChallengeRedisClient()
	require.Error(t, err)
	assert.Nil(t, client)
	assert.Equal(t, 0, server.CurrentConnectionCount())
	t.Setenv("AUTH_CHALLENGE_PROVIDER", common.LocalAuthChallengeProvider)
	var wg sync.WaitGroup
	clients := make(chan *redis.Client, 8)
	errors := make(chan error, 8)
	for range 8 {
		wg.Go(func() {
			client, err := common.AuthChallengeRedisClient()
			clients <- client
			errors <- err
		})
	}
	wg.Wait()
	close(clients)
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
	for item := range clients {
		if client == nil {
			client = item
		}
		assert.Same(t, client, item)
	}
	require.NotNil(t, client)
	assert.Equal(t, 0, server.CurrentConnectionCount(), "configuration alone must not open Redis connections")
	options := client.Options()
	assert.Equal(t, 0, options.MaxRetries, "go-redis normalizes -1 to zero retries")
	for _, timeout := range []time.Duration{options.DialTimeout, options.ReadTimeout, options.WriteTimeout, options.PoolTimeout} {
		assert.Positive(t, timeout)
		assert.LessOrEqual(t, timeout, 2*time.Second)
	}
	require.NoError(t, client.Ping(context.Background()).Err())
	assert.False(t, common.RedisEnabled)
	assert.Nil(t, common.RDB)
}

func challengeRequest(router http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "https://auth.example.test"+path, strings.NewReader(body))
	req.Header.Set("Origin", "https://auth.example.test")
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func issuedChallenge(t *testing.T, router http.Handler, server *miniredis.Miniredis) (string, *http.Cookie) {
	t.Helper()
	w := challengeRequest(router, "GET", "/api/auth/challenge", "", nil)
	require.Equal(t, 200, w.Code, w.Body.String())
	var body struct {
		Data struct {
			ID, Image string
			ExpiresIn int `json:"expires_in"`
		}
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, 120, body.Data.ExpiresIn)
	assert.True(t, strings.HasPrefix(body.Data.Image, "data:image/png;base64,"))
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(body.Data.Image, "data:image/png;base64,"))
	require.NoError(t, err)
	img, err := png.Decode(bytes.NewReader(data))
	require.NoError(t, err)
	assert.Equal(t, 210, img.Bounds().Dx())
	cookies := w.Result().Cookies()
	require.Len(t, cookies, 1)
	cookie := cookies[0]
	assert.True(t, cookie.Secure)
	assert.True(t, cookie.HttpOnly)
	assert.Equal(t, http.SameSiteStrictMode, cookie.SameSite)
	assert.Equal(t, "/", cookie.Path)
	assert.Empty(t, cookie.Domain)
	assert.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	key := challengeKey("question", challengeHash(cookie.Value), body.Data.ID)
	assert.Equal(t, localChallengeTTL, server.TTL(key))
	// A known answer is installed only in this isolated fixture. The HTTP
	// response and production store expose no answer text.
	require.NoError(t, server.Set(key, challengeHash("123456")))
	server.SetTTL(key, localChallengeTTL)
	return body.Data.ID, cookie
}

func answerChallenge(t *testing.T, router http.Handler, id string, cookie *http.Cookie) string {
	t.Helper()
	w := challengeRequest(router, "POST", "/api/auth/challenge/verify", `{"id":"`+id+`","answer":"123456"}`, cookie)
	require.Equal(t, 200, w.Code, w.Body.String())
	var body struct{ Data struct{ Token string } }
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	return body.Data.Token
}

func TestLocalAuthChallengeBoundAndSingleUse(t *testing.T) {
	router, server := authChallengeFixture(t)
	id, cookie := issuedChallenge(t, router, server)
	other := *cookie
	other.Value = strings.Repeat("A", 43)
	assert.Equal(t, 400, challengeRequest(router, "POST", "/api/auth/challenge/verify", `{"id":"`+id+`","answer":"123456"}`, &other).Code)
	token := answerChallenge(t, router, id, cookie)
	assert.Equal(t, 403, challengeRequest(router, "POST", "/api/user/checkin?turnstile="+token, "{}", cookie).Code)
	assert.Equal(t, 400, challengeRequest(router, "POST", "/api/auth/challenge/verify", `{"id":"`+id+`","answer":"123456"}`, cookie).Code)
	assert.Equal(t, 400, challengeRequest(router, "POST", "/api/user/login?turnstile="+token, "{}", &other).Code)
	assert.Equal(t, 200, challengeRequest(router, "POST", "/api/user/login?turnstile="+token, "{}", cookie).Code)
	assert.Equal(t, 400, challengeRequest(router, "POST", "/api/user/login?turnstile="+token, "{}", cookie).Code)
}

func TestLocalAuthChallengeWrongAnswerExpiryAndReplay(t *testing.T) {
	for _, action := range []string{"wrong", "malformed", "expired", "proof-expired"} {
		t.Run(action, func(t *testing.T) {
			router, server := authChallengeFixture(t)
			id, cookie := issuedChallenge(t, router, server)
			if action == "proof-expired" {
				token := answerChallenge(t, router, id, cookie)
				server.FastForward(121 * time.Second)
				assert.Equal(t, 400, challengeRequest(router, "POST", "/api/user/login?turnstile="+token, "{}", cookie).Code)
				return
			}
			answer := "000000"
			if action == "malformed" {
				answer = "1234567"
			}
			if action == "expired" {
				server.FastForward(121 * time.Second)
				answer = "123456"
			}
			w := challengeRequest(router, "POST", "/api/auth/challenge/verify", `{"id":"`+id+`","answer":"`+answer+`"}`, cookie)
			assert.Equal(t, 400, w.Code)
			assert.Equal(t, 400, challengeRequest(router, "POST", "/api/auth/challenge/verify", `{"id":"`+id+`","answer":"123456"}`, cookie).Code)
		})
	}
}

func TestLocalAuthChallengeConcurrentAnswersOnlyOneProof(t *testing.T) {
	router, server := authChallengeFixture(t)
	id, cookie := issuedChallenge(t, router, server)
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- challengeRequest(router, "POST", "/api/auth/challenge/verify", `{"id":"`+id+`","answer":"123456"}`, cookie).Code
		}()
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	assert.Equal(t, map[int]int{200: 1, 400: 1}, counts)
}

func TestLocalAuthChallengeRejectsBypassOriginAndOutage(t *testing.T) {
	router, server := authChallengeFixture(t)
	id, cookie := issuedChallenge(t, router, server)
	assert.Equal(t, 400, challengeRequest(router, "POST", "/api/user/login?provider=turnstile&turnstile=external-token", "{}", cookie).Code)
	req := httptest.NewRequest("POST", "https://auth.example.test/api/auth/challenge/verify", strings.NewReader(`{"id":"`+id+`","answer":"123456"}`))
	req.Header.Set("Origin", "https://other.example.test")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	assert.Equal(t, 403, w.Code)
	token := answerChallenge(t, router, id, cookie)
	server.Close()
	assert.Equal(t, 503, challengeRequest(router, "POST", "/api/user/login?turnstile="+token, "{}", cookie).Code)
	t.Setenv("AUTH_CHALLENGE_PROVIDER", "misspelled")
	assert.Equal(t, 503, challengeRequest(router, "POST", "/api/user/login", "{}", cookie).Code)
	t.Setenv("AUTH_CHALLENGE_PROVIDER", "")
	assert.Equal(t, 200, challengeRequest(router, "POST", "/api/user/login", "{}", cookie).Code)
}

func TestLocalAuthChallengeProofConcurrentConsumptionAndAllowedRoutes(t *testing.T) {
	for _, route := range []string{"POST /api/user/login", "POST /api/user/register", "GET /api/verification", "GET /api/reset_password"} {
		t.Run(route, func(t *testing.T) {
			router, server := authChallengeFixture(t)
			id, cookie := issuedChallenge(t, router, server)
			token := answerChallenge(t, router, id, cookie)
			method, path, _ := strings.Cut(route, " ")
			var wg sync.WaitGroup
			results := make(chan int, 2)
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					results <- challengeRequest(router, method, path+"?turnstile="+token, "{}", cookie).Code
				}()
			}
			wg.Wait()
			close(results)
			counts := map[int]int{}
			for status := range results {
				counts[status]++
			}
			assert.Equal(t, map[int]int{200: 1, 400: 1}, counts)
		})
	}
}

func TestLocalAuthChallengeAccessLogOmitsSecretsWithoutChangingRequest(t *testing.T) {
	var output bytes.Buffer
	previous := gin.DefaultWriter
	gin.DefaultWriter = &output
	t.Cleanup(func() { gin.DefaultWriter = previous })
	router := gin.New()
	SetUpLogger(router)
	const marker = "synthetic-usable-proof-do-not-log"
	for _, path := range []string{"/api/user/login", "/api/user/register", "/api/verification", "/api/reset_password", "/api/auth/challenge", "/api/auth/challenge/verify", "/user/reset", "/auth-lite/index.html"} {
		router.GET(path, func(c *gin.Context) { c.String(200, c.Query("turnstile")) })
		w := challengeRequest(router, "GET", path+"?turnstile="+marker+"&email=private@example.test&token=email-token", "", nil)
		assert.Equal(t, marker, w.Body.String())
	}
	assert.NotContains(t, output.String(), marker)
	assert.NotContains(t, output.String(), "private@example.test")
	assert.NotContains(t, output.String(), "email-token")
	assert.NotContains(t, output.String(), "?")
	assert.Contains(t, output.String(), "/api/user/login")
}

func TestLocalAuthChallengeIssuanceBudgetAndDisabledProvider(t *testing.T) {
	router, server := authChallengeFixture(t)
	for i := 0; i < 20; i++ {
		require.Equal(t, 200, challengeRequest(router, "GET", "/api/auth/challenge", "", nil).Code)
	}
	w := challengeRequest(router, "GET", "/api/auth/challenge", "", nil)
	assert.Equal(t, 429, w.Code)
	assert.NotEmpty(t, w.Header().Get("Retry-After"))
	// An already rejected IP cannot consume the final global slot. The next
	// browser can still issue a challenge; the global cap then rejects another.
	require.NoError(t, server.Set(localChallengeNamespace+"rate:issue:global", "299"))
	server.SetTTL(localChallengeNamespace+"rate:issue:global", time.Minute)
	assert.Equal(t, 429, challengeRequest(router, "GET", "/api/auth/challenge", "", nil).Code)
	req := httptest.NewRequest("GET", "https://auth.example.test/api/auth/challenge", nil)
	req.Header.Set("Origin", "https://auth.example.test")
	req.RemoteAddr = "198.51.100.2:1234"
	global := httptest.NewRecorder()
	router.ServeHTTP(global, req)
	assert.Equal(t, 200, global.Code)
	req = httptest.NewRequest("GET", "https://auth.example.test/api/auth/challenge", nil)
	req.Header.Set("Origin", "https://auth.example.test")
	req.RemoteAddr = "198.51.100.3:1234"
	global = httptest.NewRecorder()
	router.ServeHTTP(global, req)
	assert.Equal(t, 429, global.Code)
	t.Setenv("AUTH_CHALLENGE_PROVIDER", "")
	assert.Equal(t, 503, challengeRequest(router, "GET", "/api/auth/challenge", "", nil).Code)
}
