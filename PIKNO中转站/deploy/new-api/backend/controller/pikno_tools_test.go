package controller

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relay"
	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	taskplugin "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPiknoToolsKeyIsolation(t *testing.T) {
	require.NoError(t, i18n.Init())
	gin.SetMode(gin.TestMode)
	user, _ := setupResponsesWSRequestTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}, &model.Channel{}, &model.Ability{}, &model.Task{}, &model.PiknoLine{}))
	oldGroups, oldRatios := setting.UserUsableGroups2JSONString(), ratio_setting.GroupRatio2JSONString()
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default","image-standard":"Image","video-standard":"Video","tool-standard":"Tools"}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"image-standard":1,"video-standard":1,"tool-standard":1}`))
	t.Cleanup(func() {
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(oldGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(oldRatios))
	})
	t.Cleanup(func() {
		require.NoError(t, model.DB.Unscoped().Where("task_id = ?", "task_historical_tool").Delete(&model.Task{}).Error)
		require.NoError(t, model.DB.Unscoped().Where("public_model IN ?", []string{"pikno-tool-digital", "pikno-tool-depth", "ordinary-image", "ordinary-video"}).Delete(&model.PiknoLine{}).Error)
		require.NoError(t, model.DB.Unscoped().Where("name = ?", "historical-tools").Delete(&model.Channel{}).Error)
		require.NoError(t, model.DB.Unscoped().Where("name = ?", "tool-key-test").Delete(&model.Token{}).Error)
		require.NoError(t, model.DB.Unscoped().Where("username = ?", "foreign-tool-owner").Delete(&model.User{}).Error)
	})
	keys := make(map[string]string)
	for _, kind := range []string{"image", "video", "tool"} {
		models := "pikno-tool-digital,pikno-tool-depth"
		if kind == "image" {
			models = "ordinary-image"
		}
		if kind == "video" {
			models += ",ordinary-video"
		}
		token := model.Token{UserId: user.Id, Name: "tool-key-test", Key: kind + "testonly1234567890123456789", Group: kind + "-standard", ModelLimitsEnabled: true, ModelLimits: models, Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
		require.NoError(t, model.DB.Create(&token).Error)
		keys[kind] = "Bearer sk-" + token.Key
	}
	for _, kind := range []string{"digital", "depth"} {
		line := model.PiknoLineConfig{PublicModel: "pikno-tool-" + kind, Kind: "video", Provider: "hamster-tools", PluginKey: "pikno-tools", UpstreamModel: kind, Enabled: true, Revision: 1, ChannelID: 1}
		raw, err := common.Marshal(line)
		require.NoError(t, err)
		require.NoError(t, model.DB.Create(&model.PiknoLine{PublicModel: line.PublicModel, Version: 1, PublishedConfig: string(raw)}).Error)
		require.NoError(t, model.SyncPiknoLines([]model.PiknoLineSeed{line}, 1))
	}
	channel := model.Channel{Id: 1, Name: "historical-tools", Key: "test-only", Status: common.ChannelStatusEnabled, Type: constant.ChannelTypeTaskPlugin}
	require.NoError(t, channel.Insert())
	for _, kind := range []string{"image", "video"} {
		line := model.PiknoLineConfig{PublicModel: "ordinary-" + kind, Kind: kind, Provider: "packy", UpstreamModel: "test", Enabled: true, Revision: 1, ChannelID: channel.Id}
		raw, err := common.Marshal(line)
		require.NoError(t, err)
		require.NoError(t, model.DB.Create(&model.PiknoLine{PublicModel: line.PublicModel, Version: 1, PublishedConfig: string(raw)}).Error)
		require.NoError(t, model.SyncPiknoLines([]model.PiknoLineSeed{line}, 1))
	}
	t.Setenv("PIKNO_TOOLS_ENABLED", "true")
	t.Setenv("PIKNO_TOOLS_BRIDGE_SECRET", "test-only-internal-bridge-secret-123456789")
	t.Setenv("PIKNO_MEDIA_ENABLED", "true")
	t.Setenv("PIKNO_MEDIA_TICKET_KEY", "test-only-media-ticket-secret-123456789")
	previousTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	http.DefaultTransport = piknoTestTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "/media/v1/tools/status", req.URL.Path)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"enabled":true,"credential_configured":true,"ready":true,"tools":{"digital":{"available":true,"max_audio_seconds":30},"depth":{"available":true}}}`))}, nil
	})
	router := gin.New()
	router.POST("/v1/tools/:kind", middleware.TokenAuth(), PiknoMediaGuard, func(c *gin.Context) { c.Status(204) })
	router.POST("/v1/videos", middleware.TokenAuth(), PiknoMediaGuard, func(c *gin.Context) { c.Status(204) })
	router.POST("/v1/images/generations", middleware.TokenAuth(), PiknoMediaGuard, func(c *gin.Context) { c.Status(204) })
	router.POST("/v1/media/uploads", middleware.TokenAuth(), PiknoMediaUpload)
	router.GET("/v1/client/context", middleware.TokenAuth(), PiknoClientContext)
	t.Setenv("PIKNO_ASSISTANT_ENABLED", "true")
	t.Setenv("PIKNO_ASSISTANT_BRIDGE_SECRET", "test-only-assistant-bridge-secret-123456789")
	previousAssistantTransport := piknoAssistantTransport
	t.Cleanup(func() { piknoAssistantTransport = previousAssistantTransport })
	piknoAssistantTransport = piknoTestTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("a tool key must not activate the assistant")
		return nil, nil
	})
	router.POST("/assistant/v1/activate", middleware.TokenAuth(), PiknoAssistantActivate)
	call := func(method, path, key, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", key)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	for _, kind := range []string{"digital", "depth"} {
		body := `{"model":"pikno-tool-` + kind + `"}`
		for _, keyKind := range []string{"image", "video", "tool"} {
			expected := 403
			if keyKind == "tool" {
				expected = 204
			}
			assert.Equal(t, expected, call("POST", "/v1/tools/"+kind, keys[keyKind], body).Code, kind+"/"+keyKind)
		}
		assert.Equal(t, 400, call("POST", "/v1/videos", keys["tool"], body).Code)
	}
	for _, kind := range []string{"image", "video"} {
		path := "/v1/videos"
		if kind == "image" {
			path = "/v1/images/generations"
		}
		body := `{"model":"ordinary-` + kind + `","prompt":"test"}`
		assert.Equal(t, 403, call("POST", path, keys["tool"], body).Code)
		assert.Equal(t, 204, call("POST", path, keys[kind], body).Code)
	}
	for _, mime := range []string{"image/png", "audio/mpeg", "video/mp4"} {
		assert.Equal(t, 415, call("POST", "/v1/media/uploads", keys["tool"], `{"content_type":"`+mime+`","size":16}`).Code)
	}
	identity := call("GET", "/v1/client/context", keys["tool"], "")
	assert.Equal(t, 200, identity.Code)
	assert.Contains(t, identity.Body.String(), `"group":"tool-standard"`)
	assert.NotContains(t, identity.Body.String(), "testonly")
	assert.Equal(t, 401, call("GET", "/v1/client/context", "Bearer sk-invalid", "").Code)
	assert.Equal(t, 403, call("POST", "/assistant/v1/activate", keys["tool"], "{}").Code)

	// A historical receipt belongs to the account, not the old video token.
	// Explicit token model limits still apply on the production retrieval chain.
	previousRegistry := pluginruntime.DefaultRegistry
	pluginruntime.DefaultRegistry = pluginruntime.NewRegistry()
	t.Cleanup(func() { pluginruntime.DefaultRegistry = previousRegistry })
	source, err := os.ReadFile("/build/pikno-tools.js")
	require.NoError(t, err)
	_, err = pluginruntime.DefaultRegistry.Register(string(source), pluginruntime.Options{Key: "pikno-tools", Version: "candidate"})
	require.NoError(t, err)
	task := model.Task{TaskID: "task_historical_tool", UserId: user.Id, ChannelId: channel.Id, Platform: "pikno-tools", Status: model.TaskStatusSubmitted, Data: []byte(`{"id":"task_historical_tool","status":"queued","outputs":[]}`)}
	task.Properties.OriginModelName = "pikno-tool-depth"
	task.Properties.UpstreamModelName = "depth"
	require.NoError(t, model.DB.Create(&task).Error)
	router.GET("/v1/videos/:task_id", middleware.TokenAuth(), PiknoMediaGuard, middleware.Distribute(), func(c *gin.Context) {
		if taskErr := relay.RelayTaskFetch(c, relayconstant.RelayModeVideoFetchByID); taskErr != nil {
			c.JSON(taskErr.StatusCode, taskErr)
		}
	})
	for _, keyKind := range []string{"video", "tool"} {
		response := call("GET", "/v1/videos/"+task.TaskID, keys[keyKind], "")
		assert.Equal(t, 200, response.Code, response.Body.String())
		assert.Contains(t, response.Body.String(), task.TaskID)
	}
	assert.Equal(t, 403, call("GET", "/v1/videos/"+task.TaskID, keys["image"], "").Code, "an explicit image-only model restriction is not bypassed")
	foreign := model.User{Username: "foreign-tool-owner", AffCode: "toolforeign", Status: common.UserStatusEnabled, Group: "default"}
	require.NoError(t, model.DB.Create(&foreign).Error)
	foreignToken := model.Token{UserId: foreign.Id, Name: "tool-key-test", Key: "foreigntestonly1234567890123456789", Group: "tool-standard", Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
	require.NoError(t, model.DB.Create(&foreignToken).Error)
	assert.Equal(t, 400, call("GET", "/v1/videos/"+task.TaskID, "Bearer sk-"+foreignToken.Key, "").Code)
	expired := model.Token{UserId: user.Id, Name: "tool-key-test", Key: "expiredtestonly1234567890123456789", Group: "tool-standard", Status: common.TokenStatusEnabled, ExpiredTime: time.Now().Unix() - 60, UnlimitedQuota: true}
	require.NoError(t, model.DB.Create(&expired).Error)
	assert.Equal(t, 401, call("GET", "/v1/videos/"+task.TaskID, "Bearer sk-"+expired.Key, "").Code)
	revoked := model.Token{UserId: user.Id, Name: "tool-key-test", Key: "revokedtestonly1234567890123456789", Group: "tool-standard", Status: common.TokenStatusDisabled, ExpiredTime: -1, UnlimitedQuota: true}
	require.NoError(t, model.DB.Create(&revoked).Error)
	assert.Equal(t, 401, call("GET", "/v1/videos/"+task.TaskID, "Bearer sk-"+revoked.Key, "").Code)
}

func TestPiknoToolsLifecycle(t *testing.T) {
	user, _ := setupSecurityEnrollmentTest(t)
	previous := common.BatchUpdateEnabled
	common.BatchUpdateEnabled = false
	t.Cleanup(func() { common.BatchUpdateEnabled = previous })
	t.Setenv("PIKNO_SETTLEMENT_ENABLED", "true")
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}, &model.Channel{}, &model.Ability{}, &model.Task{}, &model.PiknoLine{}))
	require.NoError(t, model.MigratePiknoSettlements(model.DB))
	require.NoError(t, model.DB.Model(user).Update("quota", 10_000_000).Error)
	token := model.Token{UserId: user.Id, Key: "tool-lifecycle-test-only", Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
	require.NoError(t, model.DB.Create(&token).Error)
	channel := model.Channel{Key: "bridge-test-only", Status: common.ChannelStatusEnabled, Name: "tool-lifecycle"}
	require.NoError(t, channel.Insert())
	for _, kind := range []string{"digital", "depth"} {
		quota := 5_000_000
		if kind == "depth" {
			quota = 500_000
		}
		line := model.PiknoLineConfig{PublicModel: "pikno-tool-" + kind, Kind: "video", Provider: "hamster-tools", PluginKey: "pikno-tools", UpstreamModel: kind, ChannelID: channel.Id, Enabled: true, Revision: 1, Prices: []model.PiknoLinePrice{{Resolution: "default", Unit: "request", RetailQuota: quota}}}
		raw, err := common.Marshal(line)
		require.NoError(t, err)
		require.NoError(t, model.DB.Create(&model.PiknoLine{PublicModel: line.PublicModel, Version: 1, PublishedConfig: string(raw)}).Error)
		require.NoError(t, model.SyncPiknoLines([]model.PiknoLineSeed{line}, 1))
		info := &relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: line.PublicModel, ChannelMeta: &relaycommon.ChannelMeta{ChannelId: channel.Id, ApiKey: channel.Key}, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_lifecycle_" + kind}, PiknoLineRevision: 1, PiknoLineQuoteQuota: quota, PiknoLinePriceUnit: "request"}
		require.NoError(t, service.NewPiknoBillingSession(info, quota))
		require.NoError(t, service.PiknoBeforeDispatch(info))
		require.Error(t, service.PiknoBeforeDispatch(info))
		task := model.Task{TaskID: info.PublicTaskID, UserId: user.Id, ChannelId: channel.Id, Status: model.TaskStatusSuccess, Data: []byte(`{"id":"task_lifecycle_` + kind + `","status":"completed","outputs":[]}`), PrivateData: model.TaskPrivateData{BillingSource: service.BillingSourcePikno, TokenId: token.Id, UpstreamTaskID: info.PublicTaskID}}
		require.NoError(t, service.PiknoRecordTask(&task))
		var order model.PiknoSettlement
		require.NoError(t, model.DB.First(&order, "id = ?", task.TaskID).Error)
		require.Equal(t, "pending_review", order.FinancialState)
		require.Zero(t, order.NetQuota)
		task.Data = []byte(`{"id":"task_lifecycle_` + kind + `","status":"completed","outputs":[{"type":"video","url":"https://www.piknoai.com/media/v1/assets/11111111111111111111111111111111?ticket=test"}]}`)
		require.NoError(t, service.PiknoRecordTask(&task))
		require.NoError(t, service.PiknoRecordTask(&task))
		require.NoError(t, model.DB.First(&order, "id = ?", task.TaskID).Error)
		require.Equal(t, "settled", order.FinancialState)
		require.Equal(t, quota, order.NetQuota)
	}
	var final model.User
	require.NoError(t, model.DB.First(&final, user.Id).Error)
	require.Equal(t, 4_500_000, final.Quota)
	require.Equal(t, 5_500_000, final.UsedQuota)
	require.Equal(t, 2, final.RequestCount)
}

func TestPiknoToolsReadiness(t *testing.T) {
	t.Setenv("PIKNO_TOOLS_ENABLED", "true")
	t.Setenv("PIKNO_TOOLS_BRIDGE_SECRET", "test-only-internal-bridge-secret-123456789")
	previous := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previous })
	for _, tc := range []struct {
		name   string
		status int
		body   string
		ready  bool
	}{
		{"configured", 200, `{"enabled":true,"credential_configured":true,"ready":true,"tools":{"digital":{"available":true,"max_audio_seconds":30},"depth":{"available":true}}}`, true},
		{"missing credential", 200, `{"enabled":true,"credential_configured":false,"ready":false}`, false},
		{"redirect", 302, `{}`, false},
		{"authorization failure", 401, `{"key":"must-not-surface"}`, false},
		{"service failure", 503, `{"error":"must-not-surface"}`, false},
		{"invalid JSON", 200, `{`, false},
		{"oversized JSON", 200, strings.Repeat("x", 4097), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			http.DefaultTransport = piknoTestTransport(func(req *http.Request) (*http.Response, error) {
				calls++
				assert.Equal(t, http.MethodGet, req.Method)
				assert.Equal(t, "https://www.piknoai.com/media/v1/tools/status", req.URL.String())
				assert.Nil(t, req.Body)
				assert.Equal(t, "Bearer "+os.Getenv("PIKNO_TOOLS_BRIDGE_SECRET"), req.Header.Get("Authorization"))
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body)), Header: http.Header{"Location": []string{"https://foreign.example/"}}}, nil
			})
			ready, err := piknoReadToolReadiness(context.Background())
			assert.Equal(t, 1, calls, "configuration checks must not retry or follow redirects")
			if tc.ready {
				require.NoError(t, err)
				assert.True(t, ready.available("digital"))
				assert.True(t, ready.available("depth"))
				assert.False(t, ready.available("other"))
			} else {
				require.Error(t, err)
				assert.Nil(t, ready)
				assert.NotContains(t, err.Error(), "must-not-surface")
				assert.NotContains(t, err.Error(), os.Getenv("PIKNO_TOOLS_BRIDGE_SECRET"))
			}
		})
	}
	t.Setenv("PIKNO_TOOLS_ENABLED", "false")
	http.DefaultTransport = piknoTestTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("disabled tools must not contact the edge")
		return nil, nil
	})
	_, err := piknoReadToolReadiness(context.Background())
	require.Error(t, err)
}

func TestPiknoToolsPreflightAndPolling(t *testing.T) {
	user, _ := setupSecurityEnrollmentTest(t)
	previousBatch := common.BatchUpdateEnabled
	common.BatchUpdateEnabled = false
	t.Cleanup(func() { common.BatchUpdateEnabled = previousBatch })
	t.Setenv("PIKNO_SETTLEMENT_ENABLED", "true")
	t.Setenv("PIKNO_TOOLS_ENABLED", "true")
	t.Setenv("PIKNO_TOOLS_BRIDGE_SECRET", "test-only-internal-bridge-secret-123456789")
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}, &model.Channel{}, &model.Ability{}, &model.Task{}, &model.PiknoLine{}))
	require.NoError(t, model.MigratePiknoSettlements(model.DB))
	require.NoError(t, model.DB.Model(user).Update("quota", 10_000_000).Error)
	token := model.Token{UserId: user.Id, Key: "tool-poll-test-only", Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
	require.NoError(t, model.DB.Create(&token).Error)
	baseURL, setting := "https://www.piknoai.com", `{"task_plugin_key":"pikno-tools"}`
	channel := model.Channel{Type: constant.ChannelTypeTaskPlugin, Key: "test-only-internal-bridge-secret-123456789", Status: common.ChannelStatusEnabled, Name: "tools-contract", BaseURL: &baseURL, Setting: &setting}
	require.NoError(t, channel.Insert())
	line := model.PiknoLineConfig{PublicModel: "pikno-tool-depth", DisplayName: "Depth", Kind: "video", Provider: "hamster-tools", PluginKey: "pikno-tools", UpstreamModel: "depth", ChannelID: channel.Id, Enabled: true, UpstreamAvailable: true, Revision: 1, Prices: []model.PiknoLinePrice{{Resolution: "default", Unit: "request", RetailQuota: 500_000}}}
	raw, err := common.Marshal(line)
	require.NoError(t, err)
	require.NoError(t, model.DB.Create(&model.PiknoLine{PublicModel: line.PublicModel, Version: 1, PublishedConfig: string(raw)}).Error)
	require.NoError(t, model.SyncPiknoLines([]model.PiknoLineSeed{line}, 1))
	previousTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previousTransport })
	http.DefaultTransport = piknoTestTransport(func(req *http.Request) (*http.Response, error) {
		assert.Equal(t, "/media/v1/tools/status", req.URL.Path)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"enabled":true,"credential_configured":false,"ready":false}`)), Header: make(http.Header)}, nil
	})
	router := gin.New()
	dispatched := false
	router.POST("/v1/tools/depth", func(c *gin.Context) {
		c.Set("id", user.Id)
		common.SetContextKey(c, constant.ContextKeyTokenGroup, "tool-standard")
	}, PiknoMediaGuard, func(c *gin.Context) { dispatched = true; c.Status(204) })
	response := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/tools/depth", strings.NewReader(`{"model":"pikno-tool-depth","videos":[]}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(response, req)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.False(t, dispatched)
	var orders int64
	require.NoError(t, model.DB.Model(&model.PiknoSettlement{}).Count(&orders).Error)
	assert.Zero(t, orders, "missing RH configuration must not reserve money")

	source, err := os.ReadFile("/build/pikno-tools.js")
	require.NoError(t, err)
	registry := pluginruntime.NewRegistry()
	plugin, err := registry.Register(string(source), pluginruntime.Options{Key: "pikno-tools", Version: "test"})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, registry.Unregister("pikno-tools")) })
	adaptor := taskplugin.New(plugin)
	previousFactory := service.GetTaskAdaptorFunc
	service.GetTaskAdaptorFunc = func(platform constant.TaskPlatform) service.TaskPollingAdaptor {
		require.Equal(t, constant.TaskPlatform("pikno-tools"), platform)
		return adaptor
	}
	t.Cleanup(func() { service.GetTaskAdaptorFunc = previousFactory })
	service.InitHttpClient()
	client := service.GetHttpClient()
	previousClientTransport := client.Transport
	t.Cleanup(func() { client.Transport = previousClientTransport })
	taskID := "task_tool_contract"
	body := `{"id":"` + taskID + `","status":"unknown","outputs":[]}`
	responseStatus := http.StatusOK
	queries := 0
	client.Transport = piknoTestTransport(func(req *http.Request) (*http.Response, error) {
		queries++
		assert.Equal(t, http.MethodGet, req.Method)
		assert.Equal(t, "https://www.piknoai.com/media/v1/tools/"+taskID, req.URL.String())
		return &http.Response{StatusCode: responseStatus, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})
	info := &relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: line.PublicModel, ChannelMeta: &relaycommon.ChannelMeta{ChannelId: channel.Id, ApiKey: channel.Key}, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: taskID}, PiknoLineRevision: 1, PiknoLineQuoteQuota: 500_000, PiknoLinePriceUnit: "request"}
	require.NoError(t, service.NewPiknoBillingSession(info, 500_000))
	require.NoError(t, service.PiknoBeforeDispatch(info))
	task := model.Task{TaskID: taskID, Platform: "pikno-tools", UserId: user.Id, ChannelId: channel.Id, Status: model.TaskStatusSubmitted, Data: []byte(`{"id":"` + taskID + `","status":"queued","outputs":[]}`), PrivateData: model.TaskPrivateData{BillingSource: service.BillingSourcePikno, TokenId: token.Id, UpstreamTaskID: taskID}}
	task.Properties.OriginModelName = line.PublicModel
	task.Properties.UpstreamModelName = "depth"
	require.NoError(t, model.DB.Create(&task).Error)
	require.NoError(t, service.PiknoRecordTask(&task))
	poll := func() {
		require.NoError(t, service.UpdateVideoTasks(context.Background(), "pikno-tools", map[int][]string{channel.Id: {taskID}}, map[string]*model.Task{taskID: &task}))
		require.NoError(t, model.DB.First(&task, task.ID).Error)
	}
	poll()
	assert.Equal(t, model.TaskStatus(model.TaskStatusSubmitted), task.Status)
	var stored map[string]any
	require.NoError(t, common.Unmarshal(task.Data, &stored))
	assert.Equal(t, "unknown", stored["status"])
	var order model.PiknoSettlement
	require.NoError(t, model.DB.First(&order, "id = ?", taskID).Error)
	assert.Equal(t, "pending_review", order.FinancialState)
	assert.Zero(t, order.NetQuota)
	encoded, err := adaptor.ConvertToOpenAIVideo(&task)
	require.NoError(t, err)
	var visible map[string]any
	require.NoError(t, common.Unmarshal(encoded, &visible))
	assert.Equal(t, "unknown", visible["status"])
	assert.Equal(t, taskID, visible["id"])
	assert.NotContains(t, string(encoded), channel.Key)
	responseStatus = http.StatusUnauthorized
	poll()
	assert.Equal(t, model.TaskStatus(model.TaskStatusSubmitted), task.Status)
	responseStatus = http.StatusOK
	body = `{"id":"foreign-receipt","status":"completed","outputs":[{"type":"video","url":"https://foreign.example/private.mp4"}]}`
	poll()
	assert.Equal(t, model.TaskStatus(model.TaskStatusSubmitted), task.Status)
	stored = nil
	require.NoError(t, common.Unmarshal(task.Data, &stored))
	assert.Equal(t, "unknown", stored["status"])
	assert.NotContains(t, string(task.Data), "foreign-receipt")
	assert.NotContains(t, string(task.Data), "foreign.example")
	resultURL := "https://www.piknoai.com/media/v1/assets/11111111111111111111111111111111?ticket=test"
	body = `{"id":"` + taskID + `","status":"completed","outputs":[{"type":"video","url":"` + resultURL + `"}]}`
	poll()
	poll()
	assert.Equal(t, model.TaskStatus(model.TaskStatusSuccess), task.Status)
	require.NoError(t, model.DB.First(&order, "id = ?", taskID).Error)
	assert.Equal(t, "settled", order.FinancialState)
	assert.Equal(t, 500_000, order.NetQuota)
	var final model.User
	require.NoError(t, model.DB.First(&final, user.Id).Error)
	assert.Equal(t, 9_500_000, final.Quota)
	assert.Equal(t, 500_000, final.UsedQuota)
	assert.Equal(t, 1, final.RequestCount)
	assert.Equal(t, 5, queries)
	content, err := adaptor.BuildContentRequest(&task, "video", relaychannel.TaskArtifactClientRequest{Method: http.MethodGet})
	require.NoError(t, err)
	assert.Equal(t, "https://www.piknoai.com/media/v1/tools/"+taskID+"/content", content.URL)
	assert.False(t, content.Credentialless)
	assert.Equal(t, "Bearer "+channel.Key, content.Headers["Authorization"])
	assert.NotContains(t, content.URL, "ticket=")
	content, err = adaptor.BuildContentRequest(&task, "video", relaychannel.TaskArtifactClientRequest{Method: http.MethodHead, Headers: map[string]string{"Range": "bytes=0-1023"}})
	require.NoError(t, err)
	assert.Equal(t, http.MethodHead, content.Method)
	assert.Equal(t, "bytes=0-1023", content.Headers["Range"])

	taskID = "task_tool_failed"
	body = `{"id":"` + taskID + `","status":"failed","outputs":[]}`
	failedInfo := &relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: line.PublicModel, ChannelMeta: &relaycommon.ChannelMeta{ChannelId: channel.Id, ApiKey: channel.Key}, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: taskID}, PiknoLineRevision: 1, PiknoLineQuoteQuota: 500_000, PiknoLinePriceUnit: "request"}
	require.NoError(t, service.NewPiknoBillingSession(failedInfo, 500_000))
	require.NoError(t, service.PiknoBeforeDispatch(failedInfo))
	task = model.Task{TaskID: taskID, Platform: "pikno-tools", UserId: user.Id, ChannelId: channel.Id, Status: model.TaskStatusSubmitted, Data: []byte(`{"id":"` + taskID + `","status":"queued","outputs":[]}`), PrivateData: model.TaskPrivateData{BillingSource: service.BillingSourcePikno, TokenId: token.Id, UpstreamTaskID: taskID}}
	task.Properties.OriginModelName = line.PublicModel
	task.Properties.UpstreamModelName = "depth"
	require.NoError(t, model.DB.Create(&task).Error)
	require.NoError(t, service.PiknoRecordTask(&task))
	poll()
	poll()
	assert.Equal(t, model.TaskStatus(model.TaskStatusFailure), task.Status)
	order = model.PiknoSettlement{}
	require.NoError(t, model.DB.First(&order, "id = ?", taskID).Error)
	assert.Equal(t, "settled", order.FinancialState)
	assert.Equal(t, "failed", order.SettledOutcome)
	assert.Zero(t, order.NetQuota)
	require.NoError(t, model.DB.First(&final, user.Id).Error)
	assert.Equal(t, 9_500_000, final.Quota)
	assert.Equal(t, 500_000, final.UsedQuota)
	assert.Equal(t, 2, final.RequestCount, "each accepted task counts once, including terminal failures")
	encoded, err = adaptor.ConvertToOpenAIVideo(&task)
	require.NoError(t, err)
	require.NoError(t, common.Unmarshal(encoded, &visible))
	assert.Equal(t, "failed", visible["status"])
}
