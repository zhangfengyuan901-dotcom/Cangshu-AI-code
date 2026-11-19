package controller

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupPiknoRHConnectionFixture(t *testing.T) *model.User {
	t.Helper()
	dialect := os.Getenv("TEST_SECURITY_DIALECT")
	if dialect != "" && dialect != "sqlite" {
		require.Contains(t, []string{"mysql", "postgres"}, dialect)
		_, dsn := newAuditTestDatabase(t, dialect, os.Getenv("TEST_"+strings.ToUpper(dialect)+"_DSN"))
		t.Setenv("TEST_RESPONSES_SQL_DSN", dsn)
	} else {
		t.Setenv("TEST_RESPONSES_SQL_DSN", "")
	}
	t.Setenv("TEST_RESPONSES_LOG_SQL_DSN", "")
	user, _ := setupResponsesWSRequestTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}))
	const fixed = `{"task_plugin_key":"pikno-tools","private":"fixture-private-setting"}`
	for i, item := range []struct {
		typeID                int
		group, models, config string
	}{
		{constant.ChannelTypeOpenAI, "image-standard", "fixture-image", `{}`},
		{constant.ChannelTypeTaskPlugin, "tool-standard", "digital,pikno-tool-digital", fixed},
		{constant.ChannelTypeTaskPlugin, "tool-standard", "depth,pikno-tool-depth", fixed},
		{constant.ChannelTypeTaskPlugin, "video-standard", "digital,depth", fixed},
		{constant.ChannelTypeTaskPlugin, "tool-standard", "digital", `{"task_plugin_key":"other-plugin"}`},
		{constant.ChannelTypeTaskPlugin, "tool-standard", "digital", `{invalid`},
		{constant.ChannelTypeTaskPlugin, "tool-standard", "digital,unknown-tool", fixed},
		{constant.ChannelTypeTaskPlugin, "tool-standard,video-standard", "depth", fixed},
		{constant.ChannelTypeOpenAI, "tool-standard", "digital", fixed},
		{constant.ChannelTypeTaskPlugin, "tool-standard", "", fixed},
		{constant.ChannelTypeTaskPlugin, "default", "digital", fixed},
		{constant.ChannelTypeTaskPlugin, "tool-standard", "depth", ""},
	} {
		tag := fmt.Sprintf("fixture-tag-%02d", i+1)
		if i == 1 {
			tag = "fixture-tag-01" // A hidden tool shares the ordinary channel's tag.
		}
		base := "https://fixture-internal.invalid"
		channel := &model.Channel{Id: i + 1, Name: fmt.Sprintf("fixture-channel-%02d", i+1), Type: item.typeID,
			Status: common.ChannelStatusEnabled, Models: item.models, Group: item.group, Tag: &tag,
			Key: "fixture-internal-credential", BaseURL: &base, OtherSettings: `{"private":"fixture-other-settings"}`}
		if item.config != "" {
			channel.Setting = &item.config
		}
		if i == 2 || i == 4 {
			channel.Status = common.ChannelStatusManuallyDisabled
		}
		require.NoError(t, model.DB.Create(channel).Error)
	}
	var before []model.Channel
	require.NoError(t, model.DB.Order("id").Find(&before).Error)
	beforeJSON, err := common.Marshal(before)
	require.NoError(t, err)
	t.Cleanup(func() {
		var after []model.Channel
		require.NoError(t, model.DB.Order("id").Find(&after).Error)
		afterJSON, err := common.Marshal(after)
		require.NoError(t, err)
		assert.Equal(t, sha256.Sum256(beforeJSON), sha256.Sum256(afterJSON), "read-only connection views must not rewrite any stored channel field")
	})
	return user
}

