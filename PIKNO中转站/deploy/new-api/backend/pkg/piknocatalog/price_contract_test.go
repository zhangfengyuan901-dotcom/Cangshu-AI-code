package piknocatalog

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func canseePriceEntry(t *testing.T, fields map[string]any, divisor any) Entry {
	t.Helper()
	raw := map[string]any{"id": "price_contract", "providerRoute": "provider_router", "providerLine": "price_contract", "allowedResolutions": []string{"480p", "720p"}, "allowedDurations": []int{4, 5}}
	for key, value := range fields {
		raw[key] = value
	}
	body, err := json.Marshal(map[string]any{"defaults": map[string]any{"pointPricing": map[string]any{"pointsPerYuan": divisor}, "videoProviders": []any{raw}}})
	require.NoError(t, err)
	rows, err := ParseCansee(body)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	return rows[0]
}

func TestVideoBillingContractSurvivesMissingOrInvalidCosts(t *testing.T) {
	for _, test := range []struct {
		name    string
		fields  map[string]any
		divisor any
		unit    string
		issue   string
	}{
		{"missing fixed cost", map[string]any{"pricingMode": "fixed"}, 100, "request", "missing_cost"},
		{"missing second cost", map[string]any{"pricingMode": "per_second"}, 100, "second", "missing_cost"},
		{"negative cost", map[string]any{"pricingMode": "fixed", "pointsCost": -1}, 100, "request", "invalid_cost"},
		{"text cost", map[string]any{"pricingMode": "fixed", "pointsCost": "100"}, 100, "request", "invalid_cost"},
		{"malformed resolution map", map[string]any{"pricingMode": "fixed", "pointsCost": 100, "resolutionPoints": []int{100}}, 100, "request", "invalid_cost"},
		{"missing conversion", map[string]any{"pricingMode": "fixed", "pointsCost": 100}, 0, "request", "invalid_exchange_rate"},
		{"text conversion is not inferred", map[string]any{"pricingMode": "fixed", "pointsCost": 100}, "100", "request", "invalid_exchange_rate"},
		{"object conversion is not inferred", map[string]any{"pricingMode": "fixed", "pointsCost": 100}, map[string]any{"value": 100}, "request", "invalid_exchange_rate"},
		{"list conversion is not inferred", map[string]any{"pricingMode": "fixed", "pointsCost": 100}, []int{100}, "request", "invalid_exchange_rate"},
		{"boolean conversion is not inferred", map[string]any{"pricingMode": "fixed", "pointsCost": 100}, true, "request", "invalid_exchange_rate"},
		{"overflowing conversion", map[string]any{"pricingMode": "fixed", "pointsCost": 100}, math.SmallestNonzeroFloat64, "request", "invalid_exchange_rate"},
	} {
		t.Run(test.name, func(t *testing.T) {
			entry := canseePriceEntry(t, test.fields, test.divisor)
			require.Equal(t, test.unit, entry.BillingUnit)
			require.Empty(t, entry.BillingIssueCode)
			require.Equal(t, test.issue, entry.CostIssueCode)
			require.False(t, entry.PriceIssue)
			require.Len(t, entry.Prices, 2)
			for index, resolution := range []string{"480p", "720p"} {
				require.Equal(t, resolution, entry.Prices[index].Resolution)
				require.Equal(t, test.unit, entry.Prices[index].Unit)
				require.Nil(t, entry.Prices[index].CostCNY)
				require.Zero(t, entry.Prices[index].RetailCNY)
			}
		})
	}
}

func TestVideoBillingKeepsExplicitZeroAndPartialCostFacts(t *testing.T) {
	entry := canseePriceEntry(t, map[string]any{"pricingMode": "fixed", "pointsCost": 999, "resolutionPoints": map[string]any{"480p": 0}}, 100)
	require.False(t, entry.PriceIssue)
	require.Equal(t, "missing_cost", entry.CostIssueCode)
	require.Len(t, entry.Prices, 2)
	require.NotNil(t, entry.Prices[0].CostCNY)
	require.Zero(t, *entry.Prices[0].CostCNY)
	require.Nil(t, entry.Prices[1].CostCNY)
	encoded, err := json.Marshal(entry)
	require.NoError(t, err)
	var decoded struct {
		Prices []map[string]any `json:"prices"`
	}
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	require.Contains(t, decoded.Prices[0], "cost_cny")
	require.NotContains(t, decoded.Prices[1], "cost_cny")

	entry = canseePriceEntry(t, map[string]any{"pricingMode": "per_second", "pointsPerSecond": 999, "resolutionPointsPerSecond": map[string]any{"480p": 19, "720p": 36}, "resolutionPoints": map[string]any{"480p": 999, "720p": 999}}, 100)
	require.Empty(t, entry.CostIssueCode)
	require.False(t, entry.PriceIssue)
	require.Equal(t, 0.38, entry.Prices[0].RetailCNY)
	require.Equal(t, 0.72, entry.Prices[1].RetailCNY)
}

