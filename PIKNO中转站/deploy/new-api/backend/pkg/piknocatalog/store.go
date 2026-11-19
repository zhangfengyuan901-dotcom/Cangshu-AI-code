package piknocatalog

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
)

var ErrConflict = errors.New("Catalog changed. Refresh and review again")
var ErrBusy = errors.New("Catalog sync is already running or was requested within the last minute")

type Event struct {
	At       string `json:"at"`
	Actor    int    `json:"actor"`
	Action   string `json:"action"`
	Revision string `json:"revision"`
}
type State struct {
	Revision  string    `json:"revision"`
	Published *Snapshot `json:"published"`
	Draft     *Snapshot `json:"draft"`
	Previous  *Snapshot `json:"previous"`
	Events    []Event   `json:"events"`
}
type Store struct {
	mu          sync.RWMutex
	syncMu      sync.Mutex
	path        string
	state       *State
	lastAttempt time.Time
	Fetch       func(context.Context) ([]Entry, error)
}

func NewStore(path string) *Store { return &Store{path: path, Fetch: Fetch} }
func revision(value any) string {
	body, _ := common.Marshal(value)
	return fmt.Sprintf("%x", sha256.Sum256(body))[:24]
}

func removeRetiredCatalogModels(state *State) {
	changed := false
	for _, target := range []**Snapshot{&state.Published, &state.Draft, &state.Previous} {
		snapshot := *target
		if snapshot == nil || !slices.ContainsFunc(snapshot.Models, IsRetiredEntry) {
			continue
		}
		next := *snapshot
		next.Models = slices.DeleteFunc(slices.Clone(snapshot.Models), IsRetiredEntry)
		next.Revision = ""
		next.Revision = revision(next)
		*target = &next
		changed = true
	}
	if changed {
		state.Revision = revision([]any{state.Revision, state.Published, state.Draft, state.Previous})
	}
}

func (s *Store) loadLocked() error {
	if s.state != nil {
		removeRetiredCatalogModels(s.state)
		return nil
	}
	body, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.state = &State{Revision: "empty", Events: []Event{}}
		return nil
	}
	if err != nil {
		return errors.New("Catalog storage unavailable")
	}
	var state State
	if len(body) > 8*1024*1024 || common.Unmarshal(body, &state) != nil || state.Revision == "" {
		return errors.New("Catalog storage invalid; restore a verified backup")
	}
	removeRetiredCatalogModels(&state)
	s.state = &state
	return nil
}
func (s *Store) Read() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return State{}, err
	}
	body, err := common.Marshal(s.state)
	if err != nil {
		return State{}, err
	}
	var copy State
	err = common.Unmarshal(body, &copy)
	return copy, err
}
func (s *Store) commitLocked(next State, actor int, action string) error {
	removeRetiredCatalogModels(&next)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	next.Revision = revision([]any{next.Revision, action, now})
	next.Events = append(slices.Clone(next.Events), Event{now, actor, action, next.Revision})
	if len(next.Events) > 30 {
		next.Events = next.Events[len(next.Events)-30:]
	}
	body, err := common.Marshal(next)
	if err != nil {
		return err
	}
	if len(body) > 8*1024*1024 {
		return errors.New("Catalog storage limit exceeded")
	}
	if err = os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(s.path), ".catalog-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(body)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(file.Name(), s.path); err != nil {
		return err
	}
	// Linux production volume: persist the directory entry as well as the file.
	if dir, openErr := os.Open(filepath.Dir(s.path)); openErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	s.state = &next
	return nil
}
func (s *Store) Sync(ctx context.Context, actor int) (State, error) {
	if !s.syncMu.TryLock() {
		return State{}, ErrBusy
	}
	defer s.syncMu.Unlock()
	if time.Since(s.lastAttempt) < time.Minute {
		return State{}, ErrBusy
	}
	s.lastAttempt = time.Now()
	entries, err := s.Fetch(ctx)
	if err != nil {
		return State{}, err
	}
	entries = slices.DeleteFunc(slices.Clone(entries), IsRetiredEntry)
	if len(entries) == 0 {
		return State{}, errors.New("Empty catalog cannot replace published models")
	}
	s.mu.Lock()
	if err = s.loadLocked(); err != nil {
		s.mu.Unlock()
		return State{}, err
	}
	next := *s.state
	// Preserve removed models visibly as unavailable, never silently delete them.
	ids := map[string]bool{}
	for _, entry := range entries {
		ids[entry.ID] = true
	}
	if next.Published != nil {
		for _, entry := range next.Published.Models {
			if !ids[entry.ID] {
				entry.Available = false
				entries = append(entries, entry)
			}
		}
	}
	slices.SortFunc(entries, func(a, b Entry) int { return strings.Compare(a.ID, b.ID) })
	draft := Snapshot{FetchedAt: time.Now().UTC().Format(time.RFC3339), Models: entries}
	draft.Revision = revision(draft)
	next.Draft = &draft
	err = s.commitLocked(next, actor, "sync")
	s.mu.Unlock()
	if err != nil {
		return State{}, errors.New("Cannot persist catalog draft")
	}
	return s.Read()
}
func (s *Store) Publish(expected string, actor int) (State, error) {
	s.mu.Lock()
	if err := s.loadLocked(); err != nil {
		s.mu.Unlock()
		return State{}, err
	}
	if expected != s.state.Revision || s.state.Draft == nil || len(s.state.Draft.Models) == 0 {
		s.mu.Unlock()
		return State{}, ErrConflict
	}
	next := *s.state
	next.Previous = next.Published
	next.Published = next.Draft
	next.Draft = nil
	err := s.commitLocked(next, actor, "publish")
	s.mu.Unlock()
	if err != nil {
		return State{}, errors.New("Cannot persist catalog publication")
	}
	return s.Read()
}
func (s *Store) Rollback(expected string, actor int) (State, error) {
	s.mu.Lock()
	if err := s.loadLocked(); err != nil {
		s.mu.Unlock()
		return State{}, err
	}
	if expected != s.state.Revision || s.state.Previous == nil || len(s.state.Previous.Models) == 0 {
		s.mu.Unlock()
		return State{}, ErrConflict
	}
	next := *s.state
	next.Published, next.Previous = next.Previous, next.Published
	next.Draft = nil
	err := s.commitLocked(next, actor, "rollback")
	s.mu.Unlock()
	if err != nil {
		return State{}, errors.New("Cannot persist catalog rollback")
	}
	return s.Read()
}

