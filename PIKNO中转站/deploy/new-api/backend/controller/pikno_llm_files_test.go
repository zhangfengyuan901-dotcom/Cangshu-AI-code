package controller

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPiknoLLMFiles(t *testing.T) {
	t.Run("file ticket binds account method path content type and exact bytes without billing", func(t *testing.T) {
		user, token, router := setupPiknoLLMTest(t)
		t.Setenv("PIKNO_LLM_FILES_ENABLED", "true")
		router.POST("/assistant/v2/files", middleware.TokenAuth(), PiknoLLMFiles)
		router.GET("/assistant/v2/files/:file", middleware.TokenAuthReadOnly(), PiknoLLMFiles)
		router.DELETE("/assistant/v2/files/:file", middleware.TokenAuthReadOnly(), PiknoLLMFiles)
		handle := "hf1_" + strings.Repeat("a", 80)
		calls := 0
		piknoLLMTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			calls++
			raw, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			parts := strings.Split(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "), ".")
			require.Len(t, parts, 2)
			decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
			require.NoError(t, err)
			var claims map[string]any
			require.NoError(t, common.Unmarshal(decoded, &claims))
			assert.Equal(t, float64(user.Id), claims["uid"])
			assert.Equal(t, "pikno-llm-file", claims["aud"])
			assert.Equal(t, req.Method, claims["method"])
			assert.Equal(t, req.URL.Path, claims["path"])
			assert.Equal(t, req.Header.Get("Content-Type"), claims["content_type"])
			digest := sha256.Sum256(raw)
			assert.Equal(t, hex.EncodeToString(digest[:]), claims["body_sha256"])
			mac := hmac.New(sha256.New, []byte(strings.Repeat("synthetic-", 4)))
			mac.Write([]byte(parts[0]))
			assert.Equal(t, base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), parts[1])
			assert.Equal(t, float64(60), claims["exp"].(float64)-claims["iat"].(float64))
			var value gin.H
			if req.Method == "DELETE" {
				value = gin.H{"id": handle, "object": "file", "deleted": true, "private": "secret"}
			} else {
				value = gin.H{"id": handle, "object": "file", "purpose": "user_data", "status": "active", "bytes": 10, "created_at": time.Now().Unix(), "expire_at": time.Now().Unix() + 600, "private": "secret"}
			}
			encoded, err := common.Marshal(value)
			require.NoError(t, err)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(encoded)))}, nil
		})
		for _, method := range []string{"POST", "GET", "DELETE"} {
			path := "/assistant/v2/files"
			body := ""
			if method != "POST" {
				path += "/" + handle
			} else {
				body = "--example\r\nfile bytes\r\n--example--"
			}
			req := httptest.NewRequest(method, path, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer sk-"+token.Key)
			if method == "POST" {
				req.Header.Set("Content-Type", "multipart/form-data; boundary=example")
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			require.Equal(t, 200, w.Code, w.Body.String())
			assert.NotContains(t, w.Body.String(), "secret")
		}
		assert.Equal(t, 3, calls)
		var rows int64
		require.NoError(t, model.DB.Model(&model.PiknoLLMRequest{}).Count(&rows).Error)
		assert.Zero(t, rows)
		var fresh model.User
		require.NoError(t, model.DB.First(&fresh, user.Id).Error)
		assert.Equal(t, user.Quota, fresh.Quota)
		var freshToken model.Token
		require.NoError(t, model.DB.First(&freshToken, token.Id).Error)
		assert.Equal(t, token.RemainQuota, freshToken.RemainQuota)
	})
	t.Run("disabled malformed revoked and wrong-purpose requests never reach file provider", func(t *testing.T) {
		_, token, router := setupPiknoLLMTest(t)
		router.POST("/assistant/v2/files", middleware.TokenAuth(), PiknoLLMFiles)
		router.GET("/assistant/v2/files/:file", middleware.TokenAuthReadOnly(), PiknoLLMFiles)
		assert.Equal(t, 503, piknoLLMTestCall(router, token, "POST", "/assistant/v2/files", "", "").Code)
		t.Setenv("PIKNO_LLM_FILES_ENABLED", "true")
		assert.Equal(t, 400, piknoLLMTestCall(router, token, "POST", "/assistant/v2/files", "", "{}").Code)
		assert.Equal(t, 400, piknoLLMTestCall(router, token, "GET", "/assistant/v2/files/raw-provider-id", "", "").Code)
		assert.Equal(t, 400, piknoLLMTestCall(router, token, "GET", "/assistant/v2/files/hf1_"+strings.Repeat("a", 80)+"?list=1", "", "").Code)
		require.NoError(t, model.DB.Model(token).Update("group", "image-standard").Error)
		assert.Equal(t, 403, piknoLLMTestCall(router, token, "GET", "/assistant/v2/files/hf1_"+strings.Repeat("a", 80), "", "").Code)
		require.NoError(t, model.DB.Model(token).Updates(map[string]any{"group": model.PiknoLLMGroup, "status": common.TokenStatusDisabled}).Error)
		assert.NotEqual(t, 200, piknoLLMTestCall(router, token, "GET", "/assistant/v2/files/hf1_"+strings.Repeat("a", 80), "", "").Code)
	})
	t.Run("media body is strict and leaves text and billing modifiers unchanged", func(t *testing.T) {
		gin.SetMode(gin.TestMode)
		t.Setenv("PIKNO_LLM_FILES_ENABLED", "true")
		handle := "hf1_" + strings.Repeat("b", 80)
		parse := func(input string) error {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/", strings.NewReader(`{"model":"pikno-chat-standard","input":`+input+`,"max_output_tokens":10}`))
			c.Request.Header.Set("Content-Type", "application/json")
			_, _, _, err := piknoLLMBody(c, piknoLLMConfig{true, true, 100})
			return err
		}
		for _, kind := range []string{"input_image", "input_video", "input_file"} {
			require.NoError(t, parse(`[{"role":"user","content":[{"type":"`+kind+`","file_id":"`+handle+`"}]}]`))
		}
		for _, input := range []string{
			`[{"role":"user","content":[{"type":"input_audio","file_id":"` + handle + `"}]}]`,
			`[{"role":"assistant","content":[{"type":"input_image","file_id":"` + handle + `"}]}]`,
			`[{"role":"user","content":[{"type":"input_image","image_url":"https://private.test/file"}]}]`,
			`[{"role":"user","content":[{"type":"input_image","file_id":"raw-provider-id"}]}]`,
			`[{"role":"user","content":[{"type":"input_image","file_id":"` + handle + `","detail":"high"}]}]`,
		} {
			require.Error(t, parse(input))
		}
		t.Setenv("PIKNO_LLM_FILES_ENABLED", "")
		require.Error(t, parse(`[{"role":"user","content":[{"type":"input_image","file_id":"`+handle+`"}]}]`))
		require.NoError(t, parse(`"text unchanged"`))
	})
}

