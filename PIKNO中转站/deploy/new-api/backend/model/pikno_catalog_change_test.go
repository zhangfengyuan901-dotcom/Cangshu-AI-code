package model

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPiknoCatalogChangeRevisionIgnoresHeartbeatAndDetectsAvailability(t *testing.T) {
	channel, now := setupPiknoSyncTest(t)
	_, err := applySyncTest(t, channel, now, syncModelBody("a"), true)
	require.NoError(t, err)
	first, err := PiknoCatalogChangeRevision(time.Unix(now, 0))
	require.NoError(t, err)
	require.Len(t, first, 64)
	require.NoError(t, DB.Model(&PiknoSyncProvider{}).Where("provider = ?", "canseedream").Update("last_verified_at", now+1).Error)
	require.NoError(t, DB.Model(&PiknoLineSyncState{}).Where("public_model = ?", "pikno-video-cs-a").Update("last_seen_at", now+1).Error)
	same, err := PiknoCatalogChangeRevision(time.Unix(now+2, 0))
	require.NoError(t, err)
	require.Equal(t, first, same, "routine verification does not trigger catalogue reloads")
	require.NoError(t, DB.Model(&PiknoLineSyncState{}).Where("public_model = ?", "pikno-video-cs-a").Updates(map[string]any{"paused": true, "pause_reason": "disabled"}).Error)
	closed, err := PiknoCatalogChangeRevision(time.Unix(now+2, 0))
	require.NoError(t, err)
	require.NotEqual(t, first, closed)
	stale, err := PiknoCatalogChangeRevision(time.Unix(now+602, 0))
	require.NoError(t, err)
	require.NotEqual(t, closed, stale, "freshness expiry triggers invalidation without changing saved configuration")
	require.NoError(t, DB.Model(&Channel{}).Where("id = ?", channel).Update("status", 2).Error)
	disabledChannel, err := PiknoCatalogChangeRevision(time.Unix(now+602, 0))
	require.NoError(t, err)
	require.NotEqual(t, stale, disabledChannel)
}

func TestPiknoCatalogChangeSignalIsBounded(t *testing.T) {
	for {
		select {
		case <-PiknoCatalogChangeWake():
		default:
			goto drained
		}
	}
drained:
	for i := 0; i < 1000; i++ {
		NotifyPiknoCatalogChange()
	}
	select {
	case <-PiknoCatalogChangeWake():
	default:
		t.Fatal("missing change signal")
	}
	select {
	case <-PiknoCatalogChangeWake():
		t.Fatal("unbounded signal queue")
	default:
	}
}