// The production route is mounted in router/. This test exercises the same
// AdminAuth + ChannelRead chain, not the production route-registration function.
func TestPiknoRHConnectionsReadOnlyAndAuthorization(t *testing.T) {
	user := setupPiknoRHConnectionFixture(t)
	require.NoError(t, i18n.Init())
	require.NoError(t, model.DB.AutoMigrate(&model.Option{}, &model.UserSession{}, &model.UserAccessToken{}, &model.CasbinRule{}, &model.AuthzRole{}, &model.AuditLog{}))
	previousSecret, previousMaster := common.SessionSecret, common.IsMasterNode
	common.SessionSecret, common.IsMasterNode = "isolated-rh-connection-test-secret", true
	t.Cleanup(func() { common.SessionSecret, common.IsMasterNode = previousSecret, previousMaster })
	require.NoError(t, authz.Init(model.DB))
	require.NoError(t, model.DB.Model(user).Update("role", common.RoleCommonUser).Error)
	bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "rh-connections-test")
	require.NoError(t, err)
	const route = "/api/pikno/rh-connections"
	middleware.DeclareAccessTokenPermissionRoute(http.MethodGet, route, authz.ChannelRead)
	router := gin.New()
	router.GET(route, middleware.AdminAuth(), middleware.DisableCache(), middleware.RequirePermission(authz.ChannelRead), PiknoRHConnections)
	request := func(token string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, route, nil)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	assert.Equal(t, http.StatusUnauthorized, request("").Code)
	assert.Equal(t, http.StatusForbidden, request(bundle.AccessToken).Code, "ordinary customer cannot read upstream connection state")
	require.NoError(t, model.DB.Model(user).Update("role", common.RoleAdminUser).Error)
	response := request(bundle.AccessToken)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
	var body struct {
		Success bool                        `json:"success"`
		Data    map[string][]map[string]any `json:"data"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.Success)
	require.Len(t, body.Data, 2)
	require.Len(t, body.Data["tools"], 2)
	require.Len(t, body.Data["legacy"], 1)
	assert.Equal(t, float64(2), body.Data["tools"][0]["id"])
	assert.Equal(t, "digital-human", body.Data["tools"][0]["kind"])
	assert.Equal(t, float64(3), body.Data["tools"][1]["id"])
	assert.Equal(t, "depth", body.Data["tools"][1]["kind"])
	assert.Equal(t, float64(4), body.Data["legacy"][0]["id"])
	for _, connection := range body.Data["tools"] {
		assert.Len(t, connection, 4, "only id, kind, name and status may be returned")
	}
	assert.Len(t, body.Data["legacy"][0], 3, "only id, name and status may be returned")
	for _, private := range []string{"fixture-internal-credential", "fixture-internal.invalid", "fixture-private-setting", "fixture-other-settings", "task_plugin_key", "models", "settings", "base_url"} {
		assert.NotContains(t, response.Body.String(), private)
	}
	require.NoError(t, authz.SetUserPermissions(user.Id, authz.PermissionsMap{authz.ResourceChannel: {authz.ActionRead: false}}))
	assert.Equal(t, http.StatusForbidden, request(bundle.AccessToken).Code, "admin role does not bypass revoked ChannelRead permission")
}

// These calls exercise the existing list/search HTTP handlers, including
// pagination and type counts. They intentionally do not call view helpers.
func TestPiknoRHConnectionsScopeHTTP(t *testing.T) {
	setupPiknoRHConnectionFixture(t)
	gin.SetMode(gin.TestMode)
	taskType := strconv.Itoa(constant.ChannelTypeTaskPlugin)
	for _, tc := range []struct {
		name, query string
		handler     gin.HandlerFunc
		total       int
		items       []int
		typeCounts  map[string]int
	}{
		{"unscoped compatibility", "?sort_by=id&sort_order=asc&page_size=30", GetAllChannels, 12, []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}, map[string]int{"1": 2, taskType: 10}},
		{"general first page", "?pikno_view=general&sort_by=id&sort_order=asc&page_size=2", GetAllChannels, 9, []int{1, 5}, map[string]int{"1": 2, taskType: 7}},
		{"general second page", "?pikno_view=general&sort_by=id&sort_order=asc&page_size=2&p=2", GetAllChannels, 9, []int{6, 7}, map[string]int{"1": 2, taskType: 7}},
		{"general tag pagination", "?pikno_view=general&tag_mode=true&page_size=2", GetAllChannels, 9, []int{1, 5}, map[string]int{"1": 2, taskType: 7}},
		{"general type filter", "?pikno_view=general&type=" + taskType + "&sort_by=id&sort_order=asc&page_size=30", GetAllChannels, 7, []int{5, 6, 7, 8, 10, 11, 12}, map[string]int{"1": 2, taskType: 7}},
		{"general disabled filter", "?pikno_view=general&status=disabled&page_size=30", GetAllChannels, 1, []int{5}, map[string]int{taskType: 1}},
		{"search first page", "?pikno_view=general&keyword=fixture&sort_by=id&sort_order=asc&page_size=2", SearchChannels, 9, []int{1, 5}, map[string]int{"1": 2, taskType: 7}},
		{"search tags", "?pikno_view=general&keyword=fixture&tag_mode=true&sort_by=id&sort_order=asc&page_size=30", SearchChannels, 9, []int{1, 5, 6, 7, 8, 9, 10, 11, 12}, map[string]int{"1": 2, taskType: 7}},
		{"search managed only", "?pikno_view=general&keyword=fixture-channel-02&page_size=30", SearchChannels, 0, []int{}, map[string]int{}},
		{"hidden tag match must not include ordinary neighbours", "?pikno_view=general&keyword=fixture-channel-02&tag_mode=true&page_size=30", SearchChannels, 0, []int{}, map[string]int{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(response)
			context.Request = httptest.NewRequest(http.MethodGet, "/api/channel/"+tc.query, nil)
			tc.handler(context)
			require.Equal(t, http.StatusOK, response.Code)
			var body struct {
				Success bool `json:"success"`
				Data    struct {
					Total      int            `json:"total"`
					TypeCounts map[string]int `json:"type_counts"`
					Items      []struct {
						ID int `json:"id"`
					} `json:"items"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
			require.True(t, body.Success)
			assert.Equal(t, tc.total, body.Data.Total)
			assert.Equal(t, tc.typeCounts, body.Data.TypeCounts)
			ids := make([]int, 0, len(body.Data.Items))
			for _, item := range body.Data.Items {
				ids = append(ids, item.ID)
			}
			assert.ElementsMatch(t, tc.items, ids)
		})
	}
	for _, handler := range []gin.HandlerFunc{GetAllChannels, SearchChannels} {
		response := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(response)
		context.Request = httptest.NewRequest(http.MethodGet, "/api/channel/?pikno_view=unsupported", nil)
		handler(context)
		assert.Equal(t, http.StatusBadRequest, response.Code)
	}
}

func TestPiknoRHConnectionsTagActionsRefuseBeforeMutation(t *testing.T) {
	setupPiknoRHConnectionFixture(t)
	for _, tc := range []struct {
		name    string
		handler gin.HandlerFunc
		body    string
	}{
		{"disable", DisableTagChannels, `{"tag":"fixture-tag-01"}`},
		{"enable", EnableTagChannels, `{"tag":"fixture-tag-01"}`},
		{"edit", EditTagChannels, `{"tag":"fixture-tag-01","new_tag":"fixture-renamed","groups":"video-standard"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			context, _ := gin.CreateTestContext(response)
			context.Request = httptest.NewRequest(http.MethodPost, "/api/channel/tag", strings.NewReader(tc.body))
			context.Request.Header.Set("Content-Type", "application/json")
			tc.handler(context)
			assert.Equal(t, http.StatusConflict, response.Code)
			assert.Contains(t, response.Body.String(), `"success":false`)
		})
	}
}