func TestVideoUnknownBillingOrSpecHasNoExecutablePriceContract(t *testing.T) {
	for _, test := range []struct {
		name   string
		fields map[string]any
		unit   string
		issue  string
	}{
		{"unit absent", map[string]any{"pointsCost": 100, "pointsPerSecond": 10}, "", "unknown_billing_unit"},
		{"unit blank", map[string]any{"pricingMode": " "}, "", "unknown_billing_unit"},
		{"unit unsupported", map[string]any{"pricingMode": "per_minute"}, "", "invalid_billing_unit"},
		{"unit wrong type", map[string]any{"pricingMode": []string{"fixed"}}, "", "invalid_billing_unit"},
		{"spec absent", map[string]any{"pricingMode": "fixed", "allowedResolutions": nil}, "request", "unknown_price_spec"},
		{"spec malformed", map[string]any{"pricingMode": "per_second", "allowedResolutions": []string{"<invalid>"}}, "second", "unknown_price_spec"},
	} {
		t.Run(test.name, func(t *testing.T) {
			entry := canseePriceEntry(t, test.fields, 100)
			require.Equal(t, test.unit, entry.BillingUnit)
			require.Equal(t, test.issue, entry.BillingIssueCode)
			require.True(t, entry.PriceIssue)
			require.Empty(t, entry.Prices)
		})
	}
}

func TestSanbaoCostWarningDoesNotEraseDeclaredUnitOrSpecs(t *testing.T) {
	for _, test := range []struct {
		body  string
		unit  string
		issue string
	}{
		{`{"data":[{"id":"v","type":"video","enabled":true,"billing":"per_second","resolutions":["480p","720p"]}]}`, "second", "missing_cost"},
		{`{"data":[{"id":"v","type":"video","enabled":true,"billing":"per_generation","resolutions":["480p","720p"],"price_credits":30,"web_price_by_resolution_credits":{"480p":10,"720p":20}}]}`, "request", "conflicting_cost"},
	} {
		rows, err := ParseSanbao([]byte(test.body))
		require.NoError(t, err)
		require.False(t, rows[0].PriceIssue)
		require.Equal(t, test.unit, rows[0].BillingUnit)
		require.Equal(t, test.issue, rows[0].CostIssueCode)
		require.Len(t, rows[0].Prices, 2)
		for _, price := range rows[0].Prices {
			require.Nil(t, price.CostCNY)
			require.Zero(t, price.RetailCNY)
		}
	}
}

func TestReferenceCostWarningDoesNotBlockExplicitBilling(t *testing.T) {
	for _, fields := range []map[string]any{
		{"videoReferenceSurchargeEnabled": true},
		{"videoReferenceSurchargeEnabled": true, "videoReferenceSurchargePoints": -1},
		{"videoReferenceSurchargeEnabled": "true", "videoReferenceSurchargePoints": 50},
	} {
		fields["pricingMode"], fields["pointsCost"] = "fixed", 100
		entry := canseePriceEntry(t, fields, 100)
		require.False(t, entry.PriceIssue)
		require.Equal(t, "reference_cost_unknown", entry.CostIssueCode)
		require.Zero(t, entry.ReferenceSurchargeCNY)
		require.Equal(t, 2.0, entry.Prices[0].RetailCNY)
	}
	entry := canseePriceEntry(t, map[string]any{"pricingMode": "fixed", "pointsCost": 0, "videoReferenceSurchargeEnabled": true, "videoReferenceSurchargePoints": 0}, 100)
	require.Empty(t, entry.CostIssueCode)
	require.False(t, entry.PriceIssue)
	require.Zero(t, entry.ReferenceSurchargeCNY)
}

func TestSnapshotIncludesCostWarningWithoutLosingAdapter(t *testing.T) {
	known, err := ParseProviderSnapshot("canseedream", []byte(syncFixture), time.Unix(100, 0))
	require.NoError(t, err)
	var raw map[string]any
	require.NoError(t, json.Unmarshal([]byte(syncFixture), &raw))
	provider := raw["defaults"].(map[string]any)["videoProviders"].([]any)[0].(map[string]any)
	delete(provider, "pointsCost")
	body, err := json.Marshal(raw)
	require.NoError(t, err)
	missing, err := ParseProviderSnapshot("canseedream", body, time.Unix(200, 0))
	require.NoError(t, err)
	require.NotEqual(t, known.Hash, missing.Hash)
	require.NotNil(t, missing.Items[0].Adapter)
	require.False(t, missing.Items[0].Entry.PriceIssue)
	require.Equal(t, "missing_cost", missing.Items[0].Entry.CostIssueCode)
	require.Equal(t, "request", missing.Items[0].Entry.BillingUnit)
	require.Equal(t, "image", PackyImageEntry().BillingUnit)
}
