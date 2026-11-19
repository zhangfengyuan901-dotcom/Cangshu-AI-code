package model

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/piknocatalog"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func closureBatch(ids ...string) *piknocatalog.AvailabilityClosures {
	return &piknocatalog.AvailabilityClosures{Provider: "canseedream", ClosedIDs: ids}
}

type closureTransport func(*http.Request) (*http.Response, error)

func (f closureTransport) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestPiknoSyncClosuresRetireCurrentConfiguration(t *testing.T) {
	channel, now := setupPiknoSyncTest(t)
	_, err := applySyncTest(t, channel, now, syncModelBody("a", "b"), true)
	require.NoError(t, err)
	syncOpenDraft(t, "pikno-video-cs-a")
	syncOpenDraft(t, "pikno-video-cs-b")
	before, err := GetPiknoLineAdmin("pikno-video-cs-a", 0)
	require.NoError(t, err)
	prices := append([]PiknoLinePrice(nil), before.Published.Prices...)
	prices[0].RetailQuota = 1_900_000
	before, err = UpdatePiknoLineDraft(before.PublicModel, PiknoLinePatch{ExpectedVersion: before.Version, Prices: &prices}, 7)
	require.NoError(t, err)
	var oldRow PiknoLine
	require.NoError(t, DB.First(&oldRow, "public_model = ?", before.PublicModel).Error)
	var oldProvider PiknoSyncProvider
	require.NoError(t, DB.Model(&PiknoSyncProvider{}).Where("provider = ?", "canseedream").Updates(map[string]any{"e_tag": `"old-enabled-snapshot"`, "last_modified": "Wed, 21 Oct 2026 00:00:00 GMT"}).Error)
	require.NoError(t, DB.First(&oldProvider, "provider = ?", "canseedream").Error)
	var pluginCount int64
	require.NoError(t, DB.Model(&TaskPlugin{}).Count(&pluginCount).Error)
	lease, _, err := AcquirePiknoSyncLease("canseedream", "close-worker", now+60)
	require.NoError(t, err)
	changed, err := ApplyPiknoSyncClosures(lease, closureBatch("canseedream/video/a", "canseedream/video/unknown"), now+61)
	require.NoError(t, err)
	require.Equal(t, 1, changed)
	var afterRow PiknoLine
	require.ErrorIs(t, DB.First(&afterRow, "public_model = ?", oldRow.PublicModel).Error, gorm.ErrRecordNotFound)
	state := PiknoLineSyncAdmin(oldRow.PublicModel)
	require.True(t, state.Paused)
	require.Equal(t, "disabled", state.PauseReason)
	require.Zero(t, state.MissingCount)
	require.Empty(t, state.SnapshotHash)
	require.Equal(t, oldRow.Version, state.RetiredRevision)
	require.Equal(t, before.Sync.LastSeenAt, state.LastSeenAt)
	_, err = GetPublishedPiknoLine(oldRow.PublicModel)
	require.Error(t, err)
	_, err = GetPublishedPiknoLine("pikno-video-cs-b")
	require.NoError(t, err)
	public, err := ListPublishedPiknoLines()
	require.NoError(t, err)
	require.Len(t, public, 1)
	require.Equal(t, "pikno-video-cs-b", public[0].PublicModel)
	var provider PiknoSyncProvider
	require.NoError(t, DB.First(&provider, "provider = ?", "canseedream").Error)
	require.Equal(t, oldProvider.LastVerifiedAt, provider.LastVerifiedAt)
	require.Equal(t, oldProvider.SnapshotHash, provider.SnapshotHash)
	require.Empty(t, provider.ETag, "an old enabled snapshot cannot be replayed via 304 after an independent closure")
	require.Empty(t, provider.LastModified)
	require.Equal(t, lease.Epoch, provider.LeaseEpoch)
	require.Greater(t, provider.LeaseUntil, int64(0))
	var afterPluginCount int64
	require.NoError(t, DB.Model(&TaskPlugin{}).Count(&afterPluginCount).Error)
	require.Equal(t, pluginCount, afterPluginCount)
	// The full invalid response may fail afterward without undoing the closure.
	require.NoError(t, RecordPiknoSyncFailure(lease, "catalog_unverified", now+62))
	require.True(t, PiknoLineSyncAdmin(oldRow.PublicModel).Paused)
	require.NoError(t, DB.First(&provider, "provider = ?", "canseedream").Error)
	require.Empty(t, provider.ETag)
	require.Empty(t, provider.LastModified)
	admin, err := ListPiknoLineAdmin()
	require.NoError(t, err)
	require.Len(t, admin, 1)
}

