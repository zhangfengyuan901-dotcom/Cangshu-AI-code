package router

import (
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "path/filepath"
 "reflect"
 "runtime"
 "testing"

 "github.com/QuantumNous/new-api/controller"
 "github.com/QuantumNous/new-api/common"
 "github.com/QuantumNous/new-api/i18n"
 "github.com/QuantumNous/new-api/middleware"
 "github.com/QuantumNous/new-api/model"
 "github.com/QuantumNous/new-api/service"
 "github.com/QuantumNous/new-api/service/authz"
 "github.com/gin-gonic/gin"
 "github.com/glebarez/sqlite"
 "github.com/stretchr/testify/require"
 "gorm.io/gorm"
)

// Exercise the real API registration: handler-only tests cannot detect a
// missing route while the general channel view already excludes RH tools.
func TestHamster52RHActualAPIRoute(t *testing.T) {
 gin.SetMode(gin.TestMode)
 engine := gin.New()
 SetApiRouter(engine)
 const path = "/api/pikno/rh-connections"
 found := 0
 for _, route := range engine.Routes() {
  if route.Path != path { continue }
  found++
  require.Equal(t,http.MethodGet,route.Method)
  require.Equal(t,runtime.FuncForPC(reflect.ValueOf(controller.PiknoRHConnections).Pointer()).Name(),route.Handler)
 }
 require.Equal(t,1,found)
 rule, ok := middleware.AccessTokenRouteRule(http.MethodGet+" "+path)
 require.True(t,ok)
 require.Equal(t,"scope",rule.Kind())
 require.Equal(t,service.AccessTokenScopeOf(authz.ChannelRead),rule.Scope())
 response := httptest.NewRecorder()
 engine.ServeHTTP(response,httptest.NewRequest(http.MethodGet,path,nil))
 require.Equal(t,http.StatusUnauthorized,response.Code)
 response = httptest.NewRecorder()
 engine.ServeHTTP(response,httptest.NewRequest(http.MethodPost,path,nil))
 require.Equal(t,http.StatusNotFound,response.Code)
}

func TestHamster52RHActualAuthenticatedRead(t *testing.T) {
 t.Setenv("PIKNO_LINE_SYNC_ENABLED", "false")
 db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "rh-router.db")), &gorm.Config{})
 require.NoError(t, err)
 oldDB, oldSecret, oldMaster, oldRedis := model.DB, common.SessionSecret, common.IsMasterNode, common.RedisEnabled
 model.DB, common.SessionSecret, common.IsMasterNode, common.RedisEnabled = db, "synthetic-rh-router-secret", true, false
 t.Cleanup(func() { model.DB, common.SessionSecret, common.IsMasterNode, common.RedisEnabled = oldDB, oldSecret, oldMaster, oldRedis; sqlDB, _ := db.DB(); sqlDB.Close() })
 require.NoError(t, i18n.Init())
 require.NoError(t, db.AutoMigrate(&model.User{}, &model.Option{}, &model.UserSession{}, &model.UserAccessToken{}, &model.CasbinRule{}, &model.AuthzRole{}, &model.AuditLog{}, &model.Channel{}))
 require.NoError(t, authz.Init(db))
 user := &model.User{Username: "rh-router-operator", Role: common.RoleAdminUser, Status: common.UserStatusEnabled}
 require.NoError(t, db.Create(user).Error)
 setting := `{"task_plugin_key":"pikno-tools","private":"must-not-return-setting"}`
 channel := &model.Channel{Name:"synthetic RH digital", Type:61, Status:1, Models:"digital,pikno-tool-digital", Group:"tool-standard", Setting:&setting, Key:"must-not-return-key"}
 require.NoError(t, db.Create(channel).Error)
 bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "rh-router-test")
 require.NoError(t, err)
 engine := gin.New()
 SetApiRouter(engine)
 request := func() *httptest.ResponseRecorder {
  req := httptest.NewRequest(http.MethodGet, "/api/pikno/rh-connections", nil)
  req.Header.Set("Authorization", "Bearer "+bundle.AccessToken)
  response := httptest.NewRecorder(); engine.ServeHTTP(response,req); return response
 }
 response := request()
 require.Equal(t,http.StatusOK,response.Code,response.Body.String())
 require.Contains(t,response.Header().Get("Cache-Control"),"no-store")
 var body struct { Success bool `json:"success"`; Data struct { Tools []map[string]any `json:"tools"`; Legacy []map[string]any `json:"legacy"` } `json:"data"` }
 require.NoError(t,json.Unmarshal(response.Body.Bytes(),&body))
 require.True(t,body.Success); require.Len(t,body.Data.Tools,1); require.Empty(t,body.Data.Legacy)
 require.Len(t,body.Data.Tools[0],4)
 require.Equal(t,"digital-human",body.Data.Tools[0]["kind"])
 require.NotContains(t,response.Body.String(),"must-not-return")
 require.NoError(t,db.Model(user).Update("role",common.RoleCommonUser).Error)
 require.Equal(t,http.StatusForbidden,request().Code)
 var after model.Channel
 require.NoError(t,db.First(&after,channel.Id).Error)
 require.Equal(t,channel.Key,after.Key); require.Equal(t,*channel.Setting,*after.Setting); require.Equal(t,channel.Status,after.Status)
}
