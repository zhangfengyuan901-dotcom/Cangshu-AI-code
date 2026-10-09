// Package piknocatalog holds a publication-only model catalog. It never changes
// gateway channels, prices, quotas, credentials or task-plugin definitions.
package piknocatalog

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

type Price struct {
	Resolution string   `json:"resolution"`
	Unit       string   `json:"unit"`
	CostCNY    *float64 `json:"cost_cny,omitempty"`
	RetailCNY  float64  `json:"retail_cny"`
}
type Entry struct {
	ID                    string    `json:"id"`
	Provider              string    `json:"provider"`
	Name                  string    `json:"name"`
	Kind                  string    `json:"kind"`
	Available             bool      `json:"upstream_available"`
	Resolutions           []string  `json:"resolutions"`
	Ratios                []string  `json:"ratios"`
	Durations             []float64 `json:"durations"`
	MaxImages             int       `json:"max_images"`
	MaxVideos             int       `json:"max_videos"`
	MaxAudio              int       `json:"max_audio"`
	Prices                []Price   `json:"prices"`
	PriceIssue            bool      `json:"price_issue"`
	ReferenceSurchargeCNY float64   `json:"reference_surcharge_cny"`
}
type Snapshot struct {
	Revision  string  `json:"revision"`
	FetchedAt string  `json:"fetched_at"`
	Models    []Entry `json:"models"`
}

var modelID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)
var token = regexp.MustCompile(`^[A-Za-z0-9:_./-]{1,32}$`)

func list(raw any) []string {
	result := []string{}
	values, _ := raw.([]any)
	for _, v := range values {
		s, ok := v.(string)
		if ok && token.MatchString(s) && !slices.Contains(result, s) {
			result = append(result, s)
		}
	}
	return result
}
func numbers(raw any) []float64 {
	result := []float64{}
	values, _ := raw.([]any)
	for _, v := range values {
		n, ok := v.(float64)
		if ok && n > 0 && n <= 600 && !slices.Contains(result, n) {
			result = append(result, n)
		}
	}
	return result
}
func numeric(raw any) (float64, bool) {
	n, ok := raw.(float64)
	return n, ok && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= 1000000
}
func limit(raw any) int {
	n, ok := numeric(raw)
	if !ok || n > 1000 || n != math.Trunc(n) {
		return 0
	}
	return int(n)
}
func label(raw any, fallback string) string {
	s, ok := raw.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return fallback
	}
	r := []rune(s)
	if len(r) > 160 {
		r = r[:160]
	}
	return string(r)
}
func priceRows(resolutions []string, byResolution any, fallback any, divisor float64, unit string) ([]Price, bool) {
	rows := []Price{}
	if divisor <= 0 || divisor > 1000000 || (unit != "second" && unit != "request") {
		return rows, true
	}
	values, hasMap := byResolution.(map[string]any)
	keys := resolutions
	if len(keys) == 0 {
		keys = []string{"default"}
	}
	issue := false
	for _, resolution := range keys {
		raw := fallback
		if hasMap && len(values) > 0 {
			raw = values[resolution]
		}
		n, ok := numeric(raw)
		if !ok {
			issue = true
			continue
		}
		// Reference quotes only, rounded to six decimal places; no quota conversion.
		cost := math.Round(n/divisor*1000000) / 1000000
		retail := math.Round(n/divisor*2*1000000) / 1000000
		rows = append(rows, Price{resolution, unit, &cost, retail})
	}
	return rows, issue || len(rows) == 0
}

func ParseSanbao(body []byte) ([]Entry, error) {
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := common.Unmarshal(body, &payload); err != nil || len(payload.Data) == 0 || len(payload.Data) > 500 {
		return nil, errors.New("Sanbao catalog format unavailable")
	}
	result := []Entry{}
	seen := map[string]bool{}
	for _, raw := range payload.Data {
		if raw["type"] != "video" {
			continue
		}
		id, _ := raw["id"].(string)
		if !modelID.MatchString(id) || seen[id] {
			return nil, errors.New("Invalid or duplicate Sanbao model")
		}
		seen[id] = true
		enabled, ok := raw["enabled"].(bool)
		if !ok {
			return nil, errors.New("Sanbao availability missing")
		}
		entry := Entry{ID: "sanbao/" + id, Provider: "sanbao", Name: label(raw["name"], id), Kind: "video", Available: enabled, Resolutions: list(raw["resolutions"]), Ratios: list(raw["ratios"]), Durations: numbers(raw["durations"]), MaxImages: limit(raw["max_images"]), MaxVideos: limit(raw["max_videos"]), MaxAudio: limit(raw["max_audios"])}
		switch raw["billing"] {
		case "per_second":
			entry.Prices, entry.PriceIssue = priceRows(entry.Resolutions, raw["price_per_second_by_resolution_credits"], raw["price_per_second_credits"], 10, "second")
		case "per_generation":
			// The web_* fields describe website prices, not an API price contract.
			entry.Prices, entry.PriceIssue = priceRows(entry.Resolutions, nil, raw["price_credits"], 10, "request")
			if len(entry.Resolutions) > 1 {
				entry.Prices = []Price{}
				entry.PriceIssue = true
			}
		default:
			entry.Prices = []Price{}
			entry.PriceIssue = true
		}
		result = append(result, entry)
	}
	if len(result) == 0 {
		return nil, errors.New("Sanbao video catalog unexpectedly empty")
	}
	return result, nil
}