// Opt-in isolated bridge: synthetic users, SQLite and a mock workerd provider.
// The fixed production target is intercepted; no request can reach a provider.
func TestPiknoLLMMediaIntegrationBridge(t *testing.T) {
	address := os.Getenv("HAMSTER_MEDIA_TEST_BRIDGE")
	if address == "" {
		t.Skip("isolated bridge is not running")
	}
	bridge, err := url.Parse(address)
	require.NoError(t, err)
	require.Equal(t, "http", bridge.Scheme)
	require.Equal(t, "host.docker.internal", bridge.Hostname())
	user, token, router := setupPiknoLLMTest(t)
	t.Setenv("PIKNO_LLM_FILES_ENABLED", "true")
	require.NoError(t, model.DB.Model(token).Update("key", strings.Repeat("m", 48)).Error)
	router.POST("/assistant/v2/files", middleware.TokenAuth(), PiknoLLMFiles)
	router.GET("/assistant/v2/files/:file", middleware.TokenAuthReadOnly(), PiknoLLMFiles)
	router.DELETE("/assistant/v2/files/:file", middleware.TokenAuthReadOnly(), PiknoLLMFiles)
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	piknoLLMTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Scheme != "https" || req.URL.Host != "inference.hamsterai.cc" || !strings.HasPrefix(req.URL.Path, "/internal/pikno/") {
			return nil, errors.New("unexpected test upstream")
		}
		copy := req.Clone(req.Context())
		copy.URL.Scheme = bridge.Scheme
		copy.URL.Host = bridge.Host
		copy.Host = bridge.Host
		return transport.RoundTrip(copy)
	})
	stop := make(chan struct{}, 1)
	router.GET("/__qa/state", func(c *gin.Context) {
		var fresh model.User
		require.NoError(t, model.DB.First(&fresh, user.Id).Error)
		var rows []model.PiknoLLMRequest
		require.NoError(t, model.DB.Find(&rows).Error)
		states := make([]any, len(rows))
		for i, row := range rows {
			states[i] = row.CustomerView()
		}
		c.JSON(200, gin.H{"quota": fresh.Quota, "requests": states})
	})
	router.POST("/__qa/stop", func(c *gin.Context) {
		select {
		case stop <- struct{}{}:
		default:
		}
		c.Status(204)
	})
	listener, err := net.Listen("tcp", ":8080")
	require.NoError(t, err)
	server := &http.Server{Handler: router, ReadHeaderTimeout: 10 * time.Second}
	go server.Serve(listener)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	})
	select {
	case <-stop:
	case <-time.After(150 * time.Second):
		t.Fatal("isolated client did not complete")
	}
}
