package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type parserSyncFixture struct {
	now     time.Time
	mode    string
	calls   map[string]int
	headers map[string]http.Header
}

func newParserSyncFixture(t *testing.T) *parserSyncFixture {
	t.Helper()
	t.Setenv("PIKNO_LINE_SYNC_ENABLED", "true")
	setupResponsesWSRequestTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.PiknoLine{}, &model.TaskPlugin{}))
	require.NoError(t, model.MigratePiknoLineSync(model.DB))
	oldHTTP, oldNow, oldRegistry, oldParsed := piknoSyncHTTP, piknoSyncNow, jsplugin.DefaultRegistry, piknoSyncParsed
	t.Cleanup(func() {
		piknoSyncHTTP = oldHTTP
		piknoSyncNow = oldNow
		jsplugin.DefaultRegistry = oldRegistry
		piknoSyncParsed = oldParsed
	})
	jsplugin.DefaultRegistry = jsplugin.NewRegistry()
	piknoSyncParsed = map[string]bool{}
	base, setting := "https://see.ximeiedu.org", `{"task_plugin_key":"pikno-canseedream"}`
	channel := model.Channel{Type: constant.ChannelTypeTaskPlugin, Key: "synthetic-only", Name: "parser-sync", Status: common.ChannelStatusEnabled, BaseURL: &base, Setting: &setting}
	require.NoError(t, channel.Insert())
	f := &parserSyncFixture{now: time.Now(), mode: "old", calls: map[string]int{}, headers: map[string]http.Header{}}
	piknoSyncNow = func() time.Time { return f.now }
	piknoSyncHTTP = &http.Client{Transport: sync37Transport(func(r *http.Request) (*http.Response, error) {
		provider := "sanbao"
		if r.URL.Host == "see.ximeiedu.org" {
			provider = "canseedream"
		}
		f.calls[provider]++
		f.headers[provider] = r.Header.Clone()
		body := `{"data":[{"id":"fixture_a","type":"video","enabled":true,"billing":"per_second","price_per_second_credits":1,"resolutions":["720p"],"ratios":["16:9"],"durations":[4]}]}`
		status := 200
		if provider == "canseedream" {
			body = `{"defaults":{"pointPricing":{"pointsPerYuan":100},"videoProviders":[{"id":"fixture_b","protocolLine":true,"providerRoute":"provider_router","providerLine":"fixture_b","pricingMode":"fixed","pointsCost":50,"allowedResolutions":["720p"],"allowedDurations":[4],"limits":{"maxImages":2}}]PROFILE}}`
			profile := `,"protocolLines":[{"id":"fixture_b","profile":{"ratios":["16:9","9:16"],"resolutions":["720p"],"durations":[4],"allowTextOnly":true,"allowAudioOnly":true}}]`
			if f.mode == "old" {
				profile = `,"protocolLines":[{"id":"fixture_b","profile":{"allowTextOnly":true,"allowAudioOnly":true}}]`
			}
			body = strings.Replace(body, "PROFILE", profile, 1)
			switch f.mode {
			case "failed":
				status = 502
				body = "unavailable"
			case "unexpected-304":
				status = 304
				body = ""
			case "invalid":
				body = `{"defaults":{"videoProviders":"invalid"}}`
			}
		}
		if f.mode == "conditional" || provider == "sanbao" && f.mode != "old" && r.Header.Get("If-None-Match") != "" {
			require.Equal(t, `"stable-etag"`, r.Header.Get("If-None-Match"))
			require.Equal(t, "Fri, 23 Oct 2026 00:00:00 GMT", r.Header.Get("If-Modified-Since"))
			status = 304
			body = ""
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Etag": []string{`"stable-etag"`}, "Last-Modified": []string{"Fri, 23 Oct 2026 00:00:00 GMT"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), true))
	require.True(t, piknoSyncParsed["canseedream"])
	return f
}

func (f *parserSyncFixture) restart() {
	piknoSyncParsed = map[string]bool{}
	f.now = f.now.Add(60 * time.Second)
	f.mode = "fresh"
}
func (f *parserSyncFixture) assertUnconditional(t *testing.T) {
	t.Helper()
	require.Empty(t, f.headers["canseedream"].Get("If-None-Match"))
	require.Empty(t, f.headers["canseedream"].Get("If-Modified-Since"))
}

func TestPiknoSyncParserRefreshesPersistedSnapshotBefore304(t *testing.T) {
	f := newParserSyncFixture(t)
	view, err := model.GetPiknoLineAdmin("pikno-video-cs-fixture_b", 0)
	require.NoError(t, err)
	require.Empty(t, view.Draft.Ratios)
	prices := view.Draft.Prices
	prices[0].RetailQuota = 1_700_000
	view, err = model.UpdatePiknoLineDraft(view.PublicModel, model.PiknoLinePatch{ExpectedVersion: view.Version, Prices: &prices}, 7)
	require.NoError(t, err)
	view, err = model.PublishPiknoLine(view.PublicModel, view.Version, 7)
	require.NoError(t, err)
	require.True(t, view.Published.Enabled)
	f.restart()
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), false))
	f.assertUnconditional(t)
	require.True(t, piknoSyncParsed["canseedream"])
	view, err = model.GetPiknoLineAdmin(view.PublicModel, 0)
	require.NoError(t, err)
	require.Equal(t, []string{"16:9", "9:16"}, view.Published.Ratios)
	require.Equal(t, 1_700_000, view.Published.Prices[0].RetailQuota)
	require.True(t, view.Published.Enabled)
	_, err = model.GetPiknoLineAdmin("pikno-video-sb-fixture_a", 0)
	require.ErrorIs(t, err, model.ErrPiknoLineNotFound)
	require.Zero(t, f.calls["sanbao"], "retired suppliers must never be fetched or imported")
	f.now = f.now.Add(60 * time.Second)
	f.mode = "conditional"
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), false))
	require.Equal(t, 3, f.calls["canseedream"])
}

