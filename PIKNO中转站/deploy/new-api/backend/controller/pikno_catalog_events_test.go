package controller

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestPiknoCatalogEventHubReplacesSlowConsumer(t *testing.T) {
	listener := make(chan string, 1)
	hub := &piknoCatalogEventHub{listeners: map[chan string]struct{}{listener: {}}}
	hub.publish(strings.Repeat("a", 64))
	hub.publish(strings.Repeat("b", 64))
	require.Equal(t, strings.Repeat("b", 64), <-listener)
	hub.unsubscribe(listener)
	hub.publish(strings.Repeat("c", 64))
	require.Empty(t, listener)
}

func TestPiknoCatalogEventsStreamsDigestAndDisconnects(t *testing.T) {
	t.Setenv("PIKNO_LINE_SYNC_ENABLED", "true")
	setupResponsesWSRequestTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.PiknoLine{}, &model.TaskPlugin{}))
	require.NoError(t, model.MigratePiknoLineSync(model.DB))
	previous := piknoCatalogEvents
	hub := &piknoCatalogEventHub{listeners: make(map[chan string]struct{})}
	piknoCatalogEvents = hub
	t.Cleanup(func() { piknoCatalogEvents = previous })
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/events", PiknoCatalogEvents)
	server := httptest.NewServer(router)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/events", nil)
	require.NoError(t, err)
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, 200, response.StatusCode)
	require.Equal(t, "text/event-stream", response.Header.Get("Content-Type"))
	require.Equal(t, "no-store, no-transform", response.Header.Get("Cache-Control"))
	scanner := bufio.NewScanner(response.Body)
	readRevision := func() string {
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "data: ") {
				var data map[string]string
				require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &data))
				require.Len(t, data, 1)
				require.Len(t, data["revision"], 64)
				return data["revision"]
			}
		}
		t.Fatal("expected catalogue revision")
		return ""
	}
	initial := readRevision()
	require.NoError(t, model.DB.Create(&model.PiknoLine{PublicModel: "never-leak-in-event", Version: 1, DraftConfig: "private-configuration-never-emitted"}).Error)
	model.NotifyPiknoCatalogChange()
	require.NotEqual(t, initial, readRevision())
	cancel()
	require.Eventually(t, func() bool {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		return len(hub.listeners) == 0
	}, time.Second, 10*time.Millisecond)
	model.NotifyPiknoCatalogChange()
	require.Eventually(t, func() bool {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		return !hub.running
	}, time.Second, 10*time.Millisecond)
}
