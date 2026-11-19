package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/QuantumNous/new-api/common"
)

type piknoToolReadiness struct {
	Enabled              bool `json:"enabled"`
	CredentialConfigured bool `json:"credential_configured"`
	Ready                bool `json:"ready"`
	Tools                struct {
		Digital struct {
			Available       bool `json:"available"`
			MaxAudioSeconds int  `json:"max_audio_seconds"`
		} `json:"digital"`
		Depth struct {
			Available bool `json:"available"`
		} `json:"depth"`
	} `json:"tools"`
}

// Configuration check only; this never authenticates with or generates at RH.
// The bridge credential stays internal and is never returned in an error.
func piknoReadToolReadiness(ctx context.Context) (*piknoToolReadiness, error) {
	unavailable := errors.New("Tool execution connection is not configured")
	secret := os.Getenv("PIKNO_TOOLS_BRIDGE_SECRET")
	if os.Getenv("PIKNO_TOOLS_ENABLED") != "true" || len(secret) < 32 || len(secret) > 400 {
		return nil, unavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.piknoai.com/media/v1/tools/status", nil)
	if err != nil {
		return nil, unavailable
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, unavailable
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4097))
	var result piknoToolReadiness
	if err != nil || resp.StatusCode != http.StatusOK || len(body) > 4096 || common.Unmarshal(body, &result) != nil || !result.Enabled || !result.CredentialConfigured || !result.Ready {
		return nil, unavailable
	}
	return &result, nil
}

func (r *piknoToolReadiness) available(kind string) bool {
	return r != nil && r.Ready && ((kind == "digital" && r.Tools.Digital.Available && r.Tools.Digital.MaxAudioSeconds == 30) || (kind == "depth" && r.Tools.Depth.Available))
}
