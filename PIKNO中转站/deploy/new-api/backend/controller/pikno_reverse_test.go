package controller

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// These fixtures use synthetic users, isolated databases and an in-process
// transport. No provider API, object store or production ledger is contacted.
func setupPiknoReverseTest(t *testing.T) (*model.User, *model.Token, *gin.Engine) {
	t.Helper()
	user, token, _ := setupPiknoLLMTest(t)
	require.NoError(t, model.DB.Model(user).Update("quota", 50_000_000).Error)
	require.NoError(t, model.DB.Model(token).Updates(map[string]any{"group": "tool-standard", "remain_quota": 50_000_000}).Error)
	require.NoError(t, model.DB.First(user, user.Id).Error)
	require.NoError(t, model.DB.First(token, token.Id).Error)
	require.NoError(t, model.MigratePiknoReverse(model.DB))
	require.NoError(t, model.MigratePiknoReverse(model.DB))
	t.Setenv("PIKNO_REVERSE_ENABLED", "true")
	t.Setenv("PIKNO_REVERSE_API_KEY", "synthetic-reverse-enterprise-key")
	t.Setenv("PIKNO_REVERSE_BILLING_MODE", "actual_seconds_v1")
	old := piknoReverseTransport
	t.Cleanup(func() { piknoReverseTransport = old })
	piknoReverseTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("unexpected provider dispatch")
		return nil, errors.New("unexpected provider dispatch")
	})
	router := gin.New()
	router.Use(PiknoStorefrontGuard)
	read := router.Group("/v1/reverse", middleware.TokenAuthReadOnly())
	read.GET("/capabilities", PiknoReverseCapabilities)
	read.GET("/quote", PiknoReverseQuote)
	read.GET("/tasks/:id", PiknoReverseTask)
	read.GET("/operations/:operation_id", PiknoReverseOperation)
	write := router.Group("/v1/reverse", middleware.TokenAuth())
	write.POST("/uploads", PiknoReverseUpload)
	write.POST("/tasks", PiknoReverseSubmit)
	return user, token, router
}

