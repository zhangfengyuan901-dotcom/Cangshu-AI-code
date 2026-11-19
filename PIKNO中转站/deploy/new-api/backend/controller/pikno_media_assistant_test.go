package controller

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type piknoAssistantRoundTripFunc func(*http.Request) (*http.Response, error)

func (f piknoAssistantRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPiknoMediaAssistant(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("PIKNO_ASSISTANT_ENABLED", "true")
	t.Setenv("PIKNO_ASSISTANT_BRIDGE_SECRET", strings.Repeat("test-only-", 4))
	previous := piknoAssistantTransport
	t.Cleanup(func() { piknoAssistantTransport = previous })
	short := "c2hvcnQ." + strings.Repeat("a", 43)
	t.Run("disabled_activation_has_a_stable_machine_code", func(t *testing.T) {
		t.Setenv("PIKNO_ASSISTANT_ENABLED", "false")
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Request = httptest.NewRequest("POST", "/assistant/v1/activate", nil)
		PiknoAssistantActivate(c)
		assert.Equal(t, http.StatusServiceUnavailable, response.Code)
		assert.JSONEq(t, `{"error":"Assistant unavailable","code":"assistant_disabled"}`, response.Body.String())
	})
	t.Run("missing_bridge_secret_remains_a_reportable_unavailable_error", func(t *testing.T) {
		t.Setenv("PIKNO_ASSISTANT_BRIDGE_SECRET", "")
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Request = httptest.NewRequest("POST", "/assistant/v1/activate", nil)
		PiknoAssistantActivate(c)
		assert.Equal(t, http.StatusServiceUnavailable, response.Code)
		assert.NotContains(t, response.Body.String(), "assistant_disabled")
	})
	t.Run("activation_delegates_identity_not_customer_key", func(t *testing.T) {
		piknoAssistantTransport = piknoAssistantRoundTripFunc(func(r *http.Request) (*http.Response, error) {
			assert.Equal(t, "https://inference.hamsterai.cc/internal/pikno/activate", r.URL.String())
			assert.NotContains(t, r.Header.Get("Authorization"), "customer-secret")
			parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
			require.Len(t, parts, 2)
			claims, err := base64.RawURLEncoding.DecodeString(parts[0])
			require.NoError(t, err)
			assert.Contains(t, string(claims), `"aud":"hamster-pikno-activation"`)
			assert.NotContains(t, string(claims), "customer-secret")
			body, err := common.Marshal(gin.H{"token": short, "expiresAt": time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339Nano)})
			require.NoError(t, err)
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		})
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Request = httptest.NewRequest("POST", "/assistant/v1/activate", nil)
		c.Set("id", 7)
		c.Set("token_id", 5)
		c.Set("token_key", "customer-secret")
		common.SetContextKey(c, constant.ContextKeyTokenGroup, "video-standard")
		PiknoAssistantActivate(c)
		assert.Equal(t, 200, response.Code)
		assert.Contains(t, response.Body.String(), short)
		assert.NotContains(t, response.Body.String(), "customer-secret")
	})
	t.Run("proxy_is_narrow_and_does_not_forward_customer_key", func(t *testing.T) {
		calls := 0
		piknoAssistantTransport = piknoAssistantRoundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			assert.Equal(t, "https://inference.hamsterai.cc/api/v3/responses", r.URL.String())
			assert.Empty(t, r.Header.Get("Cookie"))
			assert.Empty(t, r.Header.Get("X-API-Key"))
			assert.Equal(t, "Bearer "+short, r.Header.Get("Authorization"))
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: test\n\n"))}, nil
		})
		for _, tc := range []struct {
			method, path, auth string
			status             int
		}{
			{"POST", "/assistant/api/v3/responses", "Bearer " + short, 200},
			{"POST", "/assistant/api/v3/responses", "Bearer sk-customer-secret", 401},
			{"POST", "/assistant/api/v3/chat/completions", "Bearer " + short, 404},
			{"GET", "/assistant/api/v3/responses/id", "Bearer " + short, 404},
			{"POST", "/assistant/api/v3/responses?target=https://evil.test", "Bearer " + short, 404},
		} {
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Request = httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}"))
			c.Request.Header.Set("Authorization", tc.auth)
			c.Request.Header.Set("Cookie", "private-cookie")
			c.Request.Header.Set("X-API-Key", "private-key")
			PiknoAssistantProxy(c)
			assert.Equal(t, tc.status, response.Code)
			assert.NotContains(t, response.Body.String(), "private-cookie")
		}
		assert.Equal(t, 1, calls)
	})
	t.Run("opaque file handles retain the narrow path policy", func(t *testing.T) {
		calls := 0
		piknoAssistantTransport = piknoAssistantRoundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			assert.True(t, strings.HasPrefix(r.URL.Path, "/api/v3/files/ho1_"))
			assert.Equal(t, "Bearer "+short, r.Header.Get("Authorization"))
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"status":"ready"}`))}, nil
		})
		handle := "ho1_" + strings.Repeat("a", 16) + "_" + strings.Repeat("b", 1000)
		for _, tc := range []struct {
			method, suffix string
			status         int
		}{
			{"GET", handle, 200}, {"DELETE", handle, 200},
			{"GET", "ho1_" + strings.Repeat("a", 2044), 200},
			{"GET", "", 404},
			{"GET", strings.Repeat("a", 2049), 404},
			{"GET", handle + "/content", 404},
			{"GET", handle + ".extra", 404},
			{"POST", handle, 404},
		} {
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Request = httptest.NewRequest(tc.method, "/assistant/api/v3/files/"+tc.suffix, nil)
			c.Request.Header.Set("Authorization", "Bearer "+short)
			PiknoAssistantProxy(c)
			assert.Equal(t, tc.status, response.Code)
		}
		assert.Equal(t, 3, calls)
	})
	t.Run("provider_error_body_is_not_exposed", func(t *testing.T) {
		piknoAssistantTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 403, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("ep-private sk-provider https://private.test"))}, nil
		})
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Request = httptest.NewRequest("POST", "/assistant/api/v3/responses", strings.NewReader("{}"))
		c.Request.Header.Set("Authorization", "Bearer "+short)
		PiknoAssistantProxy(c)
		assert.Equal(t, 403, response.Code)
		assert.NotContains(t, response.Body.String(), "private")
		assert.NotContains(t, response.Body.String(), "sk-")
	})
}
