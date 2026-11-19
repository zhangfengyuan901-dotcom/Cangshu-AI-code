package piknocatalog

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Executable source is fixed in the application. Provider responses supply JSON
// data only; no provider URL, code or arbitrary hook is evaluated.
//
//go:embed runtime.js
var syncRuntime string

type AdapterDescriptor struct {
	Kind           string         `json:"kind"`
	Path           string         `json:"path"`
	Route          string         `json:"route,omitempty"`
	Line           string         `json:"line,omitempty"`
	UpstreamModel  string         `json:"upstreamModel,omitempty"`
	Qualities      []string       `json:"qualities"`
	Resolutions    []string       `json:"resolutions"`
	Ratios         []string       `json:"ratios"`
	Durations      []float64      `json:"durations"`
	Limits         map[string]int `json:"limits"`
	MaxPrompt      int            `json:"maxPrompt"`
	AllowTextOnly  *bool          `json:"allowTextOnly,omitempty"`
	AllowAudioOnly *bool          `json:"allowAudioOnly,omitempty"`
}
type SyncItem struct {
	Entry        Entry              `json:"entry"`
	Adapter      *AdapterDescriptor `json:"adapter,omitempty"`
	AdapterIssue string             `json:"adapter_issue,omitempty"`
}
type ProviderSnapshot struct {
	Provider     string     `json:"provider"`
	Hash         string     `json:"hash"`
	ETag         string     `json:"etag,omitempty"`
	LastModified string     `json:"last_modified,omitempty"`
	VerifiedAt   int64      `json:"verified_at"`
	Items        []SyncItem `json:"items"`
}
type ConditionalCatalog struct{ ETag, LastModified string }
type SnapshotFetch struct {
	Snapshot           *ProviderSnapshot
	Closures           *AvailabilityClosures
	NotModified        bool
	ETag, LastModified string
}

var syncRouteID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)

