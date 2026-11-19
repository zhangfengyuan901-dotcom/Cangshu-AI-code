package controller

import (
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
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// No external request is made: the real retrieval/content handlers serve a
// synthetic historical receipt and a four-byte data URL from an isolated DB.
func TestPiknoToolsHistoricalAliasRetirementAccess(t *testing.T) {
	require.NoError(t, i18n.Init())
	user, _ := setupResponsesWSRequestTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}, &model.Ability{}, &model.Channel{}, &model.Task{}))
	task := &model.Task{TaskID: "task_historical_alias_retired", UserId: user.Id, Status: model.TaskStatusSuccess, Progress: "100%"}
	previousCache := common.MemoryCacheEnabled
	common.MemoryCacheEnabled = false
	t.Cleanup(func() { common.MemoryCacheEnabled = previousCache })
	oldGroups, oldRatios := setting.UserUsableGroups2JSONString(), ratio_setting.GroupRatio2JSONString()
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default","image-standard":"Image","video-standard":"Video","tool-standard":"Tools"}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"image-standard":1,"video-standard":1,"tool-standard":1}`))
	t.Cleanup(func() {
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(oldGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(oldRatios))
	})
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", user.Id).Update("quota", 1_000_000).Error)
	baseURL := "https://www.piknoai.com"
	shared := model.Channel{Id: 4, Name: "historical-shared-tools", Key: "test-only-bridge-secret-1234567890123456789", BaseURL: &baseURL,
		Type: constant.ChannelTypeTaskPlugin, Status: common.ChannelStatusEnabled, Group: "video-standard",
		Models: "digital,depth,pikno-tool-digital,pikno-tool-depth"}
	require.NoError(t, shared.Insert())
	// Match the planned production retirement exactly: keep id 4 and its
	// internal execution models, remove only its public routing aliases.
	require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", 4).Update("models", "digital,depth").Error)
	require.NoError(t, model.DB.Where("channel_id = ? AND model IN ?", 4, []string{"pikno-tool-digital", "pikno-tool-depth"}).Delete(&model.Ability{}).Error)
	var retired model.Channel
	require.NoError(t, model.DB.First(&retired, 4).Error)
	assert.Equal(t, common.ChannelStatusEnabled, retired.Status)
	assert.Equal(t, "digital,depth", retired.Models)
	var aliases int64
	require.NoError(t, model.DB.Model(&model.Ability{}).Where("channel_id = ? AND model IN ?", 4, []string{"pikno-tool-digital", "pikno-tool-depth"}).Count(&aliases).Error)
	assert.Zero(t, aliases)

	previousRegistry := pluginruntime.DefaultRegistry
	pluginruntime.DefaultRegistry = pluginruntime.NewRegistry()
	t.Cleanup(func() { pluginruntime.DefaultRegistry = previousRegistry })
	source, err := os.ReadFile("/build/pikno-tools.js")
	require.NoError(t, err)
	_, err = pluginruntime.DefaultRegistry.Register(string(source), pluginruntime.Options{Key: "pikno-tools", Version: "test"})
	require.NoError(t, err)
	task.ChannelId, task.Platform, task.Action = 4, "pikno-tools", constant.TaskActionImageToVideo
	task.Properties.OriginModelName, task.Properties.UpstreamModelName = "pikno-tool-depth", "depth"
	task.PrivateData.ResultURL = "data:video/mp4;base64,dGVzdA=="
	task.SetData(map[string]any{"id": task.TaskID, "status": "completed", "outputs": []any{map[string]any{"type": "video", "url": "https://www.piknoai.com/media/v1/assets/11111111111111111111111111111111?ticket=synthetic"}}})
	require.NoError(t, model.DB.Save(task).Error)
	foreign := model.User{Id: 8, Username: "artifact-foreign", AffCode: "artifactforeign", Status: common.UserStatusEnabled, Role: common.RoleCommonUser, Group: "default", Quota: 1_000_000}
	require.NoError(t, model.DB.Create(&foreign).Error)
	keys := map[string]string{}
	for _, tc := range []struct {
		name, group, models string
		owner, status       int
		expires             int64
	}{
		{"video", "video-standard", "", user.Id, common.TokenStatusEnabled, -1},
		{"tool", "tool-standard", "", user.Id, common.TokenStatusEnabled, -1},
		{"allowed", "tool-standard", "pikno-tool-depth", user.Id, common.TokenStatusEnabled, -1},
		{"restricted", "image-standard", "pikno-image-flare", user.Id, common.TokenStatusEnabled, -1},
		{"empty", "tool-standard", "", user.Id, common.TokenStatusEnabled, -1},
		{"foreign", "tool-standard", "", 8, common.TokenStatusEnabled, -1},
		{"expired", "tool-standard", "", user.Id, common.TokenStatusEnabled, time.Now().Unix() - 60},
		{"revoked", "tool-standard", "", user.Id, common.TokenStatusDisabled, -1},
	} {
		token := model.Token{UserId: tc.owner, Name: tc.name, Key: tc.name + "artifacttestonly1234567890123456789", Group: tc.group,
			Status: tc.status, ExpiredTime: tc.expires, UnlimitedQuota: true, ModelLimitsEnabled: tc.models != "", ModelLimits: tc.models}
		if tc.name == "empty" {
			token.ModelLimitsEnabled = true
		}
		require.NoError(t, model.DB.Create(&token).Error)
		keys[tc.name] = "Bearer sk-" + token.Key
	}
	router := gin.New()
	router.Use(PiknoStorefrontGuard)
	router.GET("/v1/videos/:task_id", middleware.TokenAuth(), PiknoMediaGuard, middleware.Distribute(), func(c *gin.Context) {
		if taskErr := relay.RelayTaskFetch(c, relayconstant.RelayModeVideoFetchByID); taskErr != nil {
			c.JSON(taskErr.StatusCode, taskErr)
		}
	})
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		router.Handle(method, "/v1/videos/:task_id/content", middleware.TokenAuth(), PiknoVideoProxy)
		router.Handle(method, "/v1/tasks/:key/artifacts/:artifact_key/content", middleware.TokenOrTaskArtifactAccessAuth("key", "artifact_key"), PiknoTaskArtifactContent)
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/v1/videos/" + task.TaskID},
		{http.MethodGet, "/v1/videos/" + task.TaskID + "/content"},
		{http.MethodHead, "/v1/videos/" + task.TaskID + "/content"},
		{http.MethodGet, "/v1/tasks/" + task.TaskID + "/artifacts/video/content"},
		{http.MethodHead, "/v1/tasks/" + task.TaskID + "/artifacts/video/content"},
	} {
		for _, keyName := range []string{"video", "tool", "allowed", "restricted", "empty", "foreign", "expired", "revoked"} {
			t.Run(route.method+" "+route.path+" "+keyName, func(t *testing.T) {
				req := httptest.NewRequest(route.method, route.path, nil)
				req.Header.Set("Authorization", keys[keyName])
				response := httptest.NewRecorder()
				router.ServeHTTP(response, req)
				expected := http.StatusOK
				switch keyName {
				case "restricted", "empty":
					expected = http.StatusForbidden
				case "foreign":
					expected = http.StatusNotFound
					if !strings.Contains(route.path, "/content") {
						expected = http.StatusBadRequest
					}
				case "expired", "revoked":
					expected = http.StatusUnauthorized
				}
				assert.Equal(t, expected, response.Code)
				if expected >= 400 {
					assert.NotContains(t, response.Body.String(), "dGVzdA==")
					assert.NotEqual(t, "test", response.Body.String())
				}
			})
		}
	}
	// Existing dashboard preview capabilities remain a separate read-only path;
	// this fix does not turn those signed capabilities into customer API Keys.
	previousSecret := common.CryptoSecret
	common.CryptoSecret = "test-only-artifact-capability-secret"
	t.Cleanup(func() { common.CryptoSecret = previousSecret })
	access, err := service.IssueTaskArtifactAccess(task.TaskID, "video")
	require.NoError(t, err)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		path := "/v1/tasks/" + task.TaskID + "/artifacts/video/content?access=" + access
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(method, path, nil))
		assert.Equal(t, http.StatusOK, response.Code)
		response = httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(method, path+"tampered", nil))
		assert.Equal(t, http.StatusNotFound, response.Code)
	}

	for _, origin := range []string{"", "depth"} {
		task.Properties.OriginModelName = origin
		require.NoError(t, model.DB.Save(task).Error)
		for _, route := range []string{"/v1/videos/" + task.TaskID + "/content", "/v1/tasks/" + task.TaskID + "/artifacts/video/content"} {
			req := httptest.NewRequest(http.MethodGet, route, nil)
			req.Header.Set("Authorization", keys["allowed"])
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			assert.Equal(t, http.StatusForbidden, response.Code, "unknown historical origin must not bypass an explicit model restriction")
		}
	}
	task.Properties.OriginModelName = "pikno-tool-depth"
	require.NoError(t, model.DB.Save(task).Error)
	for _, limits := range []any{nil, map[string]bool{}, "invalid-context-type"} {
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Set("id", user.Id)
		c.Set("token_id", 1)
		common.SetContextKey(c, constant.ContextKeyTokenModelLimitEnabled, true)
		if limits != nil {
			common.SetContextKey(c, constant.ContextKeyTokenModelLimit, limits)
		}
		assert.False(t, piknoArtifactTokenModelAllowed(c, task.TaskID))
		assert.Equal(t, http.StatusForbidden, response.Code)
	}
	task.Platform, task.Properties.OriginModelName = "document", "document-model"
	require.NoError(t, model.DB.Save(task).Error)
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	c.Set("id", user.Id)
	c.Set("token_id", 1)
	common.SetContextKey(c, constant.ContextKeyTokenModelLimitEnabled, true)
	assert.True(t, piknoArtifactTokenModelAllowed(c, task.TaskID), "this PIKNO fix must not change unrelated generic task behavior")
	assert.False(t, c.IsAborted())
}
