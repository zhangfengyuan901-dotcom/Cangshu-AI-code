package router

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestPiknoCatalogSSEActualAPIRouterExcludesCompression(t *testing.T) {
	t.Setenv("PIKNO_LINE_SYNC_ENABLED", "false")
	oldDB := model.DB
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "router-events.db")), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	t.Cleanup(func() {
		model.DB = oldDB
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
	})
	require.NoError(t, db.AutoMigrate(&model.PiknoLine{}, &model.Channel{}))
	gin.SetMode(gin.TestMode)
	router := gin.New()
	SetApiRouter(router)
	server := httptest.NewServer(router)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/pikno/catalog/events", nil)
	require.NoError(t, err)
	request.Header.Set("Accept-Encoding", "gzip")
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
	require.Empty(t, response.Header.Get("Content-Encoding"), "SSE must bypass API-group gzip middleware")
	require.Equal(t, "text/event-stream", response.Header.Get("Content-Type"))
	scanner := bufio.NewScanner(response.Body)
	gotRevision := false
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			var data map[string]string
			require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &data))
			require.Len(t, data, 1)
			require.Len(t, data["revision"], 64)
			gotRevision = true
			break
		}
	}
	require.True(t, gotRevision, "the actual router must flush its first revision before request completion: %v", scanner.Err())
	cancel()
	response.Body.Close()
	// Ordinary API JSON retains the existing compression behavior.
	request, err = http.NewRequest(http.MethodGet, server.URL+"/api/status", nil)
	require.NoError(t, err)
	request.Header.Set("Accept-Encoding", "gzip")
	response, err = client.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, "gzip", response.Header.Get("Content-Encoding"))
}
