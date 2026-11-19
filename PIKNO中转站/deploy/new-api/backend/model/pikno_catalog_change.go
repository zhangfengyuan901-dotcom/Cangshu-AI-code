package model

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

var piknoCatalogChangeWake = make(chan struct{}, 1)

// The signal carries no data. A single process publisher reads committed
// metadata; clients never receive internal models, prices or credentials.
func NotifyPiknoCatalogChange() {
	select {
	case piknoCatalogChangeWake <- struct{}{}:
	default:
	}
}

func PiknoCatalogChangeWake() <-chan struct{} { return piknoCatalogChangeWake }

func PiknoCatalogChangeRevision(now time.Time) (string, error) {
	if DB == nil {
		return "", errors.New("catalog change database unavailable")
	}
	type lineVersion struct {
		PublicModel string
		Version     int64
	}
	type channelState struct {
		Id     int
		Status int
	}
	var lines []lineVersion
	if err := DB.Model(&PiknoLine{}).Select("public_model", "version").Order("public_model").Find(&lines).Error; err != nil {
		return "", err
	}
	var channels []channelState
	if err := DB.Model(&Channel{}).Select("id", "status").Order("id").Find(&channels).Error; err != nil {
		return "", err
	}
	type providerVersion struct {
		Provider, State, SnapshotHash, PluginVersion, ErrorCode string
		Stale                                                   bool
	}
	providers := []providerVersion{}
	states := []PiknoLineSyncState{}
	if PiknoLineSyncEnabled() {
		var rows []PiknoSyncProvider
		if err := DB.Select("provider", "state", "snapshot_hash", "plugin_version", "error_code", "last_verified_at", "started_at").Order("provider").Find(&rows).Error; err != nil {
			return "", err
		}
		for _, row := range rows {
			providers = append(providers, providerVersion{row.Provider, row.State, row.SnapshotHash, row.PluginVersion, row.ErrorCode, piknoSyncStale(row, now.Unix())})
		}
		if err := DB.Select("public_model", "paused", "pause_reason", "cost_changed", "price_issue", "billing_unit", "cost_issue_code", "billing_issue_code", "adapter_issue").Order("public_model").Find(&states).Error; err != nil {
			return "", err
		}
	}
	// JSON is hashed locally. Only its opaque digest leaves the server.
	data, err := json.Marshal(struct {
		Lines     []lineVersion
		Channels  []channelState
		Providers []providerVersion
		States    []PiknoLineSyncState
	}{lines, channels, providers, states})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}