func CanonicalDigest(value any) string {
	raw, _ := json.Marshal(value)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

// Upgrade compatibility reads only JSON from the already installed generated
// adapter. It never evaluates that source or accepts a URL from it.
func ReviewedAdapterModels(provider, source string) (map[string]AdapterDescriptor, error) {
	prefix := "const SPEC = "
	start := strings.Index(source, prefix)
	if start < 0 {
		return nil, errors.New("reviewed_adapter_spec_missing")
	}
	var spec struct {
		Provider, Key, BaseURL string
		Models                 map[string]AdapterDescriptor
	}
	if json.NewDecoder(strings.NewReader(source[start+len(prefix):])).Decode(&spec) != nil || spec.Provider != provider || spec.Key != "pikno-"+provider {
		return nil, errors.New("reviewed_adapter_spec_invalid")
	}
	expected := "https://sanbaobeauty.com"
	if provider == "canseedream" {
		expected = "https://see.ximeiedu.org"
	}
	if spec.BaseURL != expected {
		return nil, errors.New("reviewed_adapter_origin")
	}
	for id, d := range spec.Models {
		if !strings.HasPrefix(id, provider+"/") || d.Kind != "video" {
			return nil, errors.New("reviewed_adapter_model")
		}
		if provider == "sanbao" && d.Path != "/openapi/v1/videos" || provider == "canseedream" && d.Path != "/api/v3/contents/generations/tasks" {
			return nil, errors.New("reviewed_adapter_path")
		}
		if d.Route != "" && !syncRouteID.MatchString(d.Route) || d.Line != "" && !syncRouteID.MatchString(d.Line) {
			return nil, errors.New("reviewed_adapter_route")
		}
	}
	return spec.Models, nil
}

func ParseProviderSnapshot(provider string, body []byte, now time.Time) (*ProviderSnapshot, error) {
	if err := validateCompleteCatalog(provider, body); err != nil {
		return nil, err
	}
	var entries []Entry
	var err error
	switch provider {
	case "sanbao":
		entries, err = ParseSanbao(body)
	case "canseedream":
		entries, err = ParseCansee(body)
	default:
		return nil, errors.New("unsupported catalog provider")
	}
	if err != nil {
		return nil, err
	}
	var raw struct {
		Data     []map[string]any `json:"data"`
		Defaults struct {
			VideoProviders []map[string]any `json:"videoProviders"`
			ProtocolLines  []map[string]any `json:"protocolLines"`
		} `json:"defaults"`
	}
	if json.Unmarshal(body, &raw) != nil {
		return nil, errors.New("invalid catalog JSON")
	}
	values := raw.Data
	if provider == "canseedream" {
		values = raw.Defaults.VideoProviders
	}
	byID := map[string]map[string]any{}
	for _, v := range values {
		if id, ok := v["id"].(string); ok {
			byID[id] = v
		}
	}
	// ParseCansee already validates profile identities and rejects duplicates.
	profiles := map[string]map[string]any{}
	for _, profile := range raw.Defaults.ProtocolLines {
		id, _ := profile["id"].(string)
		profiles[id], _ = profile["profile"].(map[string]any)
	}
	result := &ProviderSnapshot{Provider: provider, VerifiedAt: now.Unix(), Items: []SyncItem{}}
	seen := map[string]bool{}
	for _, entry := range entries {
		if seen[entry.ID] {
			return nil, errors.New("duplicate_catalog_model")
		}
		seen[entry.ID] = true
		id := strings.TrimPrefix(entry.ID, provider+"/")
		if provider == "canseedream" {
			id = strings.TrimPrefix(entry.ID, "canseedream/video/")
		}
		source := byID[id]
		// Explicit false is authoritative. A missing flag keeps the existing
		// provider catalog contract; presence with the wrong type is rejected.
		for _, field := range []string{"enabled", "available", "disabled"} {
			if value, present := source[field]; present {
				flag, ok := value.(bool)
				if !ok {
					return nil, errors.New("invalid availability flag")
				}
				if field == "disabled" {
					flag = !flag
				}
				entry.Available = entry.Available && flag
			}
		}
		item := SyncItem{Entry: entry}
		d := &AdapterDescriptor{Kind: "video", Path: "/openapi/v1/videos", UpstreamModel: id, Qualities: entry.Qualities, Resolutions: entry.Resolutions, Ratios: entry.Ratios, Durations: entry.Durations, Limits: map[string]int{"image": entry.MaxImages, "video": entry.MaxVideos, "audio": entry.MaxAudio}, MaxPrompt: 10000}
		if entry.MaxMediaTotal != nil {
			d.Limits["total"] = *entry.MaxMediaTotal
		}
		if len(d.Resolutions) == 0 || len(d.Durations) == 0 {
			item.AdapterIssue = "capabilities_missing"
		}
		for _, duration := range d.Durations {
			if duration != float64(int(duration)) || duration < 1 || duration > 30 {
				item.AdapterIssue = "duration_contract_unknown"
			}
		}
		if provider == "canseedream" {
			d.Path = "/api/v3/contents/generations/tasks"
			d.UpstreamModel = ""
			route, _ := source["providerRoute"].(string)
			line, _ := source["providerLine"].(string)
			// provider_router is the reviewed v3 line-selection protocol. Direct
			// routes are restricted to the already reviewed family, not every new ID.
			direct := []string{"juzi_pool", "aggc", "donggua_pool", "donggua2_pool", "ningmeng_pool", "yadan_pool", "xigua2_pool", "minih3_a_pool", "ningmeng_c_pool", "dami_c_pool", "dami_e_pool", "caomeinewa"}
			if route == "" && slices.Contains(direct, id) {
				route = id
			}
			if route == "provider_router" && syncRouteID.MatchString(line) {
				d.Route = route
				d.Line = line
				// A fresh protocol profile must explicitly declare both policies.
				// Missing data must not silently relax a known visual requirement.
				profile := profiles[line]
				textOnly, textOK := profile["allowTextOnly"].(bool)
				audioOnly, audioOK := profile["allowAudioOnly"].(bool)
				if !textOK || !audioOK {
					item.AdapterIssue = "reference_policy_unknown"
				} else {
					d.AllowTextOnly = &textOnly
					d.AllowAudioOnly = &audioOnly
				}
			} else if slices.Contains(direct, route) && line == "" {
				d.Route = route
			} else {
				item.AdapterIssue = "protocol_not_supported"
			}
			if raw, present := source["maxPromptCharacters"]; present {
				p, ok := raw.(float64)
				if ok && p >= 1 && p == math.Trunc(p) {
					// A larger upstream allowance is compatible with our stricter
					// local limit. Never widen the application's prompt contract.
					d.MaxPrompt = int(min(p, 20000))
				} else {
					item.AdapterIssue = "prompt_contract_unknown"
				}
			}
		}
		if item.AdapterIssue == "" {
			item.Adapter = d
		}
		result.Items = append(result.Items, item)
	}
	slices.SortFunc(result.Items, func(a, b SyncItem) int { return strings.Compare(a.Entry.ID, b.Entry.ID) })
	result.Hash = CanonicalDigest(struct {
		Provider string
		Items    []SyncItem
	}{provider, result.Items})
	return result, nil
}

func FetchProviderSnapshot(ctx context.Context, client *http.Client, provider string, conditional ConditionalCatalog, now time.Time) (SnapshotFetch, error) {
	target := ""
	switch provider {
	case "sanbao":
		return SnapshotFetch{}, errors.New("catalog provider is retired")
	case "canseedream":
		target = "https://see.ximeiedu.org/health"
	default:
		return SnapshotFetch{}, errors.New("unsupported catalog provider")
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	// Copy the caller's transport for offline fixtures, but do not inherit an
	// unrestricted redirect policy.
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("catalog redirects forbidden") }
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return SnapshotFetch{}, err
	}
	request.Header.Set("Accept", "application/json")
	if conditional.ETag != "" {
		request.Header.Set("If-None-Match", conditional.ETag)
	}
	if conditional.LastModified != "" {
		request.Header.Set("If-Modified-Since", conditional.LastModified)
	}
	response, err := copyClient.Do(request)
	if err != nil {
		return SnapshotFetch{}, errors.New("catalog_network")
	}
	defer response.Body.Close()
	result := SnapshotFetch{ETag: response.Header.Get("ETag"), LastModified: response.Header.Get("Last-Modified")}
	if response.StatusCode == 304 {
		if conditional.ETag == "" && conditional.LastModified == "" {
			return result, errors.New("unexpected_not_modified")
		}
		result.NotModified = true
		return result, nil
	}
	if response.StatusCode != 200 {
		return result, fmt.Errorf("catalog_http_%d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	if err != nil || len(raw) > 2*1024*1024 {
		return result, errors.New("catalog_size")
	}
	// Availability is a separately validated, close-only fact from this exact
	// trusted response. Keep it available even when the full catalog is invalid.
	result.Closures, err = ParseAvailabilityClosures(provider, raw)
	if err != nil {
		return result, err
	}
	result.Snapshot, err = ParseProviderSnapshot(provider, raw, now)
	if err != nil {
		return result, err
	}
	result.Snapshot.ETag = result.ETag
	result.Snapshot.LastModified = result.LastModified
	return result, nil
}

func GenerateSyncPlugin(provider string, models map[string]AdapterDescriptor) (string, string, string, error) {
	if len(models) == 0 {
		digest := sha256.Sum256(nil)
		return "", "", hex.EncodeToString(digest[:]), nil
	}
	origin, key, name := "", "pikno-"+provider, "PIKNO task adapter"
	fields := []string{}
	switch provider {
	case "sanbao":
		origin = "https://sanbaobeauty.com"
		fields = []string{"prompt", "ratio", "resolution", "duration", "reference", "images", "videos", "audios", "concurrency"}
	case "canseedream":
		origin = "https://see.ximeiedu.org"
		fields = []string{"prompt", "image_urls", "audio_urls", "video_urls", "duration", "resolution", "aspect_ratio", "generate_audio", "number_of_runs"}
	default:
		return "", "", "", errors.New("unsupported adapter provider")
	}
	hash := CanonicalDigest(struct {
		Runtime  string
		Provider string
		Models   map[string]AdapterDescriptor
	}{syncRuntime, provider, models})
	version := "0.37.0-sync." + hash[:20]
	spec := map[string]any{"provider": provider, "key": key, "name": name, "baseUrl": origin, "models": models, "fields": map[string]any{"video": fields}}
	encoded, err := json.Marshal(spec)
	if err != nil {
		return "", "", "", err
	}
	runtime := strings.Replace(syncRuntime, "version: '0.3.0'", "version: '"+version+"'", 1)
	source := "const SPEC = " + string(encoded) + ";\n" + runtime
	digest := sha256.Sum256([]byte(source))
	return source, version, hex.EncodeToString(digest[:]), nil
}