func TestPiknoSyncClosuresSurviveInvalidOrShrunkCatalog(t *testing.T) {
	channel, now := setupPiknoSyncTest(t)
	_, err := applySyncTest(t, channel, now, syncModelBody("a", "b", "c", "d"), true)
	require.NoError(t, err)
	syncOpenDraft(t, "pikno-video-cs-a")
	invalid := `{"defaults":{"pointPricing":"malformed","videoProviders":[{"id":"a","disabled":true}]}}`
	full, err := piknocatalog.ParseProviderSnapshot("canseedream", []byte(invalid), time.Unix(now+60, 0))
	require.Error(t, err)
	require.Nil(t, full)
	closures, err := piknocatalog.ParseAvailabilityClosures("canseedream", []byte(invalid))
	require.NoError(t, err)
	lease, _, err := AcquirePiknoSyncLease("canseedream", "close-worker", now+60)
	require.NoError(t, err)
	changed, err := ApplyPiknoSyncClosures(lease, closures, now+60)
	require.NoError(t, err)
	require.Equal(t, 1, changed)
	require.NoError(t, RecordPiknoSyncFailure(lease, "catalog_unverified", now+60))
	require.Equal(t, "disabled", PiknoLineSyncAdmin("pikno-video-cs-a").PauseReason)
	for _, id := range []string{"b", "c", "d"} {
		require.Zero(t, PiknoLineSyncAdmin("pikno-video-cs-"+id).MissingCount, "independent close processing never treats omission as removal")
	}
}

func TestPiknoSyncClosuresRequireLiveLeaseAndMatchingProvider(t *testing.T) {
	channel, now := setupPiknoSyncTest(t)
	_, err := applySyncTest(t, channel, now, syncModelBody("a"), true)
	require.NoError(t, err)
	syncOpenDraft(t, "pikno-video-cs-a")
	lease, _, err := AcquirePiknoSyncLease("canseedream", "worker-a", now+60)
	require.NoError(t, err)
	wrong := lease
	wrong.Owner = "worker-b"
	_, err = ApplyPiknoSyncClosures(wrong, closureBatch("canseedream/video/a"), now+60)
	require.ErrorIs(t, err, ErrPiknoSyncLease)
	_, err = ApplyPiknoSyncClosures(lease, &piknocatalog.AvailabilityClosures{Provider: "sanbao", ClosedIDs: []string{"sanbao/a"}}, now+60)
	require.Error(t, err)
	_, err = ApplyPiknoSyncClosures(lease, closureBatch("canseedream/video/../a"), now+60)
	require.Error(t, err)
	require.False(t, PiknoLineSyncAdmin("pikno-video-cs-a").Paused)
	// A future callback clock cannot authorize an already expired real lease.
	require.NoError(t, DB.Model(&PiknoSyncProvider{}).Where("provider = ?", "canseedream").Update("lease_until", time.Now().Unix()-1).Error)
	_, err = ApplyPiknoSyncClosures(lease, closureBatch("canseedream/video/a"), now)
	require.ErrorIs(t, err, ErrPiknoSyncLease)
	require.False(t, PiknoLineSyncAdmin("pikno-video-cs-a").Paused)
	newer, _, err := AcquirePiknoSyncLease("canseedream", "worker-b", now+121)
	require.NoError(t, err)
	require.Greater(t, newer.Epoch, lease.Epoch)
	_, err = ApplyPiknoSyncClosures(lease, closureBatch("canseedream/video/a"), now+121)
	require.ErrorIs(t, err, ErrPiknoSyncLease)
	changed, err := ApplyPiknoSyncClosures(newer, closureBatch("canseedream/video/a"), now+121)
	require.NoError(t, err)
	require.Equal(t, 1, changed)
}

func TestPiknoSyncClosuresDoNotReopenWithoutFullValidation(t *testing.T) {
	channel, now := setupPiknoSyncTest(t)
	_, err := applySyncTest(t, channel, now, syncModelBody("a"), true)
	require.NoError(t, err)
	syncOpenDraft(t, "pikno-video-cs-a")
	lease, _, err := AcquirePiknoSyncLease("canseedream", "worker", now+60)
	require.NoError(t, err)
	changed, err := ApplyPiknoSyncClosures(lease, closureBatch("canseedream/video/a"), now+60)
	require.NoError(t, err)
	require.Equal(t, 1, changed)
	changed, err = ApplyPiknoSyncClosures(lease, closureBatch("canseedream/video/a"), now+60)
	require.NoError(t, err)
	require.Zero(t, changed)
	changed, err = ApplyPiknoSyncClosures(lease, closureBatch(), now+60)
	require.NoError(t, err)
	require.Zero(t, changed)
	require.True(t, PiknoLineSyncAdmin("pikno-video-cs-a").Paused)
	require.NoError(t, RecordPiknoSyncFailure(lease, "catalog_unverified", now+60))
	_, err = applySyncTest(t, channel, now+120, syncModelBody("a"), true)
	require.NoError(t, err)
	require.False(t, PiknoLineSyncAdmin("pikno-video-cs-a").Paused)
	syncOpenDraft(t, "pikno-video-cs-a")
	_, err = GetPublishedPiknoLine("pikno-video-cs-a")
	require.NoError(t, err)
}