func ParseCansee(body []byte) ([]Entry, error) {
	var payload struct {
		Defaults struct {
			VideoProviders []map[string]any `json:"videoProviders"`
			PointPricing   struct {
				PointsPerYuan float64 `json:"pointsPerYuan"`
			} `json:"pointPricing"`
		} `json:"defaults"`
	}
	if err := common.Unmarshal(body, &payload); err != nil || len(payload.Defaults.VideoProviders) == 0 || len(payload.Defaults.VideoProviders) > 500 {
		return nil, errors.New("CanSeeDream catalog format unavailable")
	}
	result := []Entry{}
	seen := map[string]bool{}
	for _, raw := range payload.Defaults.VideoProviders {
		id, _ := raw["id"].(string)
		if !modelID.MatchString(id) || seen[id] {
			return nil, errors.New("Invalid or duplicate CanSeeDream route")
		}
		seen[id] = true
		limits, _ := raw["limits"].(map[string]any)
		entry := Entry{ID: "canseedream/video/" + id, Provider: "canseedream", Name: label(raw["label"], id), Kind: "video", Available: true, Resolutions: list(raw["allowedResolutions"]), Ratios: list(limits["allowedRatios"]), Durations: numbers(raw["allowedDurations"]), MaxImages: limit(limits["maxImages"]), MaxVideos: limit(limits["maxVideos"]), MaxAudio: limit(limits["maxAudio"])}
		if len(entry.Resolutions) == 0 {
			entry.Resolutions = list([]any{raw["resolution"]})
		}
		if len(entry.Durations) == 0 {
			entry.Durations = numbers([]any{raw["durationSeconds"]})
		}
		divisor := payload.Defaults.PointPricing.PointsPerYuan
		switch raw["pricingMode"] {
		case "per_second":
			entry.Prices, entry.PriceIssue = priceRows(entry.Resolutions, raw["resolutionPointsPerSecond"], raw["pointsPerSecond"], divisor, "second")
		case "fixed":
			entry.Prices, entry.PriceIssue = priceRows(entry.Resolutions, raw["resolutionPoints"], raw["pointsCost"], divisor, "request")
		default:
			entry.Prices = []Price{}
			entry.PriceIssue = true
		}
		if raw["pricingMode"] == "per_second" && raw["resolutionPointsPerSecond"] == nil && raw["resolutionPoints"] != nil {
			entry.Prices = []Price{}
			entry.PriceIssue = true // Ambiguous per-call vs per-second map.
		}
		if raw["videoReferenceSurchargeEnabled"] == true {
			surcharge, ok := numeric(raw["videoReferenceSurchargePoints"])
			if !ok || divisor <= 0 || divisor > 1000000 {
				entry.PriceIssue = true
			} else {
				entry.ReferenceSurchargeCNY = math.Round(surcharge/divisor*2*1000000) / 1000000
			}
		}
		result = append(result, entry)
	}
	return result, nil
}

func Fetch(ctx context.Context) ([]Entry, error) {
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("Catalog redirects are not allowed") }}
	providers := []struct {
		url   string
		parse func([]byte) ([]Entry, error)
	}{
		{"https://sanbaobeauty.com/api/public/openapi-models", ParseSanbao},
		{"https://see.ximeiedu.org/health", ParseCansee},
	}
	result := []Entry{{ID: "gpt-image-2.5-flare", Provider: "packy", Name: "Flare", Kind: "image", Available: true, Resolutions: []string{"1024x1024"}, Ratios: []string{}, Durations: []float64{}, MaxImages: 5, Prices: []Price{{Resolution: "default", Unit: "image", RetailCNY: 0.1}}}}
	for _, provider := range providers {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, provider.url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/json")
		response, err := client.Do(req)
		if err != nil {
			return nil, errors.New("Upstream catalog connection failed; published catalog unchanged")
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
		response.Body.Close()
		if response.StatusCode != 200 || readErr != nil || len(body) > 2*1024*1024 {
			return nil, fmt.Errorf("Upstream catalog response rejected (HTTP %d)", response.StatusCode)
		}
		entries, err := provider.parse(body)
		if err != nil {
			return nil, err
		}
		result = append(result, entries...)
	}
	slices.SortFunc(result, func(a, b Entry) int { return strings.Compare(a.ID, b.ID) })
	return result, nil
}
