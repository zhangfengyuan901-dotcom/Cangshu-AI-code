package model

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestPiknoMediaTotalPersistedCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		limit     int
	}{
		{"legacy", `{}`, 20}, {"zero", `{"max_media_total":0}`, 0}, {"large", `{"max_media_total":50}`, 50},
		{"negative", `{"max_media_total":-1}`, 0}, {"too large", `{"max_media_total":1001}`, 0}, {"null", `{"max_media_total":null}`, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config, err := decodePiknoLineConfig(tc.raw)
			require.NoError(t, err)
			require.Equal(t, tc.limit, config.MediaTotalLimit())
			encoded, err := encodePiknoLineConfig(config)
			require.NoError(t, err)
			copy, err := decodePiknoLineConfig(encoded)
			require.NoError(t, err)
			require.Equal(t, tc.limit, copy.MediaTotalLimit())
		})
	}
	for _, raw := range []string{`{"max_media_total":"50"}`, `{"max_media_total":1.5}`} {
		_, err := decodePiknoLineConfig(raw)
		require.Error(t, err)
	}
}