func TestPiknoSyncClosuresRequireFresh200BeforeRecovery(t *testing.T) {
	channel, now := setupPiknoSyncTest(t)
	_, err := applySyncTest(t, channel, now, syncModelBody("a"), true)
	require.NoError(t, err)
	syncOpenDraft(t, "pikno-video-cs-a")
	require.NoError(t, DB.Model(&PiknoSyncProvider{}).Where("provider = ?", "canseedream").Updates(map[string]any{"e_tag": `"old-enabled"`, "last_modified": "Wed, 21 Oct 2026 00:00:00 GMT"}).Error)
	lease, _, err := AcquirePiknoSyncLease("canseedream", "worker", now+60)
	require.NoError(t, err)
	changed, err := ApplyPiknoSyncClosures(lease, closureBatch("canseedream/video/a"), now+60)
	require.NoError(t, err)
	require.Equal(t, 1, changed)
	require.NoError(t, RecordPiknoSyncFailure(lease, "catalog_unverified", now+60))
	lease, old, err := AcquirePiknoSyncLease("canseedream", "worker", now+120)
	require.NoError(t, err)
	require.Empty(t, old.ETag)
	require.Empty(t, old.LastModified)
	status := http.StatusNotModified
	client := &http.Client{Transport: closureTransport(func(request *http.Request) (*http.Response, error) {
		require.Empty(t, request.Header.Get("If-None-Match"))
		require.Empty(t, request.Header.Get("If-Modified-Since"))
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(syncModelBody("a"))), Request: request}, nil
	})}
	fetched, err := piknocatalog.FetchProviderSnapshot(context.Background(), client, "canseedream", piknocatalog.ConditionalCatalog{ETag: old.ETag, LastModified: old.LastModified}, time.Unix(now+120, 0))
	require.ErrorContains(t, err, "unexpected_not_modified")
	require.Nil(t, fetched.Snapshot)
	require.True(t, PiknoLineSyncAdmin("pikno-video-cs-a").Paused)
	require.NoError(t, RecordPiknoSyncFailure(lease, "catalog_unverified", now+120))
	lease, old, err = AcquirePiknoSyncLease("canseedream", "worker", now+180)
	require.NoError(t, err)
	status = http.StatusOK
	fetched, err = piknocatalog.FetchProviderSnapshot(context.Background(), client, "canseedream", piknocatalog.ConditionalCatalog{ETag: old.ETag, LastModified: old.LastModified}, time.Unix(now+180, 0))
	require.NoError(t, err)
	require.NotNil(t, fetched.Snapshot)
	models, err := PiknoSyncRetainedModels(old)
	require.NoError(t, err)
	seeds := []PiknoLineSeed{}
	for _, item := range fetched.Snapshot.Items {
		seeds = append(seeds, syncSeed(channel, item))
		if item.Adapter != nil {
			models[item.Entry.ID] = *item.Adapter
		}
	}
	source, version, hash, err := piknocatalog.GenerateSyncPlugin("canseedream", models)
	require.NoError(t, err)
	require.NoError(t, ApplyPiknoSyncSnapshot(lease, fetched.Snapshot, seeds, source, version, hash, models, true, now+180))
	_, err = jsplugin.DefaultRegistry.Register(source, jsplugin.Options{})
	require.NoError(t, err)
	require.False(t, PiknoLineSyncAdmin("pikno-video-cs-a").Paused)
	view, err := GetPiknoLineAdmin("pikno-video-cs-a", 0)
	require.NoError(t, err)
	require.Nil(t, view.Published)
	require.False(t, view.Draft.Enabled)
	require.Zero(t, view.Draft.Prices[0].RetailQuota)
	syncOpenDraft(t, "pikno-video-cs-a")
	line, err := GetPublishedPiknoLine("pikno-video-cs-a")
	require.NoError(t, err)
	require.True(t, line.Enabled)
	require.Equal(t, 1_700_000, line.Prices[0].RetailQuota)
}

func TestPiknoSyncClosuresRepeatedAndUnknownIDsClearConditionalCache(t *testing.T) {
	channel, now := setupPiknoSyncTest(t)
	_, err := applySyncTest(t, channel, now, syncModelBody("a"), true)
	require.NoError(t, err)
	lease, _, err := AcquirePiknoSyncLease("canseedream", "worker", now+60)
	require.NoError(t, err)
	for _, ids := range [][]string{{"canseedream/video/a"}, {"canseedream/video/a"}, {"canseedream/video/not_installed"}} {
		require.NoError(t, DB.Model(&PiknoSyncProvider{}).Where("provider = ?", "canseedream").Updates(map[string]any{"e_tag": `"stale"`, "last_modified": "stale"}).Error)
		_, err := ApplyPiknoSyncClosures(lease, closureBatch(ids...), now+60)
		require.NoError(t, err)
		var provider PiknoSyncProvider
		require.NoError(t, DB.First(&provider, "provider = ?", "canseedream").Error)
		require.Empty(t, provider.ETag)
		require.Empty(t, provider.LastModified)
		require.Equal(t, lease.Epoch, provider.LeaseEpoch)
	}
}