func TestPiknoSyncFirstProviderAndManualRefreshRequireComplete200(t *testing.T) {
	f := newParserSyncFixture(t)
	// A new process must not trust a persisted validator before one complete
	// response from the remaining provider has been activated.
	f.restart()
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), false))
	for _, provider := range model.PiknoLineSyncProviders() {
		require.Empty(t, f.headers[provider].Get("If-None-Match"))
		require.Empty(t, f.headers[provider].Get("If-Modified-Since"))
		require.True(t, piknoSyncParsed[provider])
	}
	f.now = f.now.Add(60 * time.Second)
	f.mode = "conditional"
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), false))
	for _, provider := range model.PiknoLineSyncProviders() {
		require.Equal(t, `"stable-etag"`, f.headers[provider].Get("If-None-Match"))
		require.Equal(t, "Fri, 23 Oct 2026 00:00:00 GMT", f.headers[provider].Get("If-Modified-Since"))
	}
	f.now = f.now.Add(60 * time.Second)
	f.mode = "fresh"
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), true))
	for _, provider := range model.PiknoLineSyncProviders() {
		require.Empty(t, f.headers[provider].Get("If-None-Match"))
		require.Empty(t, f.headers[provider].Get("If-Modified-Since"))
		require.Equal(t, 4, f.calls[provider])
	}
}

func TestPiknoSyncParserFailureNeverEnablesConditionalReuse(t *testing.T) {
	for _, mode := range []string{"failed", "unexpected-304", "invalid", "activation-failed"} {
		t.Run(mode, func(t *testing.T) {
			f := newParserSyncFixture(t)
			var before model.PiknoSyncProvider
			require.NoError(t, model.DB.First(&before, "provider = ?", "canseedream").Error)
			f.restart()
			f.mode = mode
			if mode == "activation-failed" {
				require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register("test:parser_activation_failure", func(tx *gorm.DB) {
					values, ok := tx.Statement.Dest.(map[string]interface{})
					if tx.Statement.Table == "pikno_sync_providers" && ok && values["state"] == "ready" {
						tx.AddError(errors.New("synthetic activation failure"))
					}
				}))
			}
			require.Error(t, PiknoSyncCatalogOnce(context.Background(), true))
			f.assertUnconditional(t)
			require.False(t, piknoSyncParsed["canseedream"])
			if mode == "activation-failed" {
				require.NoError(t, model.DB.Callback().Update().Remove("test:parser_activation_failure"))
			}
			var after model.PiknoSyncProvider
			require.NoError(t, model.DB.First(&after, "provider = ?", "canseedream").Error)
			require.Equal(t, before.LastVerifiedAt, after.LastVerifiedAt)
			f.now = f.now.Add(60 * time.Second)
			f.mode = "fresh"
			require.NoError(t, PiknoSyncCatalogOnce(context.Background(), true))
			f.assertUnconditional(t)
			require.True(t, piknoSyncParsed["canseedream"])
		})
	}
}

func TestPiknoSyncParserRefreshKeepsCadenceAndLease(t *testing.T) {
	f := newParserSyncFixture(t)
	piknoSyncParsed = map[string]bool{}
	f.mode = "fresh"
	for _, manual := range []bool{false, true} {
		require.NoError(t, PiknoSyncCatalogOnce(context.Background(), manual))
	}
	require.Equal(t, 1, f.calls["canseedream"])
	require.False(t, piknoSyncParsed["canseedream"])
	f.now = f.now.Add(60 * time.Second)
	require.NoError(t, model.DB.Model(&model.PiknoSyncProvider{}).Where("provider = ?", "canseedream").Updates(map[string]any{"lease_owner": "another-process", "lease_until": f.now.Add(90 * time.Second).Unix()}).Error)
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), true))
	require.Equal(t, 1, f.calls["canseedream"])
	require.False(t, piknoSyncParsed["canseedream"])
	f.now = f.now.Add(91 * time.Second)
	require.NoError(t, PiknoSyncCatalogOnce(context.Background(), true))
	f.assertUnconditional(t)
	require.True(t, piknoSyncParsed["canseedream"])
}
