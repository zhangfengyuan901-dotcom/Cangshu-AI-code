package piknocatalog

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func parseCanseeSpecs(t *testing.T, providers, profiles []map[string]any) ([]Entry, error) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"defaults": map[string]any{
		"videoProviders": providers, "protocolLines": profiles,
		"pointPricing": map[string]any{"pointsPerYuan": 100},
	}})
	require.NoError(t, err)
	return ParseCansee(body)
}

func protocolProvider(id string) map[string]any {
	return map[string]any{
		"id": id, "label": "Published video", "protocolLine": true, "providerLine": id,
		"allowedResolutions": []string{"480p"}, "allowedDurations": []int{4, 5, 30},
		"limits":      map[string]any{"maxImages": 30, "maxVideos": 0, "maxAudio": 10},
		"pricingMode": "per_second", "pointsPerSecond": 39, "pointsCost": 1170,
		"resolutionPoints": map[string]any{"480p": 39},
	}
}

func protocolProfile(id string, ratios []string) map[string]any {
	return map[string]any{"id": id, "profile": map[string]any{
		"ratios": ratios, "resolutions": []string{"480p"}, "durations": []int{4, 5, 30},
	}}
}

func TestCanseeProtocolSpecsUseMatchingProfileWithoutChangingPrice(t *testing.T) {
	// Current health: protocol videoProviders omit limits.allowedRatios, and
	// publish the supported ratios under protocolLines[id].profile instead.
	rows, err := parseCanseeSpecs(t, []map[string]any{protocolProvider("dongguanewr")}, []map[string]any{
		protocolProfile("another-route", []string{"1:1"}),
		protocolProfile("dongguanewr", []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9"}),
	})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	entry := rows[0]
	require.Equal(t, []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9"}, entry.Ratios)
	require.Equal(t, []string{"480p"}, entry.Resolutions)
	require.Equal(t, []float64{4, 5, 30}, entry.Durations)
	require.Equal(t, 30, entry.MaxImages)
	require.Equal(t, 0, entry.MaxVideos)
	require.Equal(t, 10, entry.MaxAudio)
	require.Equal(t, "second", entry.BillingUnit)
	require.Empty(t, entry.CostIssueCode)
	require.Equal(t, .39, *entry.Prices[0].CostCNY)
	require.Equal(t, .78, entry.Prices[0].RetailCNY)
}

func TestCanseeProtocolProfileCapabilitiesRemainRouteSpecific(t *testing.T) {
	providers := []map[string]any{protocolProvider("a"), protocolProvider("b")}
	rows, err := parseCanseeSpecs(t, providers, []map[string]any{
		protocolProfile("b", []string{"9:16", "1:1", "auto"}),
		protocolProfile("a", []string{"16:9"}),
	})
	require.NoError(t, err)
	require.Equal(t, []string{"16:9"}, rows[0].Ratios)
	require.Equal(t, []string{"9:16", "1:1", "auto"}, rows[1].Ratios)
}

func TestCanseeProtocolProfileFillsMissingResolutionAndDuration(t *testing.T) {
	provider := protocolProvider("a")
	delete(provider, "allowedResolutions")
	provider["allowedDurations"] = nil
	provider["resolution"] = "wrong-default"
	provider["durationSeconds"] = 999
	rows, err := parseCanseeSpecs(t, []map[string]any{provider}, []map[string]any{protocolProfile("a", []string{"16:9"})})
	require.NoError(t, err)
	require.Equal(t, []string{"480p"}, rows[0].Resolutions)
	require.Equal(t, []float64{4, 5, 30}, rows[0].Durations)
}

func TestCanseeProtocolCapabilityConflictsUseOnlyIntersection(t *testing.T) {
	provider := protocolProvider("a")
	provider["limits"].(map[string]any)["allowedRatios"] = []string{"9:16", "16:9", "21:9"}
	provider["allowedResolutions"] = []string{"720p", "480p"}
	provider["allowedDurations"] = []int{4, 5, 30, 40}
	profile := protocolProfile("a", []string{"1:1", "16:9", "9:16"})
	profile["profile"].(map[string]any)["durations"] = []int{4, 30}
	rows, err := parseCanseeSpecs(t, []map[string]any{provider}, []map[string]any{profile})
	require.NoError(t, err)
	require.Equal(t, []string{"9:16", "16:9"}, rows[0].Ratios)
	require.Equal(t, []string{"480p"}, rows[0].Resolutions)
	require.Equal(t, []float64{4, 30}, rows[0].Durations)
}

func TestCanseeProtocolEmptyOrInvalidDeclarationDoesNotInventCapability(t *testing.T) {
	for _, invalid := range []any{[]string{}, "16:9", []string{"<private>"}} {
		provider := protocolProvider("a")
		provider["limits"].(map[string]any)["allowedRatios"] = invalid
		rows, err := parseCanseeSpecs(t, []map[string]any{provider}, []map[string]any{protocolProfile("a", []string{"16:9"})})
		require.NoError(t, err)
		require.Empty(t, rows[0].Ratios)
	}
	provider := protocolProvider("a")
	provider["allowedResolutions"] = []string{}
	provider["allowedDurations"] = []int{}
	provider["resolution"] = "720p"
	provider["durationSeconds"] = 15
	rows, err := parseCanseeSpecs(t, []map[string]any{provider}, []map[string]any{protocolProfile("a", []string{"16:9"})})
	require.NoError(t, err)
	require.Empty(t, rows[0].Resolutions)
	require.Empty(t, rows[0].Durations)
}

func TestCanseeProtocolMissingProfileDoesNotBorrowOrInventRatios(t *testing.T) {
	for _, profiles := range [][]map[string]any{nil, {protocolProfile("other-route", []string{"16:9"})}, {{"id": "a", "profile": map[string]any{}}}} {
		rows, err := parseCanseeSpecs(t, []map[string]any{protocolProvider("a")}, profiles)
		require.NoError(t, err)
		require.Empty(t, rows[0].Ratios)
	}
}

func TestCanseeLegacyRoutesIgnoreProtocolProfilesAndKeepDefaults(t *testing.T) {
	provider := protocolProvider("a")
	delete(provider, "protocolLine")
	provider["limits"].(map[string]any)["allowedRatios"] = []string{"9:16"}
	provider["allowedResolutions"] = nil
	provider["resolution"] = "720p"
	provider["allowedDurations"] = nil
	provider["durationSeconds"] = 15
	rows, err := parseCanseeSpecs(t, []map[string]any{provider}, []map[string]any{protocolProfile("a", []string{"16:9"})})
	require.NoError(t, err)
	require.Equal(t, []string{"9:16"}, rows[0].Ratios)
	require.Equal(t, []string{"720p"}, rows[0].Resolutions)
	require.Equal(t, []float64{15}, rows[0].Durations)
}

func TestCanseeProtocolInvalidIdentityRejectsSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name         string
		providerLine any
		profiles     []map[string]any
	}{
		{"different route", "b", []map[string]any{protocolProfile("a", []string{"16:9"})}},
		{"malformed route identity", map[string]any{"id": "a"}, nil},
		{"duplicate profile", "a", []map[string]any{protocolProfile("a", []string{"16:9"}), protocolProfile("a", []string{"9:16"})}},
		{"malformed profile", "a", []map[string]any{{"id": "a", "profile": "bad"}}},
		{"invalid profile identity", "a", []map[string]any{protocolProfile("<bad>", []string{"16:9"})}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := protocolProvider("a")
			provider["providerLine"] = tc.providerLine
			rows, err := parseCanseeSpecs(t, []map[string]any{provider}, tc.profiles)
			require.Error(t, err)
			require.Nil(t, rows)
		})
	}
}