type Change struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Before *Entry `json:"before,omitempty"`
	After  *Entry `json:"after,omitempty"`
}

func Diff(state State) []Change {
	result := []Change{}
	if state.Draft == nil {
		return result
	}
	old := map[string]Entry{}
	if state.Published != nil {
		for _, entry := range state.Published.Models {
			if IsRetiredEntry(entry) {
				continue
			}
			old[entry.ID] = entry
		}
	}
	for _, entry := range state.Draft.Models {
		if IsRetiredEntry(entry) {
			continue
		}
		previous, found := old[entry.ID]
		if !found {
			result = append(result, Change{ID: entry.ID, Kind: "added", After: &entry})
			continue
		}
		if reflect.DeepEqual(previous, entry) {
			continue
		}
		kind := "changed"
		if previous.Available && !entry.Available {
			kind = "removed"
		}
		result = append(result, Change{entry.ID, kind, &previous, &entry})
	}
	return result
}

// Cost fields and operator history never leave the administrator boundary.
func Public(state State) map[string]any {
	rows := []map[string]any{}
	fetched := ""
	rev := "empty"
	if state.Published != nil {
		fetched = state.Published.FetchedAt
		rev = state.Published.Revision
		for _, entry := range state.Published.Models {
			if IsRetiredEntry(entry) {
				continue
			}
			prices := []map[string]any{}
			for _, p := range entry.Prices {
				prices = append(prices, map[string]any{"resolution": p.Resolution, "unit": p.Unit, "retail_cny": p.RetailCNY})
			}
			rows = append(rows, map[string]any{"id": entry.ID, "name": entry.Name, "provider": entry.Provider, "kind": entry.Kind, "upstream_available": entry.Available, "resolutions": entry.Resolutions, "ratios": entry.Ratios, "durations": entry.Durations, "max_images": entry.MaxImages, "max_videos": entry.MaxVideos, "max_audio": entry.MaxAudio, "prices": prices, "price_issue": entry.PriceIssue, "reference_surcharge_cny": entry.ReferenceSurchargeCNY})
		}
	}
	return map[string]any{"revision": rev, "fetched_at": fetched, "models": rows}
}
