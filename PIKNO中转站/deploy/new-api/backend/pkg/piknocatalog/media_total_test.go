package piknocatalog

import (
	"context"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/stretchr/testify/require"
)

func TestMediaTotalFromUpstreamToPlugin(t *testing.T) {
	for _, tc := range []struct {
		name    string
		raw     any
		present bool
		total   int
	}{
		{"legacy", nil, false, 20}, {"large", 50, true, 50}, {"lower", 12, true, 12}, {"zero", 0, true, 0},
		{"negative", -1, true, 0}, {"fraction", 1.5, true, 0}, {"string", "50", true, 0}, {"null", nil, true, 0}, {"too large", 1001, true, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			require.NoError(t, common.Unmarshal([]byte(syncFixture), &body))
			limits := body["defaults"].(map[string]any)["videoProviders"].([]any)[0].(map[string]any)["limits"].(map[string]any)
			limits["maxImages"], limits["maxVideos"], limits["maxAudio"] = 30, 10, 10
			if tc.present {
				limits["maxAssets"] = tc.raw
			}
			raw, err := common.Marshal(body)
			require.NoError(t, err)
			snapshot, err := ParseProviderSnapshot("canseedream", raw, time.Unix(100, 0))
			require.NoError(t, err)
			item := snapshot.Items[0]
			require.NotNil(t, item.Adapter)
			if tc.present {
				require.NotNil(t, item.Entry.MaxMediaTotal)
				require.Equal(t, tc.total, *item.Entry.MaxMediaTotal)
				require.Equal(t, tc.total, item.Adapter.Limits["total"])
			} else {
				require.Nil(t, item.Entry.MaxMediaTotal)
			}
			source, _, _, err := GenerateSyncPlugin("canseedream", map[string]AdapterDescriptor{item.Entry.ID: *item.Adapter})
			require.NoError(t, err)
			engine, err := jsplugin.Compile(source, jsplugin.Options{})
			require.NoError(t, err)
			for _, count := range []int{0, 12, 13, 20, 21, 30, 31} {
				refs := make([]any, count)
				for i := range refs {
					refs[i] = "https://fixture.invalid/image"
				}
				input := map[string]any{"model": item.Entry.ID, "prompt": "Synthetic fixture", "duration": 4, "resolution": "720p", "image_urls": refs}
				ctx := map[string]any{"model": item.Entry.ID, "requestBody": input, "body": map[string]any{"kind": "json", "value": input}, "baseUrl": "https://see.ximeiedu.org", "apiKey": "synthetic-only"}
				_, err = engine.CallMember(context.Background(), "native", "create", ctx)
				if count <= tc.total && count <= 30 {
					require.NoError(t, err)
				} else {
					require.Error(t, err)
				}
			}
		})
	}
}
