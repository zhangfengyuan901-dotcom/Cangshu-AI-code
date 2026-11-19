package controller

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/pkg/piknocatalog"
	"github.com/gin-gonic/gin"
)

var piknoSyncRunMu sync.Mutex
var piknoSyncOwner = model.NewPiknoSyncOwner()
var piknoSyncHTTP = &http.Client{Timeout: 20 * time.Second}
var piknoSyncNow = time.Now

// Guarded by piknoSyncRunMu. Each provider must activate a new complete response
// in this process before scheduled refreshes may reuse its persisted snapshot.
// Manual refreshes always fetch complete facts; cadence and leases still apply.
var piknoSyncParsed = map[string]bool{}

func StartPiknoLineSyncScheduler() {
	if !model.PiknoLineSyncEnabled() {
		return
	}
	for {
		if err := PiknoSyncCatalogOnce(context.Background(), false); err != nil {
			common.SysError("PIKNO line synchronization did not complete")
		}
		var providers []model.PiknoSyncProvider
		delay := time.Second
		if model.DB != nil && model.DB.Select("provider", "next_attempt_at").Where("provider IN ?", model.PiknoLineSyncProviders()).Find(&providers).Error == nil {
			delay = piknoSyncNextDelay(piknoSyncNow(), providers)
		}
		// Persisted completion deadlines also govern manual refreshes. Waking at
		// the earliest deadline avoids skipping a whole 60-second ticker when
		// the preceding request completed after that ticker's start second.
		timer := time.NewTimer(delay)
		<-timer.C
	}
}

func piknoSyncNextDelay(now time.Time, providers []model.PiknoSyncProvider) time.Duration {
	if len(providers) < len(model.PiknoLineSyncProviders()) {
		return time.Second
	}
	delay := 60 * time.Second
	for _, provider := range providers {
		next := time.Unix(provider.NextAttemptAt, 0).Sub(now)
		if next < time.Second {
			next = time.Second
		}
		if next < delay {
			delay = next
		}
	}
	return delay
}

// Manual refresh and periodic refresh share the same coordinator. The process
// mutex avoids redundant work; persistent leases provide cross-node fencing.
func PiknoSyncCatalogOnce(ctx context.Context, manual bool) error {
	if !model.PiknoLineSyncEnabled() {
		return errors.New("line synchronization is disabled")
	}
	piknoSyncRunMu.Lock()
	defer piknoSyncRunMu.Unlock()
	defer model.NotifyPiknoCatalogChange()
	var joined []error
	for _, provider := range model.PiknoLineSyncProviders() {
		now := piknoSyncNow().Unix()
		if !manual {
			var state model.PiknoSyncProvider
			if model.DB.First(&state, "provider = ?", provider).Error == nil && state.NextAttemptAt > now {
				continue
			}
		}
		lease, old, err := model.AcquirePiknoSyncLease(provider, piknoSyncOwner, now)
		if errors.Is(err, model.ErrPiknoSyncLease) {
			continue
		}
		if err != nil {
			joined = append(joined, errors.New("catalog_lease"))
			continue
		}
		needsFull := manual || !piknoSyncParsed[provider]
		conditional := piknocatalog.ConditionalCatalog{ETag: old.ETag, LastModified: old.LastModified}
		if needsFull {
			conditional = piknocatalog.ConditionalCatalog{}
		}
		result, err := piknocatalog.FetchProviderSnapshot(ctx, piknoSyncHTTP, provider, conditional, piknoSyncNow())
		if result.Closures != nil {
			if _, closureErr := model.ApplyPiknoSyncClosures(lease, result.Closures, piknoSyncNow().Unix()); closureErr != nil {
				_ = model.RecordPiknoSyncFailure(lease, "closure_not_activated", piknoSyncNow().Unix())
				joined = append(joined, errors.New("closure_not_activated"))
				continue
			}
		}
		if err != nil || needsFull && result.NotModified {
			_ = model.RecordPiknoSyncFailure(lease, "catalog_unverified", piknoSyncNow().Unix())
			joined = append(joined, errors.New("catalog_unverified"))
			continue
		}
		snapshot := result.Snapshot
		if result.NotModified {
			snapshot, err = model.PiknoSyncLastSnapshot(provider)
			if err == nil {
				snapshot.VerifiedAt = piknoSyncNow().Unix()
				if result.ETag != "" {
					snapshot.ETag = result.ETag
				}
				if result.LastModified != "" {
					snapshot.LastModified = result.LastModified
				}
			}
		}
		if err != nil {
			_ = model.RecordPiknoSyncFailure(lease, "snapshot_missing", piknoSyncNow().Unix())
			joined = append(joined, errors.New("snapshot_missing"))
			continue
		}
		previous, _ := model.PiknoSyncLastSnapshot(provider)
		if err = model.ValidatePiknoSyncSnapshot(previous, snapshot); err != nil {
			_ = model.RecordPiknoSyncFailure(lease, "catalog_shrink_anomaly", piknoSyncNow().Unix())
			joined = append(joined, errors.New("catalog_shrink_anomaly"))
			continue
		}
		models, err := model.PiknoSyncRetainedModels(old)
		if err != nil {
			_ = model.RecordPiknoSyncFailure(lease, "adapter_state_invalid", piknoSyncNow().Unix())
			joined = append(joined, errors.New("adapter_state_invalid"))
			continue
		}
		seeds := make([]model.PiknoLineSeed, 0, len(snapshot.Items))
		for _, item := range snapshot.Items {
			seed, convertErr := catalogEntrySeed(item.Entry, piknoSyncNow().UTC().Format(time.RFC3339))
			if convertErr != nil {
				err = convertErr
				break
			}
			seeds = append(seeds, seed)
			if item.Adapter != nil {
				models[item.Entry.ID] = *item.Adapter
			}
		}
		if err != nil {
			_ = model.RecordPiknoSyncFailure(lease, "catalog_seed_invalid", piknoSyncNow().Unix())
			joined = append(joined, errors.New("catalog_seed_invalid"))
			continue
		}
		source, version, hash, err := piknocatalog.GenerateSyncPlugin(provider, models)
		if err == nil {
			err = model.ApplyPiknoSyncSnapshot(lease, snapshot, seeds, source, version, hash, models, !result.NotModified, piknoSyncNow().Unix())
		}
		if err != nil {
			_ = model.RecordPiknoSyncFailure(lease, "snapshot_not_activated", piknoSyncNow().Unix())
			joined = append(joined, errors.New("snapshot_not_activated"))
			continue
		}
		if !result.NotModified {
			piknoSyncParsed[provider] = true
		}
	}
	// Existing synchronization compiles changed source only and swaps a complete
	// registry generation. Per-node submit guards check the exact loaded version;
	// a retained incumbent or partial generation cannot authorize the new data.
	SyncTaskPluginsOnce()
	return errors.Join(joined...)
}

