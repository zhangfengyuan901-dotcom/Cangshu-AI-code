package controller

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// All upstream calls in this suite use an in-process RoundTripper. Its bodies,
// credentials and database rows are synthetic; no real provider is contacted.
func setupPiknoLLMTest(t *testing.T) (*model.User, *model.Token, *gin.Engine) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dialect := os.Getenv("TEST_SECURITY_DIALECT")
	if dialect != "" && dialect != "sqlite" {
		_, dsn := newAuditTestDatabase(t, dialect, os.Getenv("TEST_"+strings.ToUpper(dialect)+"_DSN"))
		t.Setenv("TEST_RESPONSES_SQL_DSN", dsn)
	} else {
		t.Setenv("TEST_RESPONSES_SQL_DSN", "")
	}
	t.Setenv("TEST_RESPONSES_LOG_SQL_DSN", "")
	oldRatio, oldUsable := ratio_setting.GroupRatio2JSONString(), setting.UserUsableGroups2JSONString()
	oldBatch := common.BatchUpdateEnabled
	common.BatchUpdateEnabled = false
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(oldRatio))
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(oldUsable))
		common.BatchUpdateEnabled = oldBatch
	})
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"chat-standard":1,"image-standard":1,"video-standard":1,"tool-standard":1}`))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"chat-standard":"Chat","image-standard":"Image","video-standard":"Video","tool-standard":"Tools"}`))
	user, token := setupResponsesWSRequestTest(t)
	if dialect != "" && dialect != "sqlite" {
		pool, err := model.DB.DB()
		require.NoError(t, err)
		pool.SetMaxOpenConns(4)
	}
	require.NoError(t, model.DB.Model(user).Update("quota", 10_000_000).Error)
	require.NoError(t, model.DB.Model(token).Updates(map[string]any{"group": model.PiknoLLMGroup, "remain_quota": 10_000_000}).Error)
	require.NoError(t, model.DB.First(user, user.Id).Error)
	require.NoError(t, model.DB.First(token, token.Id).Error)
	require.NoError(t, model.MigratePiknoLLM(model.DB))
	require.NoError(t, model.MigratePiknoLLM(model.DB))
	var version string
	query := "SELECT VERSION()"
	if dialect == "" || dialect == "sqlite" {
		query = "SELECT sqlite_version()"
	}
	require.NoError(t, model.DB.Raw(query).Scan(&version).Error)
	t.Logf("LLM database: %s %s", model.DB.Dialector.Name(), version)
	t.Setenv("PIKNO_LLM_ENABLED", "true")
	t.Setenv("PIKNO_LLM_BILLING_MODE", model.PiknoLLMBillingMode)
	t.Setenv("PIKNO_LLM_MODEL_VERIFIED", "true")
	t.Setenv("PIKNO_LLM_MAX_OUTPUT_TOKENS", "100")
	t.Setenv("PIKNO_ASSISTANT_BRIDGE_SECRET", strings.Repeat("synthetic-", 4))
	oldTransport := piknoLLMTransport
	t.Cleanup(func() { piknoLLMTransport = oldTransport })
	piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("unexpected network dispatch")
		return nil, errors.New("unexpected")
	})
	router := gin.New()
	g := router.Group("/assistant/v2")
	g.POST("/activate", middleware.TokenAuthReadOnly(), PiknoLLMActivate)
	g.POST("/responses", middleware.TokenAuth(), PiknoLLMResponses)
	router.POST("/v1/chat/completions", middleware.TokenAuth(), PiknoLLMArkChat, func(c *gin.Context) { c.Status(http.StatusNoContent) })
	router.GET("/v1/models", middleware.TokenAuth(), PiknoListPublishedModels)
	router.GET("/v1/models/:model", middleware.TokenAuth(), PiknoRetrievePublishedModel)
	router.GET("/v1beta/models", middleware.TokenAuth(), PiknoListPublishedModels)
	router.GET("/assistant/v2/requests/:id", middleware.TokenAuthReadOnly(), PiknoLLMRequestStatus)
	router.GET("/v1/client/context", middleware.TokenAuthReadOnly(), PiknoClientContextAuth, PiknoClientContext)
	router.POST("/v1/client/quote", middleware.TokenAuth(), PiknoPriceQuote)
	router.Any("/assistant/v1/activate", PiknoLLMLegacyClosed)
	router.Any("/assistant/api/v3/*operation", PiknoLLMLegacyClosed)
	return user, token, router
}

