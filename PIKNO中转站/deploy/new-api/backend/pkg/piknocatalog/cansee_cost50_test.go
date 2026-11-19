package piknocatalog

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestVideo50ResolutionCostsFollowDeclaredMode(t *testing.T) {
	for _, tc := range []struct{ mode, unit string }{{"per_second", "second"}, {"fixed", "request"}} {
		t.Run(tc.mode, func(t *testing.T) {
			entry := canseePriceEntry(t, map[string]any{
				"pricingMode": tc.mode, "pointsPerSecond": 999, "pointsCost": 675,
				"resolutionPoints": map[string]any{"480p": 45, "720p": 57},
			}, 100)
			require.Empty(t, entry.CostIssueCode)
			require.Empty(t, entry.BillingIssueCode)
			require.Equal(t, tc.unit, entry.BillingUnit)
			require.Equal(t, 0.45, *entry.Prices[0].CostCNY)
			require.Equal(t, 0.57, *entry.Prices[1].CostCNY)
			require.Equal(t, tc.unit, entry.Prices[1].Unit)
		})
	}
}

func TestVideo50CostMapPrecedenceAndValidation(t *testing.T) {
	for _, tc := range []struct {
		name string
		explicit, legacy any
		issue string
		cost *float64
	}{
		{"explicit map wins", map[string]any{"480p": 19, "720p": 36}, map[string]any{"480p": 45, "720p": 57}, "", ptr50(.19)},
		{"empty explicit map uses declared legacy unit", map[string]any{}, map[string]any{"480p": 45, "720p": 57}, "", ptr50(.45)},
		{"partial explicit map never silently borrows", map[string]any{"480p": 19}, map[string]any{"480p": 45, "720p": 57}, "missing_cost", ptr50(.19)},
		{"malformed explicit map stays invalid", []any{19}, map[string]any{"480p": 45, "720p": 57}, "invalid_cost", nil},
		{"malformed legacy map stays invalid", nil, []any{19}, "invalid_cost", nil},
		{"negative legacy cost stays invalid", nil, map[string]any{"480p": -1, "720p": 57}, "invalid_cost", nil},
		{"zero remains explicit", nil, map[string]any{"480p": 0, "720p": 57}, "", ptr50(0)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry := canseePriceEntry(t, map[string]any{"pricingMode": "per_second", "pointsPerSecond": 999, "pointsCost": 675, "resolutionPointsPerSecond": tc.explicit, "resolutionPoints": tc.legacy}, 100)
			require.Equal(t, tc.issue, entry.CostIssueCode)
			require.Equal(t, tc.cost, entry.Prices[0].CostCNY)
			require.Equal(t, "second", entry.BillingUnit)
		})
	}
}

func TestVideo50TotalCostCannotBecomeSecondRate(t *testing.T) {
	entry := canseePriceEntry(t, map[string]any{"pricingMode": "per_second", "pointsCost": 1290}, 100)
	require.Equal(t, "missing_cost", entry.CostIssueCode)
	for _, price := range entry.Prices { require.Nil(t, price.CostCNY) }
	entry = canseePriceEntry(t, map[string]any{"resolutionPoints": map[string]any{"480p": 45, "720p": 57}}, 100)
	require.Equal(t, "unknown_billing_unit", entry.BillingIssueCode)
	require.Empty(t, entry.Prices)
}

func ptr50(value float64) *float64 { return &value }
