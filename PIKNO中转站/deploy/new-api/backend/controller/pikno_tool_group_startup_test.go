package controller

import (
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/QuantumNous/new-api/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Both persisted representations must contain the tool group: startup and the
// periodic option refresh replace the same runtime map from either key. The
// migration, not a frontend-only option, supplies this synchronized state.
func TestPiknoToolGroupStartup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previousRatios := ratio_setting.GroupRatio2JSONString()
	previousGroupRatios := ratio_setting.GroupGroupRatio2JSONString()
	previousUsable := setting.UserUsableGroups2JSONString()
	previousSpecial, err := common.Marshal(ratio_setting.GetGroupRatioSetting().GroupSpecialUsableGroup.ReadAll())
	require.NoError(t, err)
	common.OptionMapRWMutex.RLock()
	previousOptions := maps.Clone(common.OptionMap)
	common.OptionMapRWMutex.RUnlock()
	t.Cleanup(func() {
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(previousRatios))
		require.NoError(t, ratio_setting.UpdateGroupGroupRatioByJSONString(previousGroupRatios))
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(previousUsable))
		require.NoError(t, types.LoadFromJsonString(ratio_setting.GetGroupRatioSetting().GroupSpecialUsableGroup, string(previousSpecial)))
		common.OptionMapRWMutex.Lock()
		common.OptionMap = previousOptions
		common.OptionMapRWMutex.Unlock()
	})

	const ratios = `{"default":1,"image-standard":1.25,"video-standard":0.8,"tool-standard":1,"internal-only":2}`
	for _, reverse := range []bool{false, true} {
		order := "legacy-first"
		if reverse {
			order = "canonical-first"
		}
		for _, tc := range []struct {
			name, usable, special string
			want                  []string
		}{
			{"all customer groups", `{"image-standard":"Images","video-standard":"Video","tool-standard":"Tools","unpriced":"Unavailable"}`, `{}`, []string{"default", "image-standard", "video-standard", "tool-standard"}},
			{"tools do not grant image or video access", `{"tool-standard":"Tools"}`, `{}`, []string{"default", "tool-standard"}},
			{"image and video grants do not grant tools", `{"image-standard":"Images","video-standard":"Video"}`, `{}`, []string{"default", "image-standard", "video-standard"}},
			{"per-user tool denial is retained", `{"image-standard":"Images","video-standard":"Video","tool-standard":"Tools"}`, `{"default":{"-:tool-standard":"Denied"}}`, []string{"default", "image-standard", "video-standard"}},
			{"per-user grant still needs a configured ratio", `{}`, `{"default":{"+:tool-standard":"Tools","+:unpriced":"Unavailable"}}`, []string{"default", "tool-standard"}},
		} {
			t.Run(order+"/"+tc.name, func(t *testing.T) {
				dialect := os.Getenv("TEST_SECURITY_DIALECT")
				if dialect != "" && dialect != "sqlite" {
					require.Contains(t, []string{"mysql", "postgres"}, dialect)
					// This existing helper permits only loopback, creates a new
					// database, and never mutates a caller-supplied database.
					_, isolatedDSN := newAuditTestDatabase(t, dialect, os.Getenv("TEST_"+strings.ToUpper(dialect)+"_DSN"))
					t.Setenv("TEST_RESPONSES_SQL_DSN", isolatedDSN)
				} else {
					t.Setenv("TEST_RESPONSES_SQL_DSN", "")
				}
				t.Setenv("TEST_RESPONSES_LOG_SQL_DSN", "")
				user, _ := setupResponsesWSRequestTest(t)
				require.NoError(t, model.DB.AutoMigrate(&model.Option{}))
				rows := []model.Option{
					{Key: "GroupRatio", Value: ratios},
					{Key: "group_ratio_setting.group_ratio", Value: ratios},
				}
				if reverse {
					rows[0], rows[1] = rows[1], rows[0]
				}
				rows = append(rows,
					model.Option{Key: "UserUsableGroups", Value: tc.usable},
					model.Option{Key: "group_ratio_setting.group_special_usable_group", Value: tc.special},
					model.Option{Key: "group_ratio_setting.group_group_ratio", Value: `{}`},
				)
				for _, row := range rows {
					require.NoError(t, model.DB.Create(&row).Error)
				}
				versionQuery := "SELECT VERSION()"
				if dialect == "" || dialect == "sqlite" {
					versionQuery = "SELECT sqlite_version()"
				}
				var version string
				require.NoError(t, model.DB.Raw(versionQuery).Scan(&version).Error)
				t.Logf("database: %s %s", model.DB.Dialector.Name(), version)

				// No channels or abilities are required for Key-group selection.
				for range 2 {
					model.InitOptionMap()
					response := httptest.NewRecorder()
					context, _ := gin.CreateTestContext(response)
					context.Request = httptest.NewRequest(http.MethodGet, "/api/user/self/groups", nil)
					context.Set("id", user.Id)
					GetUserGroups(context)
					require.Equal(t, http.StatusOK, response.Code)
					var body struct {
						Success bool `json:"success"`
						Data    map[string]struct {
							Ratio float64 `json:"ratio"`
						} `json:"data"`
					}
					require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
					require.True(t, body.Success)
					assert.ElementsMatch(t, tc.want, slices.Collect(maps.Keys(body.Data)))
					for _, group := range []string{"default", "image-standard", "video-standard", "tool-standard", "internal-only", "unpriced"} {
						_, listed := body.Data[group]
						assert.Equal(t, listed, service.IsUserSelectableGroup(user.Group, group), group)
					}
					for _, group := range tc.want {
						assert.Equal(t, ratio_setting.GetGroupRatio(group), body.Data[group].Ratio, group)
					}
					// Adding tools must preserve the unrelated configured ratios.
					assert.Equal(t, 1.25, ratio_setting.GetGroupRatio("image-standard"))
					assert.Equal(t, 0.8, ratio_setting.GetGroupRatio("video-standard"))
					assert.Equal(t, 2.0, ratio_setting.GetGroupRatio("internal-only"))
				}
			})
		}
	}
}