func piknoSyncRequestPluginReady(c *gin.Context, line *model.PiknoLineConfig) bool {
	expected := model.PiknoSyncExpectedPlugin(line)
	if expected == "" {
		return !model.PiknoLineSyncEnabled() || line.Provider != "sanbao" && line.Provider != "canseedream"
	}
	for _, key := range []string{jsplugin.ContextKeyPinnedPlugin, jsplugin.ContextKeyPinnedEndpoint, jsplugin.ContextKeyPinnedRoute} {
		value, exists := c.Get(key)
		if !exists {
			continue
		}
		switch pinned := value.(type) {
		case jsplugin.PinnedPlugin:
			return pinned.Plugin != nil && pinned.Plugin.Meta.Key == line.PluginKey && pinned.Plugin.Meta.Version == expected
		case jsplugin.PinnedEndpoint:
			return pinned.Plugin != nil && pinned.Plugin.Meta.Key == line.PluginKey && pinned.Plugin.Meta.Version == expected
		case jsplugin.PinnedRoute:
			return pinned.Plugin != nil && pinned.Plugin.Meta.Key == line.PluginKey && pinned.Plugin.Meta.Version == expected
		default:
			return false
		}
	}
	plugin, ok := jsplugin.DefaultRegistry.Get(line.PluginKey)
	return ok && plugin.Meta.Version == expected
}

// Runs after endpoint pinning and channel selection, before any task driver or
// billing work. A registry refresh cannot switch this request to a new adapter.
func PiknoSyncDispatchGuard(c *gin.Context) {
	value, exists := c.Get("pikno_sync_expected_line")
	if !exists {
		c.Next()
		return
	}
	line, ok := value.(*model.PiknoLineConfig)
	if !ok || !piknoSyncRequestPluginReady(c, line) || model.PiknoSyncLineReadyTx(model.DB, line, time.Now().Unix()) != nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"message": "Line update is not ready; no task was submitted", "type": "line_update_pending"}})
		return
	}
	c.Next()
}

func piknoSyncErrorCode(err error) string {
	if err == nil {
		return ""
	}
	code := err.Error()
	if strings.ContainsAny(code, " /\n\r") || len(code) > 48 {
		return "catalog_unverified"
	}
	return code
}