func piknoReverseTestCall(router *gin.Engine, token *model.Token, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/v1/reverse"+path, strings.NewReader(body))
	if token != nil {
		req.Header.Set("Authorization", "Bearer sk-"+token.Key)
	}
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func piknoReverseTestJSON(t *testing.T, w *httptest.ResponseRecorder, status int) map[string]any {
	t.Helper()
	require.Equal(t, status, w.Code, w.Body.String())
	var body map[string]any
	require.NoError(t, common.Unmarshal(w.Body.Bytes(), &body))
	return body
}

func piknoReverseTestReply(status int, body string) (*http.Response, error) {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
}

func piknoReverseTestUpload(t *testing.T, router *gin.Engine, token *model.Token, operation string) string {
	t.Helper()
	body := fmt.Sprintf(`{"filename":"synthetic.mp4","size_bytes":1024,"content_type":"video/mp4","duration_seconds":12.5,"operation_id":%q}`, operation)
	result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/uploads", body), 201)
	require.IsType(t, "", result["upload_id"])
	return result["upload_id"].(string)
}

func piknoReverseTestTaskBody(uploadID, operation string) string {
	return fmt.Sprintf(`{"upload_id":%q,"operation_id":%q,"options":{"videoType":"general","targetModel":"allRef","taskDurationSec":15},"price_version":"reverse-cny-003-v1","billing_confirmed":true}`, uploadID, operation)
}

func piknoReverseTestLinkBody(link, operation string) string {
	return fmt.Sprintf(`{"url":%q,"operation_id":%q,"options":{"videoType":"general","targetModel":"allRef","taskDurationSec":15},"price_version":"reverse-cny-003-v1","billing_confirmed":true}`, link, operation)
}

func piknoReverseTestBalances(t *testing.T, user *model.User, token *model.Token, expected int) {
	t.Helper()
	var gotUser model.User
	var gotToken model.Token
	require.NoError(t, model.DB.Select("id", "quota").First(&gotUser, user.Id).Error)
	require.NoError(t, model.DB.Select("id", "remain_quota").First(&gotToken, token.Id).Error)
	assert.Equal(t, expected, gotUser.Quota)
	assert.Equal(t, expected, gotToken.RemainQuota)
}

func TestPiknoReverse(t *testing.T) {
	t.Run("capabilities advertise source modes without contacting provider", func(t *testing.T) {
		_, token, router := setupPiknoReverseTest(t)
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/capabilities", ""), 200)
		assert.Equal(t, []any{"file", "link"}, result["input_modes"])
		assert.Equal(t, []any{"douyin", "xiaohongshu", "bilibili"}, result["supported_platforms"])
	})

	t.Run("source link whitelist permits only exact platform video pages and short links", func(t *testing.T) {
		for index, link := range []string{
			"https://www.douyin.com/video/1234567890123456789", "https://douyin.com:443/video/1234567890/",
			"https://v.douyin.com/Synthetic_123-/", "https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic%2Btoken%3D&xsec_source=pc_share",
			"https://xiaohongshu.com/discovery/item/0123456789ABCDEF01234567/", "https://xhslink.com/Synthetic123",
			"https://xhslink.com/a/Synthetic123/", "https://xhslink.com/o/Synthetic123?app_platform=android",
			"https://www.bilibili.com/video/BV1Synthetic123/?p=2", "https://bilibili.com/video/av123456789",
			"https://b23.tv/Synthetic123/", "https://WWW.BILIBILI.COM/video/BV1Synthetic123/",
		} {
			assert.True(t, piknoReverseSupportedLink(link), "valid synthetic platform form %d", index)
		}
		for index, link := range []string{
			"", "http://www.douyin.com/video/123", "https://www.douyin.com:444/video/123", "https://www.douyin.com:0443/video/123",
			"https://www.douyin.com:/video/123", "https://synthetic@www.douyin.com/video/123", "https://www.douyin.com/video/123#fragment",
			"https://www.douyin.com/video/123#", "https://www.douyin.com.evil.example/video/123", "https://evil.example/?url=https://www.douyin.com/video/123",
			"https://cdn.douyin.com/video/123", "https://www.douyin.com./video/123", "https://127.0.0.1/video/123", "https://[::1]/video/123",
			"https://storage.example.com/synthetic.mp4", "https://b23.tv/", "https://xhslink.com/", "https://www.bilibili.com/",
			"https://www.douyin.com/user/123", "https://www.xiaohongshu.com/explore/not-a-note", "https://www.bilibili.com/video/not-a-video",
			"https://www.douyin.com/video/123/synthetic.mp4", "https://xhslink.com/a/token/extra", "https://b23.tv/../Synthetic123",
			"https://www.douyin.com/%76ideo/123", "https://www.douyin.com/video%2f123", "https://www.douyin.com/video/%31%32%33",
			"https://www.douyin.com/video/123%2F..%2F456", "https://www.douyin.com/video/123\\@evil.example", "https://www.douyin.com/video/123\n",
			" https://www.douyin.com/video/123", "https://b23.tv/token\u200b", "https://b23.tv/Synthetic123 https://b23.tv/Synthetic456",
			"https://b23.tv/Synthetic123?next=https://evil.example/", "https://b23.tv/Synthetic123?next=https%3A%2F%2Fevil.example%2F",
			"https://b23.tv/Synthetic123?next=https%253A%252F%252Fevil.example%252F", "https://b23.tv/Synthetic123?bad=%00",
			"https://b23.tv/Synthetic123?next=https%2525253A%2525252F%2525252Fevil.example%2525252F", "https://b23.tv/Synthetic123?bad=%25252500",
			"https://b23.tv/Synthetic123?bad=%GG", "https://b23.tv/Synthetic123?bad=%FF", "https://b23.tv/Synthetic123?bad=%09", "https://b23.tv/" + strings.Repeat("a", 129), "https://b23.tv/Synthetic123?query=" + strings.Repeat("a", 4096),
		} {
			assert.False(t, piknoReverseSupportedLink(link), "invalid synthetic platform form %d", index)
		}
	})

	t.Run("link submission bypasses uploads and binds one reservation to operation", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		link := "https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic%2Btoken%3D"
		var submits atomic.Int32
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			require.Equal(t, "https://promptvv.com/api/v1/analyze", req.URL.String())
			require.Equal(t, "POST", req.Method)
			submits.Add(1)
			var body map[string]any
			require.NoError(t, common.DecodeJson(req.Body, &body))
			assert.Equal(t, link, body["url"], "preserve signed query verbatim")
			assert.NotContains(t, body, "upload_key")
			assert.NotContains(t, body, "upload_id")
			assert.Equal(t, "flagship", body["dims"].(map[string]any)["model"])
			id := body["client_reference_id"].(string)
			assert.Equal(t, "pikno-reverse-task-"+id, req.Header.Get("Idempotency-Key"))
			stored, err := model.GetPiknoReverseResource(user.Id, id, "task")
			require.NoError(t, err, "claim must commit before dispatch")
			assert.Empty(t, stored.UploadID)
			assert.Equal(t, "unknown", stored.State)
			piknoReverseTestBalances(t, user, token, 50_000_000-int(submits.Load())*18_000_000)
			return piknoReverseTestReply(202, fmt.Sprintf(`{"id":"synthetic-provider-link-%d","status":"queued"}`, submits.Load()))
		})
		body := piknoReverseTestLinkBody(link, "synthetic-link-operation-123")
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 202)
		assert.NotContains(t, fmt.Sprint(result), link)
		firstID := result["id"]
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 200)
		assert.Equal(t, firstID, result["id"])
		for _, changed := range []string{
			strings.Replace(body, "0123456789abcdef01234567", "0123456789abcdef01234568", 1),
			strings.Replace(body, `"videoType":"general"`, `"videoType":"short"`, 1),
		} {
			assert.Equal(t, 409, piknoReverseTestCall(router, token, "POST", "/tasks", changed).Code)
		}
		piknoReverseTestBalances(t, user, token, 32_000_000)
		assert.EqualValues(t, 1, submits.Load())
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", piknoReverseTestLinkBody(link, "synthetic-link-operation-456")), 202)
		assert.NotEqual(t, firstID, result["id"], "a separately confirmed new operation may analyze the same link")
		assert.EqualValues(t, 2, submits.Load())
		piknoReverseTestBalances(t, user, token, 14_000_000)
		var uploads int64
		require.NoError(t, model.DB.Model(&model.PiknoReverseOperation{}).Where("kind = ?", "upload").Count(&uploads).Error)
		assert.Zero(t, uploads)
	})

	t.Run("invalid or ambiguous link input never reserves or dispatches", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		body := piknoReverseTestLinkBody("https://www.douyin.com/video/123456789", "synthetic-link-operation-123")
		for _, invalid := range []string{
			strings.Replace(body, `"url":`, `"upload_id":"rvu_`+strings.Repeat("a", 32)+`","url":`, 1),
			strings.Replace(body, `"url":`, `"upload_id":null,"url":`, 1),
			strings.Replace(body, `"url":"https://www.douyin.com/video/123456789",`, "", 1),
			strings.Replace(body, `"url":"https://www.douyin.com/video/123456789"`, `"url":null`, 1),
			strings.Replace(body, `"url":"https://www.douyin.com/video/123456789"`, `"url":["https://b23.tv/Synthetic123"]`, 1),
			strings.Replace(body, `"url":"https://www.douyin.com/video/123456789"`, `"url":""`, 1),
			strings.Replace(body, "www.douyin.com", "www.douyin.com.evil.example", 1),
			strings.Replace(body, `"billing_confirmed":true`, `"billing_confirmed":false`, 1),
			strings.Replace(body, "reverse-cny-003-v1", "stale-price", 1),
		} {
			assert.Contains(t, []int{400, 409}, piknoReverseTestCall(router, token, "POST", "/tasks", invalid).Code)
		}
		piknoReverseTestBalances(t, user, token, 50_000_000)
		var claims int64
		require.NoError(t, model.DB.Model(&model.PiknoReverseOperation{}).Count(&claims).Error)
		assert.Zero(t, claims)
	})

	t.Run("unknown link recovers original provider job and settles exact seconds", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		var submits atomic.Int32
		var ref string
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			switch req.URL.Path {
			case "/api/v1/analyze":
				submits.Add(1)
				var body map[string]any
				require.NoError(t, common.DecodeJson(req.Body, &body))
				ref = body["client_reference_id"].(string)
				return nil, errors.New("synthetic ambiguous dispatch")
			case "/api/v1/jobs":
				assert.Equal(t, ref, req.URL.Query().Get("client_reference_id"))
				return piknoReverseTestReply(200, fmt.Sprintf(`{"items":[{"id":"synthetic-link-job","client_reference_id":%q}],"has_more":false}`, ref))
			case "/api/v1/jobs/synthetic-link-job":
				return piknoReverseTestReply(200, `{"id":"synthetic-link-job","status":"done","result":{"text":"Synthetic link result"},"charged_seconds":12.5}`)
			default:
				t.Error("unexpected route: link must not use upload or source-media network")
				return nil, errors.New("unexpected")
			}
		})
		body := piknoReverseTestLinkBody("https://b23.tv/Synthetic123", "synthetic-link-operation-123")
		assert.Equal(t, 502, piknoReverseTestCall(router, token, "POST", "/tasks", body).Code)
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 200)
		assert.Equal(t, "unknown", result["status"])
		assert.EqualValues(t, 1, submits.Load())
		piknoReverseTestBalances(t, user, token, 32_000_000)
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/operations/synthetic-link-operation-123", ""), 200)
		assert.Equal(t, "done", result["status"])
		assert.Equal(t, "settled", result["billing"].(map[string]any)["status"])
		assert.Equal(t, "0.375", result["billing"].(map[string]any)["charged_cny"])
		piknoReverseTestBalances(t, user, token, 49_625_000)
		assert.EqualValues(t, 1, submits.Load())
	})

	t.Run("global storefront guard permits only the reverse contract", func(t *testing.T) {
		router := gin.New()
		router.Use(PiknoStorefrontGuard)
		router.NoRoute(func(c *gin.Context) { c.Status(http.StatusNoContent) })
		for _, request := range []struct {
			method, path string
			allowed      bool
		}{
			{"GET", "/capabilities", true}, {"GET", "/quote", true},
			{"GET", "/tasks/rvt_" + strings.Repeat("a", 32), true},
			{"GET", "/operations/synthetic-operation-123", true},
			{"POST", "/uploads", true}, {"POST", "/tasks", true},
			{"GET", "/uploads", false}, {"POST", "/quote", false},
			{"POST", "/capabilities", false}, {"DELETE", "/tasks/rvt_" + strings.Repeat("a", 32), false},
			{"GET", "/tasks/not-a-task", false}, {"GET", "/tasks/rvu_" + strings.Repeat("a", 32), false},
			{"GET", "/tasks/rvt_" + strings.Repeat("a", 32) + "/extra", false},
			{"GET", "/operations/short", false}, {"GET", "/operations/synthetic-operation-123/extra", false},
			{"GET", "/arbitrary", false}, {"POST", "/arbitrary", false},
		} {
			response := piknoReverseTestCall(router, nil, request.method, request.path, "{}")
			want := http.StatusNotFound
			if request.allowed {
				want = http.StatusNoContent
			}
			assert.Equal(t, want, response.Code, "%s %s", request.method, request.path)
		}
	})

	t.Run("disabled configuration is read-only and never calls upstream", func(t *testing.T) {
		_, token, router := setupPiknoReverseTest(t)
		quote := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/quote", ""), 200)
		assert.Equal(t, "reverse-cny-003-v1", quote["price_version"])
		assert.Equal(t, "0.03", quote["unit_price_cny"])
		assert.Equal(t, "18.00", quote["reservation_cny"])
		assert.Equal(t, true, quote["confirmation_required"])
		for _, config := range []struct{ name, value, reason string }{{"PIKNO_REVERSE_ENABLED", "false", "disabled"}, {"PIKNO_REVERSE_API_KEY", "", "provider_unconfigured"}, {"PIKNO_REVERSE_BILLING_MODE", "", "billing_unconfigured"}} {
			t.Run(config.reason, func(t *testing.T) {
				t.Setenv(config.name, config.value)
				body := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/capabilities", ""), 200)
				assert.Equal(t, false, body["available"])
				assert.Equal(t, config.reason, body["reason_code"])
				assert.NotContains(t, fmt.Sprint(body), "synthetic-reverse-enterprise-key")
				assert.Equal(t, 503, piknoReverseTestCall(router, token, "POST", "/uploads", `{}`).Code)
			})
		}
	})

	t.Run("API authentication and live restrictions guard read and write", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		assert.Equal(t, 401, piknoReverseTestCall(router, nil, "GET", "/capabilities", "").Code)
		assert.Equal(t, 401, piknoReverseTestCall(router, nil, "POST", "/uploads", `{}`).Code)
		cases := []struct {
			name  string
			patch map[string]any
		}{
			{"disabled", map[string]any{"status": common.TokenStatusDisabled}},
			{"expired", map[string]any{"expired_time": time.Now().Unix() - 1}},
			{"wrong group", map[string]any{"group": "video-standard"}},
			{"IP restriction", map[string]any{"allow_ips": "10.0.0.1"}},
			{"model restriction", map[string]any{"model_limits_enabled": true, "model_limits": "another-model"}},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				require.NoError(t, model.DB.Model(token).Updates(tc.patch).Error)
				for _, request := range []struct{ method, path, body string }{{"GET", "/capabilities", ""}, {"GET", "/operations/synthetic-operation-123", ""}, {"POST", "/uploads", `{}`}} {
					code := piknoReverseTestCall(router, token, request.method, request.path, request.body).Code
					assert.Contains(t, []int{401, 403}, code)
				}
				require.NoError(t, model.DB.Model(token).Updates(map[string]any{"status": common.TokenStatusEnabled, "expired_time": -1, "group": "tool-standard", "allow_ips": "", "model_limits_enabled": false, "model_limits": ""}).Error)
			})
		}
		require.NoError(t, model.DB.Model(user).Update("status", common.UserStatusDisabled).Error)
		assert.Contains(t, []int{401, 403}, piknoReverseTestCall(router, token, "GET", "/capabilities", "").Code)
	})

	t.Run("upload validates metadata and returns only temporary PUT credentials", func(t *testing.T) {
		_, token, router := setupPiknoReverseTest(t)
		var calls atomic.Int32
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			calls.Add(1)
			assert.Equal(t, "https://promptvv.com/api/v1/uploads", req.URL.String())
			assert.Equal(t, "POST", req.Method)
			assert.Equal(t, "Bearer synthetic-reverse-enterprise-key", req.Header.Get("Authorization"))
			assert.NotEmpty(t, req.Header.Get("Idempotency-Key"))
			return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4?signature=synthetic","method":"PUT","expires_in":1800,"max_bytes":524288000}`)
		})
		for _, body := range []string{
			`{"filename":"synthetic.mp4","size_bytes":524288001,"operation_id":"synthetic-upload-123"}`,
			`{"filename":"synthetic.mp4","size_bytes":1024,"duration_seconds":600.01,"operation_id":"synthetic-upload-123"}`,
			`{"filename":"synthetic.exe","size_bytes":1024,"operation_id":"synthetic-upload-123"}`,
			`{"filename":"../synthetic.mp4","size_bytes":1024,"operation_id":"synthetic-upload-123"}`,
			`{"filename":"synthetic.mp4","size_bytes":1024,"url":"https://internal.example/","operation_id":"synthetic-upload-123"}`,
			`{"filename":"synthetic.mp4","size_bytes":-1,"operation_id":"synthetic-upload-123"}`,
		} {
			assert.Equal(t, 400, piknoReverseTestCall(router, token, "POST", "/uploads", body).Code)
		}
		assert.Zero(t, calls.Load())
		uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
		body := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/operations/synthetic-upload-123", ""), 200)
		assert.Equal(t, uploadID, body["upload_id"])
		assert.Equal(t, "PUT", body["method"])
		assert.Contains(t, body["upload_url"], "uploads.promptvv.example")
		assert.NotContains(t, fmt.Sprint(body), "synthetic-provider-upload-key")
		assert.NotContains(t, fmt.Sprint(body), "synthetic-reverse-enterprise-key")
		replay := `{"filename":"synthetic.mp4","size_bytes":1024,"content_type":"video/mp4","duration_seconds":12.5,"operation_id":"synthetic-upload-123"}`
		assert.Equal(t, 200, piknoReverseTestCall(router, token, "POST", "/uploads", replay).Code)
		assert.EqualValues(t, 1, calls.Load(), "upload replay must not mint another upstream upload")
		assert.Equal(t, 409, piknoReverseTestCall(router, token, "POST", "/uploads", strings.Replace(replay, "1024", "2048", 1)).Code)
	})

	t.Run("prepayment is claimed once and fractional actual duration settles once", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		var submits, polls atomic.Int32
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			switch req.URL.Path {
			case "/api/v1/uploads":
				return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
			case "/api/v1/analyze":
				submits.Add(1)
				piknoReverseTestBalances(t, user, token, 32_000_000)
				var payload map[string]any
				require.NoError(t, common.DecodeJson(req.Body, &payload))
				assert.Equal(t, "synthetic-provider-upload-key", payload["upload_key"])
				assert.NotEmpty(t, payload["client_reference_id"])
				return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
			case "/api/v1/jobs/synthetic-provider-job-123":
				polls.Add(1)
				return piknoReverseTestReply(200, `{"id":"synthetic-provider-job-123","status":"done","result":{"text":"Synthetic reverse prompt"},"charged_seconds":12.5}`)
			default:
				t.Errorf("unexpected provider path %s", req.URL.Path)
				return nil, errors.New("unexpected path")
			}
		})
		uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
		body := piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 202)
		require.IsType(t, "", result["id"])
		taskID := result["id"].(string)
		// Release60 file requests must replay the same durable claim after this
		// update. Adding the optional URL must not alter their canonical digest.
		legacy := fmt.Sprintf(`{"upload_id":%q,"options":{"videoType":"general","targetModel":"allRef","taskDurationSec":15},"operation_id":"synthetic-submit-123","price_version":"reverse-cny-003-v1","billing_confirmed":true}`, uploadID)
		claim, err := model.GetPiknoReverseResource(user.Id, taskID, "task")
		require.NoError(t, err)
		assert.Equal(t, fmt.Sprintf("%x", sha256.Sum256([]byte(legacy))), claim.RequestSHA256)
		assert.NotContains(t, fmt.Sprint(result), "synthetic-provider-job-123")
		piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 200)
		assert.EqualValues(t, 1, submits.Load())
		assert.Equal(t, 409, piknoReverseTestCall(router, token, "POST", "/tasks", strings.Replace(body, "synthetic-submit-123", "synthetic-submit-456", 1)).Code)
		assert.Equal(t, 409, piknoReverseTestCall(router, token, "POST", "/tasks", strings.Replace(body, `"general"`, `"dance"`, 1)).Code)
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
		assert.Equal(t, "done", result["status"])
		assert.Equal(t, "Synthetic reverse prompt", result["result"].(map[string]any)["text"])
		piknoReverseTestBalances(t, user, token, 49_625_000)
		piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
		piknoReverseTestBalances(t, user, token, 49_625_000)
		assert.EqualValues(t, 1, polls.Load())
	})

	t.Run("concurrent repeats reserve and submit only once", func(t *testing.T) {
		for _, mode := range []string{"file", "link"} {
			t.Run(mode, func(t *testing.T) {
				user, token, router := setupPiknoReverseTest(t)
				var submits atomic.Int32
				piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
					if req.URL.Path == "/api/v1/uploads" {
						return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
					}
					submits.Add(1)
					return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
				})
				body := piknoReverseTestLinkBody("https://v.douyin.com/Synthetic123/", "synthetic-submit-123")
				if mode == "file" {
					uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
					body = piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")
				}
				responses := make(chan int, 2)
				for range 2 {
					go func() { responses <- piknoReverseTestCall(router, token, "POST", "/tasks", body).Code }()
				}
				codes := make([]int, 0, 2)
				for range 2 {
					select {
					case code := <-responses:
						codes = append(codes, code)
					case <-time.After(10 * time.Second):
						t.Fatal("concurrent synthetic submission did not finish")
					}
				}
				assert.ElementsMatch(t, []int{200, 202}, codes)
				assert.EqualValues(t, 1, submits.Load())
				piknoReverseTestBalances(t, user, token, 32_000_000)
			})
		}
	})

	t.Run("unknown submit never resends and exact reference recovers original job", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		var submits atomic.Int32
		var reference string
		listMode := 0
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			switch req.URL.Path {
			case "/api/v1/uploads":
				return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
			case "/api/v1/analyze":
				submits.Add(1)
				var payload map[string]any
				require.NoError(t, common.DecodeJson(req.Body, &payload))
				reference, _ = payload["client_reference_id"].(string)
				return nil, errors.New("synthetic ambiguous timeout")
			case "/api/v1/jobs":
				assert.Equal(t, reference, req.URL.Query().Get("client_reference_id"))
				if listMode == 0 {
					return piknoReverseTestReply(200, `{"items":[],"has_more":false}`)
				}
				if listMode == 1 {
					return piknoReverseTestReply(200, `{"items":[{"id":"synthetic-unrelated-job","client_reference_id":"someone-else"}],"has_more":false}`)
				}
				if listMode == 2 {
					return piknoReverseTestReply(200, fmt.Sprintf(`{"items":[{"id":"synthetic-recovered-job","client_reference_id":%q}],"has_more":true}`, reference))
				}
				if listMode == 3 {
					return piknoReverseTestReply(200, fmt.Sprintf(`{"items":[{"id":"synthetic-recovered-job","client_reference_id":%q},{"id":"synthetic-another-job","client_reference_id":%q}],"has_more":false}`, reference, reference))
				}
				return piknoReverseTestReply(200, fmt.Sprintf(`{"items":[{"id":"synthetic-recovered-job","client_reference_id":%q}],"has_more":false}`, reference))
			case "/api/v1/jobs/synthetic-recovered-job":
				return piknoReverseTestReply(200, `{"id":"synthetic-recovered-job","status":"done","result":{"text":"Recovered synthetic prompt"},"charged_seconds":12.5}`)
			default:
				t.Errorf("unexpected provider path %s", req.URL.Path)
				return nil, errors.New("unexpected path")
			}
		})
		uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
		body := piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")
		assert.Equal(t, 502, piknoReverseTestCall(router, token, "POST", "/tasks", body).Code)
		piknoReverseTestBalances(t, user, token, 32_000_000)
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 200)
		assert.Equal(t, "unknown", result["status"])
		assert.Equal(t, 409, piknoReverseTestCall(router, token, "POST", "/tasks", strings.Replace(body, "synthetic-submit-123", "synthetic-submit-456", 1)).Code)
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/operations/synthetic-submit-123", ""), 200)
		assert.Equal(t, "unknown", result["status"])
		for listMode = 1; listMode <= 3; listMode++ {
			result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/operations/synthetic-submit-123", ""), 200)
			assert.Equal(t, "unknown", result["status"], "unrelated, partial or ambiguous listings cannot recover a task")
			piknoReverseTestBalances(t, user, token, 32_000_000)
		}
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/operations/synthetic-submit-123", ""), 200)
		assert.Equal(t, "done", result["status"])
		assert.EqualValues(t, 1, submits.Load())
		piknoReverseTestBalances(t, user, token, 49_625_000)
	})

	t.Run("done without authoritative seconds stays pending until later detail", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		var polls atomic.Int32
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			switch req.URL.Path {
			case "/api/v1/uploads":
				return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
			case "/api/v1/analyze":
				return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
			default:
				if polls.Add(1) == 1 {
					return piknoReverseTestReply(200, `{"id":"synthetic-provider-job-123","status":"done","result":{"text":"Synthetic prompt awaiting usage"}}`)
				}
				return piknoReverseTestReply(200, `{"id":"synthetic-provider-job-123","status":"done","result":{"text":"Synthetic prompt awaiting usage"},"charged_seconds":12.5}`)
			}
		})
		uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")), 202)
		taskID := result["id"].(string)
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
		assert.Equal(t, "done", result["status"])
		assert.Equal(t, "pending", result["billing"].(map[string]any)["status"])
		piknoReverseTestBalances(t, user, token, 32_000_000)
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
		assert.Equal(t, "settled", result["billing"].(map[string]any)["status"])
		piknoReverseTestBalances(t, user, token, 49_625_000)
	})

	t.Run("invalid provider seconds never become a charge or refund", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		var rawSeconds string
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			switch req.URL.Path {
			case "/api/v1/uploads":
				return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
			case "/api/v1/analyze":
				return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
			default:
				return piknoReverseTestReply(200, fmt.Sprintf(`{"id":"synthetic-provider-job-123","status":"done","result":{"text":"Synthetic prompt"},"charged_seconds":%s}`, rawSeconds))
			}
		})
		uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")), 202)
		taskID := result["id"].(string)
		for _, rawSeconds = range []string{`"12.5"`, "null", "-1", "600.001", "1e999999"} {
			result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
			assert.Equal(t, "pending", result["billing"].(map[string]any)["status"])
			piknoReverseTestBalances(t, user, token, 32_000_000)
		}
	})

	t.Run("provider credential changes never query or settle the old account", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		var controls atomic.Int32
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			controls.Add(1)
			if req.URL.Path == "/api/v1/uploads" {
				return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
			}
			return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
		})
		uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
		body := piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 202)
		taskID := result["id"].(string)
		t.Setenv("PIKNO_REVERSE_API_KEY", "synthetic-other-provider-account-key")
		result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
		assert.Equal(t, "queued", result["status"])
		assert.Equal(t, 409, piknoReverseTestCall(router, token, "POST", "/tasks", strings.Replace(body, "synthetic-submit-123", "synthetic-submit-456", 1)).Code)
		assert.EqualValues(t, 2, controls.Load(), "old job must not be polled using a different provider account")
		piknoReverseTestBalances(t, user, token, 32_000_000)
	})

	t.Run("releasing an exact-balance reservation restores only automatic exhaustion", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		require.NoError(t, model.DB.Model(token).Update("remain_quota", 18_000_000).Error)
		var submits atomic.Int32
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			switch req.URL.Path {
			case "/api/v1/uploads":
				return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
			case "/api/v1/analyze":
				submits.Add(1)
				return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
			default:
				return piknoReverseTestReply(200, `{"id":"synthetic-provider-job-123","status":"error"}`)
			}
		})
		uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
		body := piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 202)
		taskID := result["id"].(string)
		assert.Equal(t, 401, piknoReverseTestCall(router, token, "POST", "/tasks", body).Code, "normal middleware observes a fully reserved token as exhausted")
		var persisted model.Token
		require.NoError(t, model.DB.First(&persisted, token.Id).Error)
		assert.Equal(t, common.TokenStatusExhausted, persisted.Status)
		assert.Zero(t, persisted.RemainQuota)
		piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
		require.NoError(t, model.DB.First(&persisted, token.Id).Error)
		assert.Equal(t, common.TokenStatusEnabled, persisted.Status)
		assert.Equal(t, 18_000_000, persisted.RemainQuota)
		uploadID = piknoReverseTestUpload(t, router, token, "synthetic-upload-456")
		piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", piknoReverseTestTaskBody(uploadID, "synthetic-submit-456")), 202)
		assert.EqualValues(t, 2, submits.Load())
		var persistedUser model.User
		require.NoError(t, model.DB.First(&persistedUser, user.Id).Error)
		assert.Equal(t, 32_000_000, persistedUser.Quota)
	})

	for _, revokedStatus := range []int{common.TokenStatusDisabled, common.TokenStatusExpired} {
		t.Run(fmt.Sprintf("refund does not reactivate revoked credential %d", revokedStatus), func(t *testing.T) {
			user, token, router := setupPiknoReverseTest(t)
			piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
				switch req.URL.Path {
				case "/api/v1/uploads":
					return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
				case "/api/v1/analyze":
					return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
				default:
					return piknoReverseTestReply(200, `{"id":"synthetic-provider-job-123","status":"error"}`)
				}
			})
			uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
			result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")), 202)
			require.NoError(t, model.DB.Model(token).Update("status", revokedStatus).Error)
			otherToken := &model.Token{UserId: user.Id, Key: "syntheticreverserecoverytoken", Status: common.TokenStatusEnabled, ExpiredTime: -1, Group: "tool-standard", RemainQuota: 50_000_000}
			require.NoError(t, model.DB.Create(otherToken).Error)
			piknoReverseTestJSON(t, piknoReverseTestCall(router, otherToken, "GET", "/tasks/"+result["id"].(string), ""), 200)
			var persisted model.Token
			require.NoError(t, model.DB.First(&persisted, token.Id).Error)
			assert.Equal(t, revokedStatus, persisted.Status)
			piknoReverseTestBalances(t, user, token, 50_000_000)
		})
	}

	for _, status := range []string{"error", "cancelled"} {
		t.Run("authoritative "+status+" releases reservation only once", func(t *testing.T) {
			user, token, router := setupPiknoReverseTest(t)
			var polls atomic.Int32
			piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
				switch req.URL.Path {
				case "/api/v1/uploads":
					return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
				case "/api/v1/analyze":
					return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
				default:
					polls.Add(1)
					return piknoReverseTestReply(200, fmt.Sprintf(`{"id":"synthetic-provider-job-123","status":%q,"charged_seconds":0,"error":{"message":"synthetic-private-provider-error"}}`, status))
				}
			})
			uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
			result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")), 202)
			taskID := result["id"].(string)
			piknoReverseTestBalances(t, user, token, 32_000_000)
			result = piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
			assert.Equal(t, status, result["status"])
			assert.Equal(t, "released", result["billing"].(map[string]any)["status"])
			assert.NotContains(t, fmt.Sprint(result), "synthetic-private-provider-error")
			piknoReverseTestBalances(t, user, token, 50_000_000)
			piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "GET", "/tasks/"+taskID, ""), 200)
			piknoReverseTestBalances(t, user, token, 50_000_000)
			assert.EqualValues(t, 1, polls.Load())
		})
	}

	t.Run("confirmation balance and ownership fail before provider submission", func(t *testing.T) {
		user, token, router := setupPiknoReverseTest(t)
		var submits atomic.Int32
		piknoReverseTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.Path == "/api/v1/uploads" {
				return piknoReverseTestReply(201, `{"upload_key":"synthetic-provider-upload-key","upload_url":"https://uploads.promptvv.example/synthetic.mp4","method":"PUT","expires_in":1800}`)
			}
			submits.Add(1)
			return piknoReverseTestReply(202, `{"id":"synthetic-provider-job-123","status":"queued"}`)
		})
		uploadID := piknoReverseTestUpload(t, router, token, "synthetic-upload-123")
		body := piknoReverseTestTaskBody(uploadID, "synthetic-submit-123")
		for _, invalid := range []string{
			strings.Replace(body, `"billing_confirmed":true`, `"billing_confirmed":false`, 1),
			strings.Replace(body, "reverse-cny-003-v1", "stale-price", 1),
			strings.Replace(body, `"videoType":"general"`, `"videoType":"general","url":"https://internal.example/"`, 1),
			strings.Replace(body, `"taskDurationSec":15`, `"taskDurationSec":301`, 1),
		} {
			assert.Contains(t, []int{400, 409, 428}, piknoReverseTestCall(router, token, "POST", "/tasks", invalid).Code)
		}
		piknoReverseTestBalances(t, user, token, 50_000_000)
		require.NoError(t, model.DB.Model(user).Update("quota", 17_999_999).Error)
		assert.Equal(t, 402, piknoReverseTestCall(router, token, "POST", "/tasks", body).Code)
		require.NoError(t, model.DB.Model(user).Update("quota", 50_000_000).Error)
		require.NoError(t, model.DB.Model(token).Update("remain_quota", 17_999_999).Error)
		assert.Equal(t, 402, piknoReverseTestCall(router, token, "POST", "/tasks", body).Code)
		require.NoError(t, model.DB.Model(token).Update("remain_quota", 50_000_000).Error)
		assert.Zero(t, submits.Load())
		result := piknoReverseTestJSON(t, piknoReverseTestCall(router, token, "POST", "/tasks", body), 202)
		taskID := result["id"].(string)
		other := &model.User{Id: user.Id + 10000, Username: "synthetic-reverse-other", AffCode: "reverseother", Status: common.UserStatusEnabled, Group: "default", Quota: 50_000_000, AuthVersion: 1}
		require.NoError(t, model.DB.Create(other).Error)
		otherToken := &model.Token{UserId: other.Id, Key: "syntheticreverseothertoken", Status: common.TokenStatusEnabled, ExpiredTime: -1, Group: "tool-standard", RemainQuota: 50_000_000}
		require.NoError(t, model.DB.Create(otherToken).Error)
		assert.Equal(t, 404, piknoReverseTestCall(router, otherToken, "GET", "/tasks/"+taskID, "").Code)
		assert.Equal(t, 404, piknoReverseTestCall(router, otherToken, "GET", "/operations/synthetic-submit-123", "").Code)
		assert.Equal(t, 404, piknoReverseTestCall(router, otherToken, "GET", "/operations/synthetic-upload-123", "").Code)
		assert.Equal(t, 409, piknoReverseTestCall(router, otherToken, "POST", "/tasks", body).Code)
		assert.EqualValues(t, 1, submits.Load())
	})

	t.Run("fresh and upgrade migrations preserve rows and unique claims", func(t *testing.T) {
		user, token, _ := setupPiknoLLMTest(t)
		require.False(t, model.DB.Migrator().HasTable(&model.PiknoReverseOperation{}))
		require.NoError(t, model.MigratePiknoReverse(model.DB))
		require.NoError(t, model.MigratePiknoReverse(model.DB))
		row := &model.PiknoReverseOperation{ID: "rvu_" + strings.Repeat("a", 32), UserID: user.Id, TokenID: token.Id, OperationID: "synthetic-migration-operation", ResourceKey: strings.Repeat("b", 64), Kind: "upload", RequestSHA256: strings.Repeat("c", 64), State: "unknown"}
		require.NoError(t, model.DB.Create(row).Error)
		require.NoError(t, model.MigratePiknoReverse(model.DB))
		require.NoError(t, model.MigratePiknoReverse(model.DB))
		stored, err := model.GetPiknoReverseOperation(user.Id, row.OperationID)
		require.NoError(t, err)
		assert.Equal(t, row.ID, stored.ID)
		assert.Equal(t, "unknown", stored.State)
		require.True(t, model.DB.Migrator().HasIndex(&model.PiknoReverseOperation{}, "pikno_reverse_owner_operation"))
		duplicate := *row
		duplicate.ID, duplicate.ResourceKey = "rvu_"+strings.Repeat("d", 32), strings.Repeat("e", 64)
		assert.Error(t, model.DB.Create(&duplicate).Error, "owner and operation must remain unique after repeated migrations")
		duplicate.OperationID, duplicate.ResourceKey = "synthetic-other-operation", row.ResourceKey
		assert.Error(t, model.DB.Create(&duplicate).Error, "one claimed resource cannot be submitted under another operation")
		var gotUser model.User
		var gotToken model.Token
		require.NoError(t, model.DB.First(&gotUser, user.Id).Error)
		require.NoError(t, model.DB.First(&gotToken, token.Id).Error)
		assert.Equal(t, user.Quota, gotUser.Quota)
		assert.Equal(t, token.RemainQuota, gotToken.RemainQuota)
		assert.Equal(t, token.Key, gotToken.Key)
	})
}