func piknoLLMTestCall(router *gin.Engine, token *model.Token, method, path, id, body string, price ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != nil {
		req.Header.Set("Authorization", "Bearer sk-"+token.Key)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-PIKNO-Request-Id", id)
	req.Header.Set("X-PIKNO-Price-Version", model.PiknoLLMPriceVersion)
	if len(price) > 0 {
		req.Header.Set("X-PIKNO-Price-Version", price[0])
	}
	req.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestPiknoLLMArkChannelSkipsGenericTests(t *testing.T) {
	t.Setenv("PIKNO_LLM_ARK_CHANNEL_ID", "7")
	ark := &model.Channel{Id: 7, Status: common.ChannelStatusEnabled}
	other := &model.Channel{Id: 8, Status: common.ChannelStatusEnabled}
	assert.Equal(t, []*model.Channel{other}, selectChannelsForAutomaticTest([]*model.Channel{ark, other}, ""))
	result := testChannel(nil, ark, 0, "", "", false)
	assert.ErrorContains(t, result.localErr, "专用结算入口")
}

func TestPiknoLLMArkChannel(t *testing.T) {
	user, token, router := setupPiknoLLMTest(t)
	const request = `{"model":"doubao-seed-2.1-pro","input":"fixture","max_output_tokens":10}`
	const streamRequest = `{"model":"doubao-seed-2.1-pro","input":"fixture","max_output_tokens":10,"stream":true}`
	const path = "/assistant/v2/responses"
	call := func(requestID, body string) *httptest.ResponseRecorder {
		return piknoLLMTestCall(router, token, http.MethodPost, path, requestID, body, model.PiknoLLMArkPriceVersion)
	}
	t.Setenv("PIKNO_LLM_ARK_CHANNEL_ID", "")
	t.Setenv("PIKNO_LLM_ARK_VERIFIED", "false")
	t.Setenv("PIKNO_LLM_ARK_MEDIA_VERIFIED", "false")
	assert.Equal(t, 503, call(strings.Repeat("a", 32), request).Code)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.PiknoLine{}))
	modelPath := "/v1/models/" + model.PiknoLLMArkModel
	assert.Equal(t, 404, piknoLLMTestCall(router, token, http.MethodGet, modelPath, "", "").Code)
	baseURL := piknoLLMArkOrigin
	mapping := fmt.Sprintf(`{%q:%q}`, model.PiknoLLMArkModel, piknoLLMArkEndpoint)
	channel := model.Channel{Type: constant.ChannelTypeVolcEngine, Status: common.ChannelStatusEnabled,
		Key: "synthetic-channel-key", BaseURL: &baseURL, Group: model.PiknoLLMGroup, Models: model.PiknoLLMArkModel, ModelMapping: &mapping}
	require.NoError(t, model.DB.Create(&channel).Error)
	t.Setenv("PIKNO_LLM_ARK_CHANNEL_ID", fmt.Sprint(channel.Id))
	t.Setenv("PIKNO_LLM_ARK_VERIFIED", "true")
	models := piknoLLMTestCall(router, token, http.MethodGet, "/v1/models", "", "")
	require.Equal(t, 200, models.Code)
	assert.Contains(t, models.Body.String(), model.PiknoLLMArkModel)
	assert.Equal(t, 200, piknoLLMTestCall(router, token, http.MethodGet, modelPath, "", "").Code)
	assert.NotContains(t, piknoLLMTestCall(router, token, http.MethodGet, "/v1beta/models", "", "").Body.String(), model.PiknoLLMArkModel)
	require.NoError(t, model.DB.Model(token).Updates(map[string]any{"model_limits": model.PiknoLLMModel, "model_limits_enabled": true}).Error)
	assert.Equal(t, 404, piknoLLMTestCall(router, token, http.MethodGet, modelPath, "", "").Code)
	require.NoError(t, model.DB.Model(token).Update("model_limits_enabled", false).Error)
	w := piknoLLMTestCall(router, token, http.MethodPost, "/assistant/v2/activate", "", "")
	require.Equal(t, 200, w.Code)
	assert.Contains(t, w.Body.String(), `"model":"pikno-chat-standard"`)
	assert.Contains(t, w.Body.String(), `"cached_input_cny_per_million":6`)
	assert.NotContains(t, w.Body.String(), channel.Key)
	assert.NotContains(t, w.Body.String(), piknoLLMArkEndpoint)

	t.Setenv("PIKNO_LLM_MODEL_VERIFIED", "false")
	w = piknoLLMTestCall(router, token, http.MethodPost, "/assistant/v2/activate", "", "")
	require.Equal(t, http.StatusOK, w.Code)
	var capability struct {
		Enabled bool `json:"enabled"`
		Models  []struct {
			Model     string `json:"model"`
			Available bool   `json:"available"`
		} `json:"models"`
	}
	require.NoError(t, common.Unmarshal(w.Body.Bytes(), &capability))
	assert.False(t, capability.Enabled)
	require.Len(t, capability.Models, 1)
	assert.Equal(t, model.PiknoLLMArkModel, capability.Models[0].Model)
	assert.True(t, capability.Models[0].Available)
	legacy := piknoLLMTestCall(router, token, http.MethodPost, path, strings.Repeat("9", 32), `{"model":"pikno-chat-standard","input":"fixture","max_output_tokens":10}`)
	assert.Equal(t, http.StatusServiceUnavailable, legacy.Code)
	assert.Contains(t, legacy.Body.String(), `"submission_state":"not_submitted"`)

	assert.Equal(t, 400, call(strings.Repeat("a", 32), strings.Replace(request, `"fixture"`, `[{"role":"user","content":[{"type":"input_video","video_url":"https://fixture.example.test/video"}]}]`, 1)).Code)
	assert.Equal(t, 400, call(strings.Repeat("a", 32), strings.Replace(request, `"doubao-seed-2.1-pro"`, `"pikno-chat-standard"`, 1)).Code)

	var calls int
	piknoLLMTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		assert.Equal(t, piknoLLMArkOrigin+"/api/v3/responses", req.URL.String())
		assert.Equal(t, "Bearer "+channel.Key, req.Header.Get("Authorization"))
		assert.Nil(t, req.GetBody)
		data, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		assert.Contains(t, string(data), `"model":"`+piknoLLMArkEndpoint+`"`)
		assert.Contains(t, string(data), `"store":false`)
		assert.Contains(t, string(data), `"service_tier":"default"`)
		response := fmt.Sprintf(`{"id":"raw-response-id","status":"completed","model":%q,"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":4}},"internal_metadata":%q}`, piknoLLMArkEndpoint, channel.Key)
		if req.Header.Get("Accept") == "text/event-stream" {
			response = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture\",\"raw\":\"synthetic-channel-key\"}\n\n" +
				"data: {\"type\":\"response.completed\",\"response\":" + response + "}\n\n"
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(response))}, nil
	})
	for index, body := range []string{request, streamRequest} {
		id := strings.Repeat(string(rune('a'+index)), 32)
		w = call(id, body)
		require.Equal(t, 200, w.Code, w.Body.String())
		assert.Contains(t, w.Body.String(), model.PiknoLLMArkModel)
		assert.NotContains(t, w.Body.String(), channel.Key)
		assert.NotContains(t, w.Body.String(), piknoLLMArkEndpoint)
		assert.NotContains(t, w.Body.String(), "raw-response-id")
		assert.NotContains(t, w.Body.String(), "internal_metadata")
		if index == 1 {
			assert.Contains(t, w.Body.String(), `"delta":"fixture"`)
			assert.Contains(t, w.Body.String(), "data: [DONE]")
		}
		assert.Equal(t, 409, call(id, body).Code)
		record, err := model.GetPiknoLLMRequest(user.Id, id)
		require.NoError(t, err)
		assert.Equal(t, "settled", record.State)
		assert.Equal(t, model.PiknoLLMArkModel, record.Model)
		assert.Equal(t, 954, record.ChargedQuota)
	}
	assert.Equal(t, 2, calls)
	t.Setenv("PIKNO_LLM_ARK_MEDIA_VERIFIED", "true")
	t.Setenv("PIKNO_MEDIA_ENABLED", "true")
	const mediaSecret = "fixture-media-signing-key-for-offline-tests"
	t.Setenv("PIKNO_MEDIA_TICKET_KEY", mediaSecret)
	readURL := func(uid int, mime string, id string, size int64) string {
		now := time.Now().Unix()
		ticket, err := piknoSignMedia(piknoMediaTicket{1, "pikno-relay-media", uid, id, "read", now, now + 600, mime, size}, mediaSecret)
		require.NoError(t, err)
		return "https://www.piknoai.com/media/v1/assets/" + id + "?ticket=" + ticket
	}
	video := readURL(user.Id, "video/mp4", strings.Repeat("1", 32), 50_000_000)
	image := readURL(user.Id, "image/png", strings.Repeat("2", 32), 10_000_000)
	foreign := readURL(user.Id+1, "video/mp4", strings.Repeat("3", 32), 4096)
	t.Run("multimodal Responses validates owned media and settles once", func(t *testing.T) {
		const fixturePNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a4sAAAAASUVORK5CYII="
		fixture, err := base64.StdEncoding.DecodeString(fixturePNG)
		require.NoError(t, err)
		inlineImage := "data:image/png;base64," + fixturePNG
		ownedImage := readURL(user.Id, "image/png", strings.Repeat("6", 32), int64(len(fixture)))
		body := fmt.Sprintf(`{"model":%q,"input":[{"role":"user","content":[{"type":"input_image","image_url":%q},{"type":"input_video","video_url":%q,"fps":1.25},{"type":"input_image","image_url":%q}]}],"max_output_tokens":10,"stream":true}`, model.PiknoLLMArkModel, ownedImage, video, ownedImage)
		largeImage := readURL(user.Id, "image/png", strings.Repeat("4", 32), 10_000_001)
		largeVideo := readURL(user.Id, "video/mp4", strings.Repeat("5", 32), 50_000_001)
		oldImageTransport := piknoLLMArkImageTransport
		t.Cleanup(func() { piknoLLMArkImageTransport = oldImageTransport })
		var imageReads int
		imageStatus := http.StatusServiceUnavailable
		piknoLLMArkImageTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			imageReads++
			assert.Equal(t, http.MethodGet, req.Method)
			assert.Equal(t, ownedImage, req.URL.String())
			assert.Empty(t, req.Header.Get("Authorization"))
			return &http.Response{StatusCode: imageStatus, Header: http.Header{"Content-Type": {"image/png"}},
				ContentLength: int64(len(fixture)), Body: io.NopCloser(strings.NewReader(string(fixture)))}, nil
		})
		var mediaCalls int
		piknoLLMTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			mediaCalls++
			assert.Equal(t, piknoLLMArkOrigin+"/api/v3/responses", req.URL.String())
			var request struct {
				Model string `json:"model"`
				Input []struct {
					Role    string           `json:"role"`
					Content []map[string]any `json:"content"`
				} `json:"input"`
			}
			require.NoError(t, common.DecodeJson(req.Body, &request))
			assert.Equal(t, piknoLLMArkEndpoint, request.Model)
			require.Len(t, request.Input, 1)
			assert.Equal(t, "user", request.Input[0].Role)
			assert.Equal(t, []map[string]any{
				{"type": "input_image", "image_url": inlineImage},
				{"type": "input_video", "video_url": video, "fps": 1.25},
				{"type": "input_image", "image_url": inlineImage},
			}, request.Input[0].Content)
			response := fmt.Sprintf("data: {\"type\":\"response.output_text.delta\",\"delta\":%q}\n\n", inlineImage+" "+video) +
				"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15,\"input_tokens_details\":{\"cached_tokens\":4}}}}\n\n"
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(response))}, nil
		})
		for index, rejection := range []struct {
			name, original, replacement string
		}{
			{"foreign video", video, foreign},
			{"image over size limit", ownedImage, largeImage},
			{"video over size limit", video, largeVideo},
		} {
			t.Run(rejection.name, func(t *testing.T) {
				id := fmt.Sprintf("%032x", index+1)
				w := call(id, strings.Replace(body, rejection.original, rejection.replacement, 1))
				assert.Equal(t, http.StatusBadRequest, w.Code)
				assert.Contains(t, w.Body.String(), `"submission_state":"not_submitted"`)
				_, err := model.GetPiknoLLMRequest(user.Id, id)
				assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
			})
		}
		assert.Zero(t, imageReads)
		assert.Zero(t, mediaCalls)

		var account model.User
		require.NoError(t, model.DB.Select("quota").First(&account, user.Id).Error)
		before := account.Quota
		failedID := strings.Repeat("e", 32)
		failed := call(failedID, body)
		assert.Equal(t, http.StatusServiceUnavailable, failed.Code)
		assert.Contains(t, failed.Body.String(), `"submission_state":"not_submitted"`)
		assert.Equal(t, 1, imageReads)
		assert.Zero(t, mediaCalls)
		failedRecord, err := model.GetPiknoLLMRequest(user.Id, failedID)
		require.NoError(t, err)
		assert.Equal(t, "released", failedRecord.State)
		assert.Zero(t, failedRecord.ChargedQuota)
		require.NoError(t, model.DB.Select("quota").First(&account, user.Id).Error)
		assert.Equal(t, before, account.Quota)

		imageStatus = http.StatusOK
		id := strings.Repeat("d", 32)
		w := call(id, body)
		require.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), "[附件]")
		assert.NotContains(t, w.Body.String(), inlineImage)
		assert.NotContains(t, w.Body.String(), video)
		assert.Equal(t, http.StatusConflict, call(id, body).Code)
		assert.Equal(t, 2, imageReads)
		assert.Equal(t, 1, mediaCalls)
		record, err := model.GetPiknoLLMRequest(user.Id, id)
		require.NoError(t, err)
		assert.Equal(t, "settled", record.State)
		assert.Equal(t, 954, record.ChargedQuota)
		require.NoError(t, model.DB.Select("quota").First(&account, user.Id).Error)
		assert.Equal(t, before-954, account.Quota)
	})
	chat := func(id, raw string) *httptest.ResponseRecorder {
		return piknoLLMTestCall(router, token, http.MethodPost, "/v1/chat/completions", id, raw, "")
	}
	chatRequest := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":%q}},{"type":"video_url","video_url":{"url":%q,"fps":1.25}}]}],"max_completion_tokens":10,"stream":true}`, model.PiknoLLMArkModel, image, video)
	assert.Equal(t, 204, chat("", `{"model":"other"}`).Code)
	assert.Equal(t, 400, chat("", strings.Replace(chatRequest, video, foreign, 1)).Code)
	assert.Equal(t, 400, chat("", strings.Replace(chatRequest, "1.25", "7", 1)).Code)
	assert.Equal(t, 400, chat("", strings.Replace(chatRequest, video, "https://fixture.test/movie", 1)).Code)
	piknoLLMTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		assert.Equal(t, piknoLLMArkOrigin+"/api/v3/chat/completions", req.URL.String())
		data, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		assert.Contains(t, string(data), `"fps":1.25`)
		assert.Contains(t, string(data), video)
		assert.Contains(t, string(data), image)
		assert.Contains(t, string(data), `"include_usage":true`)
		assert.Contains(t, string(data), `"max_tokens":10`)
		assert.NotContains(t, string(data), `"max_completion_tokens"`)
		response := "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"fixture\"},\"finish_reason\":\"stop\"}]}\n\n" +
			"data: {\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15,\"prompt_tokens_details\":{\"cached_tokens\":4}}}\n\n" +
			"data: [DONE]\n\n"
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(response))}, nil
	})
	w = chat("", chatRequest)
	require.Equal(t, 200, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), "data: [DONE]")
	assert.Contains(t, w.Body.String(), `"content":"fixture"`)
	assert.Contains(t, w.Body.String(), `"prompt_tokens":10`)
	chatID := w.Header().Get("X-PIKNO-Request-Id")
	assert.Regexp(t, piknoLLMID, chatID)
	assert.Equal(t, 409, chat(chatID, chatRequest).Code)
	chatRecord, err := model.GetPiknoLLMRequest(user.Id, chatID)
	require.NoError(t, err)
	assert.Equal(t, 954, chatRecord.ChargedQuota)
	assert.Equal(t, 3, calls)

	// A failed dispatched request cannot be released by a forged Worker receipt.
	piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 503, Header: http.Header{"X-Pikno-Submission-State": {"not_submitted"}}, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"llm_not_submitted","submission_state":"not_submitted"}}`))}, nil
	})
	id := strings.Repeat("c", 32)
	assert.Equal(t, 502, call(id, request).Code)
	record, err := model.GetPiknoLLMRequest(user.Id, id)
	require.NoError(t, err)
	assert.Equal(t, "unknown", record.State)
	assert.Equal(t, 409, call(id, request).Code)
	assert.Equal(t, 4, calls)
}

func TestPiknoLLM(t *testing.T) {
	t.Run("free activation distinguishes exhausted quota from revocation", func(t *testing.T) {
		user, token, router := setupPiknoLLMTest(t)
		require.NoError(t, model.DB.Model(token).Update("remain_quota", 0).Error)
		old := gin.New()
		old.POST("/normal", middleware.TokenAuth(), func(c *gin.Context) { c.Status(204) })
		assert.Equal(t, 401, piknoLLMTestCall(old, token, "POST", "/normal", "", "").Code, "normal TokenAuth rejects an exhausted key before the handler")
		w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
		require.Equal(t, 200, w.Code, w.Body.String())
		assert.Contains(t, w.Body.String(), `"authorized":true`)
		assert.Contains(t, w.Body.String(), `"balance_sufficient":false`)
		w = piknoLLMTestCall(router, token, "GET", "/v1/client/context", "", "")
		assert.Equal(t, 200, w.Code, w.Body.String())
		assert.Contains(t, w.Body.String(), `"group":"chat-standard"`)
		assert.Equal(t, 401, piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", strings.Repeat("7", 32), `{"model":"pikno-chat-standard","input":"test","max_output_tokens":10}`).Code)
		assert.Equal(t, 401, piknoLLMTestCall(router, token, "POST", "/v1/client/quote", "", `{}`).Code)
		require.NoError(t, model.DB.Model(token).Update("group", "image-standard").Error)
		assert.Equal(t, 401, piknoLLMTestCall(router, token, "GET", "/v1/client/context", "", "").Code, "media context retains full quota checks")
		require.NoError(t, model.DB.Model(token).Update("group", model.PiknoLLMGroup).Error)
		require.NoError(t, model.DB.Model(token).Updates(map[string]any{"remain_quota": 10_000_000, "status": common.TokenStatusEnabled}).Error)
		require.NoError(t, model.DB.Model(user).Update("quota", 1).Error)
		w = piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
		assert.Equal(t, 200, w.Code)
		assert.Contains(t, w.Body.String(), `"balance_sufficient":true`, "positive balance admits one request, not a guaranteed full answer budget")
		require.NoError(t, model.DB.Model(token).Update("allow_ips", "10.0.0.1").Error)
		assert.Equal(t, 403, piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "").Code)
		var count int64
		require.NoError(t, model.DB.Model(&model.PiknoLLMRequest{}).Count(&count).Error)
		assert.Zero(t, count)
	})
	t.Run("activation is free, live key scoped and closed by default", func(t *testing.T) {
		user, token, router := setupPiknoLLMTest(t)
		t.Setenv("PIKNO_LLM_MODEL_VERIFIED", "false")
		w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
		require.Equal(t, 200, w.Code)
		assert.Contains(t, w.Body.String(), `"authorized":true`)
		assert.Contains(t, w.Body.String(), `"enabled":false`)
		assert.NotContains(t, w.Body.String(), `"token"`)
		assert.NotContains(t, w.Body.String(), "synthetic-")
		var rows int64
		require.NoError(t, model.DB.Model(&model.PiknoLLMRequest{}).Count(&rows).Error)
		assert.Zero(t, rows)
		var fresh model.User
		require.NoError(t, model.DB.First(&fresh, user.Id).Error)
		assert.Equal(t, 10_000_000, fresh.Quota)
		for _, group := range []string{"image-standard", "video-standard", "tool-standard"} {
			require.NoError(t, model.DB.Model(token).Update("group", group).Error)
			w = piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
			assert.Equal(t, 403, w.Code, group)
		}
		require.NoError(t, model.DB.Model(token).Updates(map[string]any{"group": model.PiknoLLMGroup, "model_limits_enabled": true, "model_limits": "unrelated"}).Error)
		assert.Equal(t, 403, piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "").Code)
		assert.Equal(t, 401, piknoLLMTestCall(router, nil, "POST", "/assistant/v2/activate", "", "").Code)
		assert.Equal(t, 410, piknoLLMTestCall(router, token, "POST", "/assistant/v1/activate", "", "").Code)
		assert.Equal(t, 410, piknoLLMTestCall(router, token, "POST", "/assistant/api/v3/responses", "", "").Code)
	})
	t.Run("actual-usage opt-in is mandatory and advertises no estimated price cap", func(t *testing.T) {
		_, token, router := setupPiknoLLMTest(t)
		for _, mode := range []string{"", "paid", "prepaid", "wrong"} {
			t.Setenv("PIKNO_LLM_BILLING_MODE", mode)
			w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
			assert.Equal(t, 200, w.Code)
			assert.Contains(t, w.Body.String(), `"available":false`)
			assert.Equal(t, 503, piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", strings.Repeat("e", 32), `{"model":"pikno-chat-standard","input":"test","max_output_tokens":1}`).Code)
		}
		t.Setenv("PIKNO_LLM_BILLING_MODE", model.PiknoLLMBillingMode)
		w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
		assert.Contains(t, w.Body.String(), `"available":true`)
		assert.Contains(t, w.Body.String(), `"billing_mode":"actual_usage_v1"`)
		assert.Contains(t, w.Body.String(), `"allow_debt":true`)
		assert.Contains(t, w.Body.String(), `"one_inflight_per_user":true`)
		for _, obsolete := range []string{"max_request_quota", "worst_case_reserved_quota", "max_input_tokens", "input_token_bound"} {
			assert.NotContains(t, w.Body.String(), obsolete)
		}
		t.Setenv("PIKNO_LLM_MAX_OUTPUT_TOKENS", "65536")
		w = piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
		assert.Contains(t, w.Body.String(), `"available":true`)
		t.Setenv("PIKNO_LLM_MAX_OUTPUT_TOKENS", "65537")
		w = piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
		assert.Contains(t, w.Body.String(), `"available":false`, "activation cannot advertise an output limit rejected by the Worker")
	})
	t.Run("full usage can overdraw one accepted request but blocks all following paid requests", func(t *testing.T) {
		for _, tc := range []struct {
			name             string
			wallet, keyQuota int
			unlimited        bool
		}{
			{"both balances become debt", 1, 1, false},
			{"wallet becomes debt with unlimited key", 1, 1000, true},
			{"only limited key becomes debt", 1000, 1, false},
			{"exact zero also blocks", 180, 180, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				user, token, router := setupPiknoLLMTest(t)
				require.NoError(t, model.DB.Model(user).Update("quota", tc.wallet).Error)
				require.NoError(t, model.DB.Model(token).Updates(map[string]any{"remain_quota": tc.keyQuota, "unlimited_quota": tc.unlimited}).Error)
				id := strings.Repeat("4", 32)
				order, created, err := model.ReservePiknoLLM(user.Id, token.Id, id, strings.Repeat("a", 64), model.PiknoLLMPriceVersion, 10)
				require.NoError(t, err)
				require.True(t, created)
				assert.Zero(t, order.ReservedQuota)
				var before model.User
				require.NoError(t, model.DB.First(&before, user.Id).Error)
				assert.Equal(t, tc.wallet, before.Quota, "opening the durable slot does not pre-charge")
				require.NoError(t, model.DispatchPiknoLLM(user.Id, id))
				var wg sync.WaitGroup
				results := make(chan error, 2)
				for range 2 {
					wg.Go(func() {
						_, err := model.FinishPiknoLLM(user.Id, id, "usage", 10, 2, 4)
						results <- err
					})
				}
				wg.Wait()
				close(results)
				for err := range results {
					require.NoError(t, err)
				}
				order, err = model.GetPiknoLLMRequest(user.Id, id)
				require.NoError(t, err)
				assert.Equal(t, "settled", order.State)
				assert.Equal(t, 180, order.ChargedQuota)
				assert.Zero(t, order.RefundedQuota, "a debt is not a negative refund")
				var fresh model.User
				require.NoError(t, model.DB.First(&fresh, user.Id).Error)
				var freshToken model.Token
				require.NoError(t, model.DB.First(&freshToken, token.Id).Error)
				assert.Equal(t, tc.wallet-180, fresh.Quota)
				assert.Equal(t, 180, fresh.UsedQuota)
				assert.Equal(t, 1, fresh.RequestCount)
				assert.Equal(t, 180, freshToken.UsedQuota)
				wantKey := tc.keyQuota
				if !tc.unlimited {
					wantKey -= 180
				}
				assert.Equal(t, wantKey, freshToken.RemainQuota)
				_, _, err = model.ReservePiknoLLM(user.Id, token.Id, strings.Repeat("5", 32), strings.Repeat("b", 64), model.PiknoLLMPriceVersion, 10)
				require.Error(t, err)
				w := piknoLLMTestCall(router, token, "GET", "/assistant/v2/requests/"+id, "", "")
				assert.Equal(t, 200, w.Code, "debt does not remove access to the original receipt")
				w = piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
				assert.Contains(t, w.Body.String(), `"balance_sufficient":false`)
				require.NoError(t, model.DB.Model(user).Update("quota", 1000).Error)
				require.NoError(t, model.DB.Model(token).Updates(map[string]any{"remain_quota": 1000, "status": common.TokenStatusEnabled}).Error)
				_, created, err = model.ReservePiknoLLM(user.Id, token.Id, strings.Repeat("5", 32), strings.Repeat("b", 64), model.PiknoLLMPriceVersion, 10)
				require.NoError(t, err)
				assert.True(t, created, "positive restored balances admit a new request")
			})
		}
	})
	t.Run("dispatch rechecks live debt and key revocation after opening the slot", func(t *testing.T) {
		for _, revoke := range []bool{false, true} {
			t.Run(fmt.Sprint(revoke), func(t *testing.T) {
				user, token, _ := setupPiknoLLMTest(t)
				id := strings.Repeat("3", 32)
				_, _, err := model.ReservePiknoLLM(user.Id, token.Id, id, strings.Repeat("a", 64), model.PiknoLLMPriceVersion, 10)
				require.NoError(t, err)
				if revoke {
					require.NoError(t, model.DB.Model(token).Update("status", common.TokenStatusDisabled).Error)
				} else {
					require.NoError(t, model.DB.Model(user).Update("quota", -1).Error)
				}
				require.Error(t, model.DispatchPiknoLLM(user.Id, id))
				order, err := model.FinishPiknoLLM(user.Id, id, "not_submitted", 0, 0)
				require.NoError(t, err)
				assert.Equal(t, "released", order.State)
				assert.Zero(t, order.ChargedQuota)
				assert.Zero(t, order.RefundedQuota)
			})
		}
	})
	t.Run("live balance changes return payment-required without submitting upstream", func(t *testing.T) {
		for _, afterSlot := range []bool{false, true} {
			t.Run(fmt.Sprint(afterSlot), func(t *testing.T) {
				user, token, router := setupPiknoLLMTest(t)
				if afterSlot {
					// Simulate another account charge after admission but before
					// dispatch. No network, timing sleeps or actual provider calls.
					callback := "pikno_llm_test_balance_change"
					require.NoError(t, model.DB.Callback().Create().After("gorm:create").Register(callback, func(tx *gorm.DB) {
						if tx.Statement.Schema != nil && tx.Statement.Schema.Table == "pikno_llm_requests" && tx.Error == nil {
							tx.AddError(tx.Session(&gorm.Session{NewDB: true}).Model(&model.User{}).Where("id = ?", user.Id).Update("quota", 0).Error)
						}
					}))
					t.Cleanup(func() { require.NoError(t, model.DB.Callback().Create().Remove(callback)) })
				} else {
					require.NoError(t, model.DB.Model(user).Update("quota", 0).Error)
				}
				id := strings.Repeat("6", 32)
				w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":10}`)
				assert.Equal(t, http.StatusPaymentRequired, w.Code, w.Body.String())
				assert.Contains(t, w.Body.String(), `"code":"llm_insufficient_balance"`)
				assert.Contains(t, w.Body.String(), `"submission_state":"not_submitted"`)
				if afterSlot {
					order, err := model.GetPiknoLLMRequest(user.Id, id)
					require.NoError(t, err)
					assert.Equal(t, "released", order.State)
					assert.Zero(t, order.ChargedQuota)
				} else {
					_, err := model.GetPiknoLLMRequest(user.Id, id)
					require.ErrorIs(t, err, gorm.ErrRecordNotFound)
				}
			})
		}
	})
	t.Run("deleting a key after dispatch cannot erase its accepted usage debt", func(t *testing.T) {
		user, token, _ := setupPiknoLLMTest(t)
		id := strings.Repeat("2", 32)
		_, _, err := model.ReservePiknoLLM(user.Id, token.Id, id, strings.Repeat("a", 64), model.PiknoLLMPriceVersion, 10)
		require.NoError(t, err)
		require.NoError(t, model.DispatchPiknoLLM(user.Id, id))
		require.NoError(t, model.DB.Delete(token).Error)
		_, err = model.FinishPiknoLLM(user.Id, id, "usage", 10, 2)
		require.NoError(t, err)
		var freshToken model.Token
		require.NoError(t, model.DB.Unscoped().First(&freshToken, token.Id).Error)
		assert.Equal(t, 180, freshToken.UsedQuota)
		assert.Equal(t, 10_000_000-180, freshToken.RemainQuota)
		assert.True(t, freshToken.DeletedAt.Valid)
	})
	t.Run("one zero-value slot one signature one actual settlement and safe status", func(t *testing.T) {
		user, token, router := setupPiknoLLMTest(t)
		count := 0
		id := strings.Repeat("a", 32)
		piknoLLMTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			count++
			assert.Equal(t, "https://inference.hamsterai.cc/internal/pikno/responses", req.URL.String())
			raw, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			parts := strings.Split(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "), ".")
			require.Len(t, parts, 2)
			mac := hmac.New(sha256.New, []byte(os.Getenv("PIKNO_ASSISTANT_BRIDGE_SECRET")))
			mac.Write([]byte(parts[0]))
			sig, err := base64.RawURLEncoding.DecodeString(parts[1])
			require.NoError(t, err)
			assert.True(t, hmac.Equal(sig, mac.Sum(nil)))
			claimsRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
			require.NoError(t, err)
			var claims map[string]any
			require.NoError(t, common.Unmarshal(claimsRaw, &claims))
			hash := sha256.Sum256(raw)
			assert.Equal(t, hex.EncodeToString(hash[:]), claims["body_sha256"])
			assert.Equal(t, id, claims["jti"])
			assert.Equal(t, "pikno-llm-execute", claims["aud"])
			assert.Equal(t, float64(2), claims["v"])
			assert.Equal(t, "pikno-text-three-actual-usage-v2", claims["route_policy"])
			assert.Equal(t, model.PiknoLLMBillingMode, claims["billing_mode"])
			assert.NotContains(t, claims, "input_token_bound")
			assert.Equal(t, float64(user.Id), claims["uid"])
			order, err := model.GetPiknoLLMRequest(user.Id, id)
			require.NoError(t, err)
			assert.Equal(t, "dispatched", order.State)
			assert.Zero(t, order.ReservedQuota)
			assert.Equal(t, model.PiknoLLMBillingMode, order.BillingMode)
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"id":"ho1safe","model":"should-be-rewritten","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":4}}}`))}, nil
		})
		body := `{"model":"pikno-chat-standard","input":"synthetic hello","max_output_tokens":100}`
		w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, body)
		require.Equal(t, 200, w.Code, w.Body.String())
		assert.Contains(t, w.Body.String(), model.PiknoLLMModel)
		assert.NotContains(t, w.Body.String(), "should-be-rewritten")
		w = piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, body)
		assert.Equal(t, 409, w.Code)
		assert.Equal(t, 1, count)
		w = piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, strings.Replace(body, "hello", "changed", 1))
		assert.Equal(t, 409, w.Code)
		assert.Equal(t, 1, count)
		order, err := model.GetPiknoLLMRequest(user.Id, id)
		require.NoError(t, err)
		assert.Equal(t, "settled", order.State)
		assert.Equal(t, 180, order.ChargedQuota)
		assert.Zero(t, order.RefundedQuota)
		assert.Equal(t, 4, order.CachedTokens)
		assert.Equal(t, 6, order.ProviderInputRate)
		assert.Equal(t, 30, order.ProviderOutputRate)
		require.NotNil(t, order.EstimatedCostQuota)
		assert.Equal(t, 120, *order.EstimatedCostQuota)
		assert.Equal(t, "user_provided_unverified", order.CostStatus)
		assert.Equal(t, "nominal_no_cache_discount", order.CostEstimateRule)
		var fresh model.User
		require.NoError(t, model.DB.First(&fresh, user.Id).Error)
		assert.Equal(t, 10_000_000-180, fresh.Quota)
		assert.Equal(t, 180, fresh.UsedQuota)
		assert.Equal(t, 1, fresh.RequestCount)
		w = piknoLLMTestCall(router, token, "GET", "/assistant/v2/requests/"+id, "", "")
		assert.Equal(t, 200, w.Code)
		assert.Contains(t, w.Body.String(), `"status":"settled"`)
		assert.Contains(t, w.Body.String(), `"cached_tokens":4`)
		assert.NotContains(t, w.Body.String(), "body_sha256")
		for _, privateField := range []string{"provider_input_rate", "provider_output_rate", "estimated_cost_quota", "cost_status", "cost_estimate_rule"} {
			assert.NotContains(t, w.Body.String(), privateField)
		}
		_, err = model.FinishPiknoLLM(user.Id, id, "not_submitted", 0, 0)
		require.NoError(t, err)
		require.NoError(t, model.DB.First(&fresh, user.Id).Error)
		assert.Equal(t, 10_000_000-180, fresh.Quota)
		require.NoError(t, model.MigratePiknoLLM(model.DB))
		order, err = model.GetPiknoLLMRequest(user.Id, id)
		require.NoError(t, err)
		assert.Equal(t, 180, order.ChargedQuota)
	})
	t.Run("unknown retains reserve, blocks new request, never replays", func(t *testing.T) {
		user, token, router := setupPiknoLLMTest(t)
		count := 0
		piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
			count++
			return nil, errors.New("synthetic connection failure")
		})
		id := strings.Repeat("b", 32)
		body := `{"model":"pikno-chat-standard","input":"test","max_output_tokens":10}`
		w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, body)
		require.Equal(t, 502, w.Code)
		order, err := model.GetPiknoLLMRequest(user.Id, id)
		require.NoError(t, err)
		assert.Equal(t, "unknown", order.State)
		assert.Zero(t, order.RefundedQuota)
		assert.Equal(t, 409, piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, body).Code)
		assert.Equal(t, 409, piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", strings.Repeat("c", 32), body).Code)
		assert.Equal(t, 1, count)
		require.NoError(t, model.DB.Model(token).Updates(map[string]any{"remain_quota": 0, "status": common.TokenStatusExhausted}).Error)
		w = piknoLLMTestCall(router, token, "GET", "/assistant/v2/requests/"+id, "", "")
		assert.Equal(t, 200, w.Code)
		assert.Contains(t, w.Body.String(), `"usage":null`)
		require.NoError(t, model.DB.Model(token).Update("status", common.TokenStatusDisabled).Error)
		assert.Equal(t, 401, piknoLLMTestCall(router, token, "GET", "/assistant/v2/requests/"+id, "", "").Code)
	})
	t.Run("only authenticated worker not-submitted evidence releases", func(t *testing.T) {
		for _, proof := range []bool{false, true} {
			t.Run(fmt.Sprint(proof), func(t *testing.T) {
				user, token, router := setupPiknoLLMTest(t)
				piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
					h := http.Header{}
					if proof {
						h.Set("X-PIKNO-Submission-State", "not_submitted")
					}
					return &http.Response{StatusCode: 503, Header: h, Body: io.NopCloser(strings.NewReader(`{"error":{"code":"llm_not_submitted","submission_state":"not_submitted","message":"ep-private"}}`))}, nil
				})
				id := strings.Repeat("d", 32)
				w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":10}`)
				assert.Equal(t, 502, w.Code)
				assert.NotContains(t, w.Body.String(), "ep-private")
				order, err := model.GetPiknoLLMRequest(user.Id, id)
				require.NoError(t, err)
				if proof {
					assert.Equal(t, "released", order.State)
					assert.Equal(t, order.ReservedQuota, order.RefundedQuota)
				} else {
					assert.Equal(t, "unknown", order.State)
					assert.Zero(t, order.RefundedQuota)
				}
			})
		}
	})
	t.Run("safe failover rejection requires a complete distinct Worker receipt", func(t *testing.T) {
		proof := `{"error":{"code":"llm_rejected_before_execution","submission_state":"rejected_before_execution","message":"ep-private"}}`
		for _, tc := range []struct {
			name, execution, submission, body string
			status                            int
			released                          bool
		}{
			{"complete rejection", "rejected_before_execution", "", proof, 429, true},
			{"missing proof header", "", "", proof, 429, false},
			{"legacy header is not execution proof", "", "not_submitted", proof, 503, false},
			{"conflicting proof headers", "rejected_before_execution", "not_submitted", proof, 429, false},
			{"wrong proof code", "rejected_before_execution", "", strings.Replace(proof, "llm_rejected_before_execution", "llm_execution_unknown", 1), 429, false},
			{"wrong proof state", "rejected_before_execution", "", strings.Replace(proof, `"submission_state":"rejected_before_execution"`, `"submission_state":"unknown"`, 1), 429, false},
			{"truncated proof", "rejected_before_execution", "", proof[:len(proof)-1], 429, false},
			{"trailing response", "rejected_before_execution", "", proof + `{}`, 429, false},
			{"contradictory usage", "rejected_before_execution", "", strings.TrimSuffix(proof, "}") + `,"usage":{"input_tokens":1}}`, 429, false},
			{"nested contradictory usage", "rejected_before_execution", "", strings.Replace(proof, `"message":"ep-private"`, `"message":"ep-private","usage":{"input_tokens":1}`, 1), 429, false},
			{"nested contradictory output", "rejected_before_execution", "", strings.Replace(proof, `"message":"ep-private"`, `"message":"ep-private","output":[]`, 1), 429, false},
			{"duplicate error", "rejected_before_execution", "", strings.Replace(proof, `{"error":`, `{"error":{},"error":`, 1), 429, false},
			{"escaped error", "rejected_before_execution", "", strings.Replace(proof, `"error"`, `"\u0065rror"`, 1), 429, false},
			{"duplicate code", "rejected_before_execution", "", strings.Replace(proof, `"code":`, `"code":"wrong","code":`, 1), 429, false},
			{"escaped code", "rejected_before_execution", "", strings.Replace(proof, `"code"`, `"\u0063ode"`, 1), 429, false},
			{"duplicate state", "rejected_before_execution", "", strings.Replace(proof, `"submission_state":`, `"submission_state":"unknown","submission_state":`, 1), 429, false},
			{"escaped state", "rejected_before_execution", "", strings.Replace(proof, `"submission_state"`, `"\u0073ubmission_state"`, 1), 429, false},
			{"duplicate message", "rejected_before_execution", "", strings.Replace(proof, `"message":`, `"message":{},"message":`, 1), 429, false},
			{"escaped message", "rejected_before_execution", "", strings.Replace(proof, `"message"`, `"\u006dessage"`, 1), 429, false},
			{"object message", "rejected_before_execution", "", strings.Replace(proof, `"message":"ep-private"`, `"message":{"code":"opaque"}`, 1), 429, false},
			{"null message", "rejected_before_execution", "", strings.Replace(proof, `"message":"ep-private"`, `"message":null`, 1), 429, false},
			{"absent message", "rejected_before_execution", "", strings.Replace(proof, `,"message":"ep-private"`, "", 1), 429, true},
			{"quoted text is not a key", "rejected_before_execution", "", strings.Replace(proof, `"message":"ep-private"`, `"message":"text: \"usage\":{} and unicode \u4e2d"`, 1), 429, true},
			{"oversized proof", "rejected_before_execution", "", proof + strings.Repeat(" ", 4096), 429, false},
			{"2xx is never zero-execution proof", "rejected_before_execution", "", proof, 200, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				user, token, router := setupPiknoLLMTest(t)
				calls := 0
				piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
					calls++
					headers := http.Header{}
					if tc.execution != "" {
						headers.Set("X-PIKNO-Execution-State", tc.execution)
					}
					if tc.submission != "" {
						headers.Set("X-PIKNO-Submission-State", tc.submission)
					}
					return &http.Response{StatusCode: tc.status, Header: headers, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
				})
				id := strings.Repeat("8", 32)
				body := `{"model":"pikno-chat-standard","input":"test","max_output_tokens":10}`
				w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, body)
				assert.Equal(t, 502, w.Code)
				assert.NotContains(t, w.Body.String(), "ep-private")
				order, err := model.GetPiknoLLMRequest(user.Id, id)
				require.NoError(t, err)
				var fresh model.User
				require.NoError(t, model.DB.First(&fresh, user.Id).Error)
				var freshToken model.Token
				require.NoError(t, model.DB.First(&freshToken, token.Id).Error)
				if tc.released {
					assert.Equal(t, "released", order.State)
					assert.Equal(t, order.ReservedQuota, order.RefundedQuota)
					assert.Contains(t, w.Body.String(), `"code":"llm_rejected_before_execution"`)
					assert.Contains(t, w.Body.String(), `"submission_state":"rejected_before_execution"`)
					assert.Equal(t, 10_000_000, fresh.Quota)
					assert.Equal(t, 10_000_000, freshToken.RemainQuota)
				} else {
					assert.Equal(t, "unknown", order.State)
					assert.Zero(t, order.RefundedQuota)
					assert.Contains(t, w.Body.String(), `"submission_state":"unknown"`)
					assert.Equal(t, 10_000_000-order.ReservedQuota, fresh.Quota)
					assert.Equal(t, 10_000_000-order.ReservedQuota, freshToken.RemainQuota)
				}
				assert.Zero(t, order.ChargedQuota)
				assert.Zero(t, fresh.UsedQuota)
				assert.Zero(t, fresh.RequestCount)
				assert.Equal(t, 409, piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, body).Code)
				assert.Equal(t, 1, calls, "the gateway never dispatches a second operation for failover")
				w = piknoLLMTestCall(router, token, "GET", "/assistant/v2/requests/"+id, "", "")
				assert.Equal(t, 200, w.Code)
				assert.Contains(t, w.Body.String(), `"status":"`+order.State+`"`)
			})
		}
	})
	t.Run("zero execution release is dispatched scoped and concurrent idempotent", func(t *testing.T) {
		user, token, _ := setupPiknoLLMTest(t)
		id := strings.Repeat("6", 32)
		order, created, err := model.ReservePiknoLLM(user.Id, token.Id, id, strings.Repeat("a", 64), model.PiknoLLMPriceVersion, 10)
		require.NoError(t, err)
		require.True(t, created)
		_, err = model.FinishPiknoLLM(user.Id, id, "rejected_before_execution", 0, 0)
		require.Error(t, err, "a submitted rejection cannot describe a request not yet dispatched")
		require.NoError(t, model.DispatchPiknoLLM(user.Id, id))
		_, err = model.FinishPiknoLLM(user.Id, id, "rejected_before_execution", 1, 0)
		require.Error(t, err, "nonzero execution contradicts the release proof")
		var wg sync.WaitGroup
		results := make(chan error, 2)
		for range 2 {
			wg.Go(func() {
				_, err := model.FinishPiknoLLM(user.Id, id, "rejected_before_execution", 0, 0)
				results <- err
			})
		}
		wg.Wait()
		close(results)
		for err := range results {
			require.NoError(t, err)
		}
		order, err = model.GetPiknoLLMRequest(user.Id, id)
		require.NoError(t, err)
		assert.Equal(t, "released", order.State)
		assert.Equal(t, order.ReservedQuota, order.RefundedQuota)
		_, err = model.FinishPiknoLLM(user.Id, id, "usage", 10, 2)
		require.NoError(t, err, "terminal receipt replay cannot create a later charge")
		var fresh model.User
		require.NoError(t, model.DB.First(&fresh, user.Id).Error)
		var freshToken model.Token
		require.NoError(t, model.DB.First(&freshToken, token.Id).Error)
		assert.Equal(t, 10_000_000, fresh.Quota)
		assert.Equal(t, 10_000_000, freshToken.RemainQuota)
		assert.Zero(t, fresh.UsedQuota)
		assert.Zero(t, fresh.RequestCount)
		assert.Zero(t, freshToken.UsedQuota)
	})
	t.Run("validation happens before reservation", func(t *testing.T) {
		_, token, router := setupPiknoLLMTest(t)
		for _, body := range []string{`{"model":"ep-private","input":"test","max_output_tokens":1}`, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":-1}`, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":101}`, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":18446744073709551615}`, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":1,"tools":[]}`, `{"model":"pikno-chat-standard","input":[{"role":"user","content":[{"type":"input_file","file_id":"file-private"}]}],"max_output_tokens":1}`} {
			w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", strings.Repeat("e", 32), body)
			assert.Equal(t, 400, w.Code, body)
		}
		t.Setenv("PIKNO_LLM_MAX_OUTPUT_TOKENS", "0")
		assert.Equal(t, 503, piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", strings.Repeat("e", 32), `{}`).Code)
		var count int64
		require.NoError(t, model.DB.Model(&model.PiknoLLMRequest{}).Count(&count).Error)
		assert.Zero(t, count)
		_, err := model.PiknoLLMQuota(common.MaxQuota, common.MaxQuota)
		require.Error(t, err)
	})
	t.Run("SDK null options and fixed message types canonicalize without granting capabilities", func(t *testing.T) {
		_, token, router := setupPiknoLLMTest(t)
		piknoLLMTransport = piknoAssistantRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			raw, err := io.ReadAll(req.Body)
			require.NoError(t, err)
			assert.NotContains(t, string(raw), `"store"`)
			assert.NotContains(t, string(raw), `"tools"`)
			assert.NotContains(t, string(raw), `"type":"message"`)
			assert.Contains(t, string(raw), `"stream":false`)
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}`))}, nil
		})
		w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", strings.Repeat("0", 32), `{"model":"pikno-chat-standard","input":[{"type":"message","role":"user","content":"test"}],"max_output_tokens":10,"store":null,"tools":null,"instructions":null,"stream":false}`)
		assert.Equal(t, 200, w.Code, w.Body.String())
	})
	t.Run("SSE settles terminal usage but not a truncated stream", func(t *testing.T) {
		delta := "data: {\"type\":\"response.output_text.delta\",\"delta\":\"synthetic\"}\n\n"
		completed := "data: {\"type\":\"response.completed\",\"response\":{\"model\":\"ep-private\",\"status\":\"completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":2,\"total_tokens\":12}}}\n\n"
		zero := strings.Replace(completed, `"input_tokens":10,"output_tokens":2,"total_tokens":12`, `"input_tokens":0,"output_tokens":0,"total_tokens":0`, 1)
		for _, tc := range []struct {
			name, events string
			settled      bool
		}{
			{"truncated", delta, false},
			{"completed", delta + completed + "data: [DONE]\n\n", true},
			{"failed with authoritative usage", delta + strings.ReplaceAll(completed, "completed", "failed"), true},
			{"incomplete with authoritative usage", delta + strings.ReplaceAll(completed, "completed", "incomplete"), true},
			{"created in progress is not a settlement", "data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}\n\n" + completed, true},
			{"created without status matches official initial event", "data: {\"type\":\"response.created\",\"response\":{\"object\":\"response\"}}\n\n" + completed, true},
			{"created cannot claim terminal zero usage", strings.Replace(zero, `"type":"response.completed"`, `"type":"response.created"`, 1) + completed, false},
			{"in progress cannot claim terminal zero usage", strings.Replace(zero, `"type":"response.completed"`, `"type":"response.in_progress"`, 1) + completed, false},
			{"error cannot claim terminal zero usage", strings.Replace(zero, `"type":"response.completed"`, `"type":"error"`, 1) + completed, false},
			{"response error cannot claim terminal zero usage", strings.Replace(zero, `"type":"response.completed"`, `"type":"response.error"`, 1) + completed, false},
			{"terminal event and status disagree", strings.Replace(completed, `"status":"completed"`, `"status":"failed"`, 1), false},
			{"terminal event requires its response", "data: {\"type\":\"response.completed\"}\n\n", false},
			{"unverified cancelled event", strings.ReplaceAll(completed, "completed", "cancelled"), false},
			{"unverified canceled event", strings.ReplaceAll(completed, "completed", "canceled"), false},
			{"unknown event cannot settle", strings.Replace(completed, `"type":"response.completed"`, `"type":"custom"`, 1), false},
			{"DONE before authoritative terminal", "data: [DONE]\n\n" + completed, false},
			{"first authoritative terminal closes the stream", completed + "data: {\"type\":\"response.output_text.delta\",\"delta\":\"late-should-not-forward\"}\n\n" + zero, true},
		} {
			t.Run(tc.name, func(t *testing.T) {
				user, token, router := setupPiknoLLMTest(t)
				piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(tc.events))}, nil
				})
				id := strings.Repeat("f", 32)
				w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":10,"stream":true}`)
				assert.Equal(t, 200, w.Code)
				assert.NotContains(t, w.Body.String(), "ep-private")
				assert.NotContains(t, w.Body.String(), "late-should-not-forward")
				order, err := model.GetPiknoLLMRequest(user.Id, id)
				require.NoError(t, err)
				if tc.settled {
					assert.Equal(t, "settled", order.State)
					assert.Equal(t, 180, order.ChargedQuota)
					assert.Contains(t, w.Body.String(), "[DONE]")
				} else {
					assert.Equal(t, "unknown", order.State)
					assert.Zero(t, order.ChargedQuota)
					assert.Zero(t, order.RefundedQuota)
					assert.NotContains(t, w.Body.String(), "[DONE]")
				}
			})
		}
	})
	t.Run("explicit complete zero usage settles zero while missing usage remains unknown", func(t *testing.T) {
		for _, tc := range []struct{ name, usage, state string }{
			{"explicit zero", `{"input_tokens":0,"output_tokens":0,"total_tokens":0}`, "settled"},
			{"missing usage", `null`, "unknown"},
			{"missing input", `{"output_tokens":0,"total_tokens":0}`, "unknown"},
			{"missing total", `{"input_tokens":0,"output_tokens":0}`, "unknown"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				user, token, router := setupPiknoLLMTest(t)
				piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","usage":` + tc.usage + `}`))}, nil
				})
				id := strings.Repeat("9", 32)
				w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":10}`)
				order, err := model.GetPiknoLLMRequest(user.Id, id)
				require.NoError(t, err)
				assert.Equal(t, tc.state, order.State)
				if tc.state == "settled" {
					assert.Equal(t, 200, w.Code)
					assert.Zero(t, order.ChargedQuota)
					assert.Equal(t, order.ReservedQuota, order.RefundedQuota)
				} else {
					assert.Equal(t, 502, w.Code)
					assert.Zero(t, order.RefundedQuota)
				}
			})
		}
	})
	t.Run("wallet key bounds, foreign status and concurrent reservation", func(t *testing.T) {
		user, token, router := setupPiknoLLMTest(t)
		digest := strings.Repeat("a", 64)
		require.NoError(t, model.DB.Model(token).Update("remain_quota", 0).Error)
		_, _, err := model.ReservePiknoLLM(user.Id, token.Id, strings.Repeat("1", 32), digest, model.PiknoLLMPriceVersion, 10)
		require.Error(t, err)
		require.NoError(t, model.DB.Model(token).Update("remain_quota", 10_000_000).Error)
		var wg sync.WaitGroup
		results := make(chan error, 2)
		for index := range 2 {
			wg.Go(func() {
				_, _, err := model.ReservePiknoLLM(user.Id, token.Id, strings.Repeat(fmt.Sprint(index+1), 32), digest, model.PiknoLLMPriceVersion, 10)
				results <- err
			})
		}
		wg.Wait()
		close(results)
		success := 0
		for err := range results {
			if err == nil {
				success++
			}
		}
		assert.Equal(t, 1, success)
		foreignUser := &model.User{Id: user.Id + 1000, Username: "foreign-llm", AffCode: "foreign-llm", Group: "default", Status: common.UserStatusEnabled}
		require.NoError(t, model.DB.Create(foreignUser).Error)
		foreign := &model.Token{UserId: foreignUser.Id, Key: "foreignllmkey", Group: model.PiknoLLMGroup, Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
		require.NoError(t, model.DB.Create(foreign).Error)
		var order model.PiknoLLMRequest
		require.NoError(t, model.DB.Where("user_id = ?", user.Id).First(&order).Error)
		// A second same-owner key may inspect state; a foreign customer cannot.
		w := piknoLLMTestCall(router, token, "GET", "/assistant/v2/requests/"+order.RequestID, "", "")
		assert.Equal(t, 200, w.Code)
		assert.Equal(t, 404, piknoLLMTestCall(router, foreign, "GET", "/assistant/v2/requests/"+order.RequestID, "", "").Code)
	})
	t.Run("actual usage ignores obsolete forecast caps but rejects malformed or overflowing quantities", func(t *testing.T) {
		for _, tc := range []struct {
			name, usage string
			settled     bool
		}{
			{"input exceeds obsolete forecast", `{"input_tokens":1001,"output_tokens":2,"total_tokens":1003}`, true},
			{"negative input", `{"input_tokens":-1,"output_tokens":2,"total_tokens":1}`, false},
			{"output exceeds requested limit", `{"input_tokens":10,"output_tokens":11,"total_tokens":21}`, false},
			{"fractional usage", `{"input_tokens":1.5,"output_tokens":2,"total_tokens":3.5}`, false},
			{"total contradicts components", `{"input_tokens":10,"output_tokens":2,"total_tokens":11}`, false},
			{"charge exceeds safe numerical domain", fmt.Sprintf(`{"input_tokens":%d,"output_tokens":2,"total_tokens":%d}`, common.MaxQuota, int64(common.MaxQuota)+2), false},
			{"JSON integer overflows", `{"input_tokens":18446744073709551615,"output_tokens":2,"total_tokens":1}`, false},
			{"cached exceeds input", `{"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":11}}`, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				user, token, router := setupPiknoLLMTest(t)
				t.Setenv("PIKNO_LLM_MAX_INPUT_TOKENS", "1")
				t.Setenv("PIKNO_LLM_MAX_REQUEST_QUOTA", "1")
				piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","usage":` + tc.usage + `}`))}, nil
				})
				id := strings.Repeat("1", 32)
				w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, `{"model":"pikno-chat-standard","input":"test","max_output_tokens":10}`)
				order, err := model.GetPiknoLLMRequest(user.Id, id)
				require.NoError(t, err)
				var fresh model.User
				require.NoError(t, model.DB.First(&fresh, user.Id).Error)
				if tc.settled {
					assert.Equal(t, 200, w.Code)
					assert.Equal(t, "settled", order.State)
					assert.Equal(t, 9_099, order.ChargedQuota)
					assert.Equal(t, 10_000_000-9_099, fresh.Quota)
				} else {
					assert.Equal(t, 502, w.Code)
					assert.Equal(t, "unknown", order.State)
					assert.Zero(t, order.ChargedQuota)
					assert.Equal(t, 10_000_000, fresh.Quota)
					assert.Zero(t, fresh.UsedQuota)
					assert.Zero(t, fresh.RequestCount)
				}
				assert.Zero(t, order.ReservedQuota)
				assert.Zero(t, order.RefundedQuota)
			})
		}
	})
	t.Run("nonempty legacy prepaid ledgers survive two additive migrations and settle by their own snapshots", func(t *testing.T) {
		user, token, _ := setupPiknoLLMTest(t)
		settled := model.PiknoLLMRequest{ID: strings.Repeat("a", 64), UserID: user.Id, TokenID: token.Id, RequestID: strings.Repeat("a", 32), BodySHA256: strings.Repeat("a", 64), Model: model.PiknoLLMModel, PriceVersion: "chat-cny-9-45-v1", InputRate: 9, OutputRate: 45, ProviderInputRate: 6, ProviderOutputRate: 30, InputLimit: 1000, OutputLimit: 10, State: "settled", ReservedQuota: 9450, ChargedQuota: 180, RefundedQuota: 9270, InputTokens: 10, OutputTokens: 2, TokenLimited: true}
		pending := settled
		pending.ID, pending.RequestID, pending.State = strings.Repeat("b", 64), strings.Repeat("b", 32), "dispatched"
		pending.ChargedQuota, pending.RefundedQuota, pending.InputTokens, pending.OutputTokens = 0, 0, 0, 0
		releasable := pending
		releasable.ID, releasable.RequestID = strings.Repeat("c", 64), strings.Repeat("c", 32)
		require.NoError(t, model.DB.Create(&settled).Error)
		require.NoError(t, model.DB.Create(&pending).Error)
		require.NoError(t, model.DB.Create(&releasable).Error)
		require.NoError(t, model.DB.Model(user).Updates(map[string]any{"quota": 10_000_000 - 180 - 2*9450, "used_quota": 180, "request_count": 1}).Error)
		require.NoError(t, model.DB.Model(token).Updates(map[string]any{"remain_quota": 10_000_000 - 180 - 2*9450, "used_quota": 180}).Error)
		// A representative pre-upgrade table has real prepaid rows but no new
		// billing-mode column. All destructive setup is this test's fresh DB.
		require.NoError(t, model.DB.Migrator().DropColumn(&model.PiknoLLMRequest{}, "BillingMode"))
		for range 2 {
			require.NoError(t, model.MigratePiknoLLM(model.DB))
		}
		old, err := model.GetPiknoLLMRequest(user.Id, settled.RequestID)
		require.NoError(t, err)
		assert.Equal(t, settled, *old)
		_, err = model.FinishPiknoLLM(user.Id, pending.RequestID, "usage", 1001, 2)
		require.Error(t, err, "new debt permission never changes the old prepaid input limit")
		old, err = model.FinishPiknoLLM(user.Id, pending.RequestID, "usage", 10, 2)
		require.NoError(t, err)
		assert.Empty(t, old.BillingMode)
		assert.Equal(t, "chat-cny-9-45-v1", old.PriceVersion)
		assert.Equal(t, 180, old.ChargedQuota)
		assert.Equal(t, 9270, old.RefundedQuota)
		_, err = model.FinishPiknoLLM(user.Id, pending.RequestID, "usage", 10, 2)
		require.NoError(t, err)
		old, err = model.FinishPiknoLLM(user.Id, releasable.RequestID, "rejected_before_execution", 0, 0)
		require.NoError(t, err)
		assert.Equal(t, "released", old.State)
		assert.Equal(t, 9450, old.RefundedQuota)
		assert.Zero(t, old.ChargedQuota)
		var fresh model.User
		require.NoError(t, model.DB.First(&fresh, user.Id).Error)
		assert.Equal(t, 10_000_000-360, fresh.Quota)
		assert.Equal(t, 360, fresh.UsedQuota)
		assert.Equal(t, 2, fresh.RequestCount)
		duplicate := settled
		duplicate.ID = strings.Repeat("d", 64)
		require.Error(t, model.DB.Create(&duplicate).Error, "owner/request uniqueness survives migration")
		for _, index := range []string{"pikno_llm_owner_request", "pikno_llm_owner_state"} {
			assert.True(t, model.DB.Migrator().HasIndex(&model.PiknoLLMRequest{}, index))
		}
	})
	t.Run("group preparation is additive atomic and repeatable", func(t *testing.T) {
		_, _, _ = setupPiknoLLMTest(t)
		require.NoError(t, model.DB.AutoMigrate(&model.Option{}))
		rows := []model.Option{{Key: "GroupRatio", Value: `{"default":1,"image-standard":1.25,"tool-standard":1}`}, {Key: "group_ratio_setting.group_ratio", Value: `{"default":1,"image-standard":1.25,"tool-standard":1}`}, {Key: "UserUsableGroups", Value: `{"image-standard":"Images","tool-standard":"Tools"}`}}
		for _, row := range rows {
			require.NoError(t, model.DB.Save(&row).Error)
		}
		for range 2 {
			require.NoError(t, model.MigratePiknoLLMGroups(model.DB))
		}
		var ratio model.Option
		require.NoError(t, model.DB.Where(&model.Option{Key: "GroupRatio"}).First(&ratio).Error)
		assert.JSONEq(t, `{"default":1,"image-standard":1.25,"tool-standard":1,"chat-standard":1}`, ratio.Value)
		require.NoError(t, model.DB.Model(&model.Option{}).Where(&model.Option{Key: "group_ratio_setting.group_ratio"}).Update("value", `{"default":2}`).Error)
		require.Error(t, model.MigratePiknoLLMGroups(model.DB))
		require.NoError(t, model.DB.Where(&model.Option{Key: "GroupRatio"}).First(&ratio).Error)
		assert.JSONEq(t, `{"default":1,"image-standard":1.25,"tool-standard":1,"chat-standard":1}`, ratio.Value)
	})
}
