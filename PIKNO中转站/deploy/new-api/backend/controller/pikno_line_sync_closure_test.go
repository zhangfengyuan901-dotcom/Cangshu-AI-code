package controller

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestPiknoSyncExplicitClosureSurvivesInvalidFullDirectory(t *testing.T) {
	t.Setenv("PIKNO_LINE_SYNC_ENABLED", "true")
	setupResponsesWSRequestTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.PiknoLine{}, &model.TaskPlugin{}))
	require.NoError(t, model.MigratePiknoLineSync(model.DB))
	oldHTTP, oldNow, oldRegistry := piknoSyncHTTP, piknoSyncNow, jsplugin.DefaultRegistry
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	t.Cleanup(func() { piknoSyncHTTP = oldHTTP; piknoSyncNow = oldNow; jsplugin.DefaultRegistry = oldRegistry })
	now := time.Now()
	piknoSyncNow = func() time.Time { return now }
	bad := false
	calls := 0
	piknoSyncHTTP = &http.Client{Transport: sync37Transport(func(request *http.Request) (*http.Response, error) {
		calls++
		body := `{"data":[{"id":"fixture_a","type":"video","enabled":true,"billing":"per_second","price_per_second_credits":1,"resolutions":["720p"],"durations":[4]}]}`
		if request.URL.Host == "see.ximeiedu.org" {
			body = `{"defaults":{"pointPricing":{"pointsPerYuan":100},"videoProviders":[{"id":"fixture_b","providerRoute":"provider_router","providerLine":"fixture_b","pricingMode":"fixed","pointsCost":50,"allowedResolutions":["720p"],"allowedDurations":[4]}],"protocolLines":[{"id":"fixture_b","profile":{"allowTextOnly":true,"allowAudioOnly":true}}]}}`
			if bad {
				body = `{"defaults":{"pointPricing":"malformed","videoProviders":[{"id":"fixture_b","disabled":true,"allowedDurations":"malformed"}]}}`
			}
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Etag": []string{`"fixture-etag"`}}, Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})}
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), true))
	var before model.PiknoSyncProvider
	require.NoError(t, model.DB.First(&before, "provider = ?", "canseedream").Error)
	var lineBefore model.PiknoLine
	require.NoError(t, model.DB.First(&lineBefore, "public_model = ?", "pikno-video-cs-fixture_b").Error)
	now = now.Add(60 * time.Second)
	bad = true
	require.Error(t, PiknoSyncCatalogOnce(context.Background(), true))
	require.Equal(t, 2, calls, "availability does not create an additional upstream request")
	_, err := model.GetPiknoLineAdmin("pikno-video-cs-fixture_b", 0)
	require.ErrorIs(t, err, model.ErrPiknoLineNotFound)
	state := model.PiknoLineSyncAdmin("pikno-video-cs-fixture_b")
	require.True(t, state.Paused)
	require.Equal(t, "disabled", state.PauseReason)
	require.Zero(t, state.MissingCount)
	var after model.PiknoSyncProvider
	require.NoError(t, model.DB.First(&after, "provider = ?", "canseedream").Error)
	require.Equal(t, before.LastVerifiedAt, after.LastVerifiedAt, "invalid full response cannot extend catalogue freshness")
	require.Empty(t, after.ETag, "next request must fetch fresh facts instead of replaying the old enabled snapshot")
	var lineAfter model.PiknoLine
	require.ErrorIs(t, model.DB.First(&lineAfter, "public_model = ?", lineBefore.PublicModel).Error, gorm.ErrRecordNotFound)
}
