package controller

import (
	"encoding/json"
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/piknocatalog"
	"github.com/stretchr/testify/require"
)

func TestPiknoLineSimpleSuggestionsCannotBecomeCustomerQuota(t *testing.T) {
	t.Setenv("PIKNO_LINE_SYNC_ENABLED", "true")
	setupResponsesWSRequestTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}))
	cost := 1e30
	seed, err := catalogEntrySeed(piknocatalog.Entry{ID: "canseedream/video/a", Provider: "canseedream", Kind: "video", Available: true, BillingUnit: "second", Resolutions: []string{"720p"}, Durations: []float64{4}, Prices: []piknocatalog.Price{{Resolution: "720p", Unit: "second", CostCNY: &cost, RetailCNY: 1e30}}, ReferenceSurchargeCNY: 1e30}, "fixture")
	require.NoError(t, err)
	require.Zero(t, seed.Prices[0].RetailQuota)
	require.Zero(t, seed.ReferenceSurchargeQuota)
	require.Equal(t, 1e30, seed.Prices[0].SuggestedCNY)
}

func TestPiknoLineSimplePublicViewExcludesCostDiagnostics(t *testing.T) {
	cost := 0.72
	value := publicPiknoLine(model.PiknoLineConfig{PublicModel: "fixture-public", DisplayName: "视频线路", Kind: "video", BillingUnit: "second", CostIssueCode: "conflicting_cost", BillingIssueCode: "private-billing-detail", Prices: []model.PiknoLinePrice{{Resolution: "720p", Unit: "second", RetailQuota: 1_700_000, CostCNY: &cost, SuggestedCNY: 1.44}}})
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	for _, private := range []string{"cost_cny", "cost_issue_code", "billing_issue_code", "conflicting_cost", "private-billing-detail", "suggested_cny"} {
		require.NotContains(t, string(raw), private)
	}
	require.Contains(t, string(raw), `"retail_cny":"1.700000"`)
}
