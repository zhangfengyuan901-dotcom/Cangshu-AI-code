package router

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type mediaRateFixtureTransport func(*http.Request) (*http.Response, error)

func (f mediaRateFixtureTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPiknoMediaRoutesCompleteFiftyFreshAssetsWithoutSharingCriticalBudget(t *testing.T) {
	t.Setenv("PIKNO_MEDIA_ENABLED", "true")
	t.Setenv("PIKNO_MEDIA_TICKET_KEY", "synthetic-media-rate-limit-secret-1234567890")
	oldDB, oldLogDB, oldRedis, oldType, oldLogType, oldMaster := model.DB, model.LOG_DB, common.RedisEnabled, common.MainDatabaseType(), common.LogDatabaseType(), common.IsMasterNode
	oldEnabled, oldNum, oldDuration := common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.Token{}))
	model.DB, model.LOG_DB, common.RedisEnabled = db, db, false
	common.IsMasterNode = false
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	t.Setenv("LOG_SQL_DSN", "")
	require.NoError(t, model.InitLogDB())
	common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = true, 20, 1200
	t.Cleanup(func() {
		model.DB, model.LOG_DB, common.RedisEnabled = oldDB, oldLogDB, oldRedis
		common.SetMainDatabaseType(oldType)
		common.SetLogDatabaseType(oldLogType)
		common.IsMasterNode = oldMaster
		common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = oldEnabled, oldNum, oldDuration
		sqlDB, _ := db.DB()
		_ = sqlDB.Close()
	})
	for i, key := range []string{"media74routeone", "media74routetwo"} {
		user := model.User{Id: 740100 + i, Username: key, AffCode: key, Group: "default", Status: common.UserStatusEnabled, Quota: 100, Role: common.RoleCommonUser}
		require.NoError(t, db.Create(&user).Error)
		require.NoError(t, db.Create(&model.Token{UserId: user.Id, Key: key, Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}).Error)
	}
	oldTransport := http.DefaultTransport
	inspections := 0
	http.DefaultTransport = mediaRateFixtureTransport(func(r *http.Request) (*http.Response, error) {
		require.Equal(t, "www.piknoai.com", r.URL.Host)
		require.True(t, strings.HasSuffix(r.URL.Path, "/inspect"))
		require.Equal(t, http.MethodPost, r.Method)
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		require.Len(t, parts, 2)
		payload, err := base64.RawURLEncoding.DecodeString(parts[0])
		require.NoError(t, err)
		var claims struct {
			ID     string `json:"id"`
			UserID int    `json:"uid"`
			MIME   string `json:"mime"`
			Size   int    `json:"size"`
		}
		require.NoError(t, common.Unmarshal(payload, &claims))
		inspections++
		body, err := common.Marshal(map[string]any{"id": claims.ID, "owner_id": claims.UserID, "content_type": claims.MIME, "size": claims.Size, "status": "ready"})
		require.NoError(t, err)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(body))}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = oldTransport })
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	setPiknoMediaRoutes(engine)
	send := func(endpoint, key string, body map[string]any) *httptest.ResponseRecorder {
		raw, err := common.Marshal(body)
		require.NoError(t, err)
		request := httptest.NewRequest(http.MethodPost, endpoint, bytes.NewReader(raw))
		request.Header.Set("Content-Type", "application/json")
		if key != "" {
			request.Header.Set("Authorization", "Bearer "+key)
		}
		result := httptest.NewRecorder()
		engine.ServeHTTP(result, request)
		return result
	}
	for range 61 {
		require.Equal(t, http.StatusUnauthorized, send("/v1/media/uploads", "", map[string]any{}).Code)
	}
	key := "media74routeone"
	var firstTicket string
	for n := 0; n < 60; n++ {
		upload := send("/v1/media/uploads", key, map[string]any{"content_type": "image/png", "size": 68})
		require.Equal(t, http.StatusCreated, upload.Code, upload.Body.String())
		var ticket struct {
			Ticket string `json:"upload_ticket"`
		}
		require.NoError(t, common.Unmarshal(upload.Body.Bytes(), &ticket))
		if n == 0 {
			firstTicket = ticket.Ticket
		}
		complete := send("/v1/media/complete", key, map[string]any{"upload_ticket": ticket.Ticket})
		require.Equal(t, http.StatusOK, complete.Code, complete.Body.String())
	}
	require.Equal(t, 60, inspections, "all 50 batch assets plus 10 headroom assets reach real completion handling")
	for _, endpoint := range []string{"/v1/media/uploads", "/v1/media/complete"} {
		limited := send(endpoint, key, map[string]any{})
		require.Equal(t, http.StatusTooManyRequests, limited.Code)
		require.Equal(t, "60", limited.Header().Get("Retry-After"))
	}
	upload := send("/v1/media/uploads", "media74routetwo", map[string]any{"content_type": "image/png", "size": 68})
	require.Equal(t, http.StatusCreated, upload.Code, upload.Body.String())
	foreign := send("/v1/media/complete", "media74routetwo", map[string]any{"upload_ticket": firstTicket})
	require.Equal(t, http.StatusForbidden, foreign.Code)
	require.Equal(t, 60, inspections, "foreign ownership fails before storage access")
}
