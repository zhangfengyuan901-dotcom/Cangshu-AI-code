package model

import (
	"crypto/sha256"
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestHamster53LLMAdmission(t *testing.T) {
	const now int64 = 2_000_000_000
	id := strings.Repeat("a", 32)
	base := PiknoLLMRequest{ID: fmt.Sprintf("%x", sha256.Sum256(fmt.Appendf(nil, "%d:%s", 7, id))), UserID: 7, TokenID: 9,
		RequestID: id, BodySHA256: strings.Repeat("b", 64), Model: PiknoLLMModel, PriceVersion: PiknoLLMPriceVersion,
		BillingMode: PiknoLLMBillingMode, InputRate: 9, OutputRate: 45, ProviderInputRate: 6, ProviderOutputRate: 30,
		OutputLimit: 100, State: "unknown", CreatedAt: now - 1800, UpdatedAt: now - 900}
	for _, tc := range []struct {
		name    string
		change  func(*PiknoLLMRequest)
		at      int64
		blocked bool
	}{
		{"before boundary", nil, now - 1, true},
		{"exact boundary", nil, now, false},
		{"after boundary", nil, now + 1, false},
		{"long past", nil, math.MaxInt64, false},
		{"invalid clock", nil, -1, true},
		{"reserved never expires", func(r *PiknoLLMRequest) { r.State = "reserved" }, now, true},
		{"dispatched never expires", func(r *PiknoLLMRequest) { r.State = "dispatched" }, now, true},
		{"invalid state", func(r *PiknoLLMRequest) { r.State = "invalid" }, now, true},
		{"empty state", func(r *PiknoLLMRequest) { r.State = "" }, now, true},
		{"settled", func(r *PiknoLLMRequest) { r.State = "settled" }, now, false},
		{"released", func(r *PiknoLLMRequest) { r.State = "released" }, now, false},
		{"legacy prepaid", func(r *PiknoLLMRequest) { r.BillingMode = ""; r.PriceVersion = "chat-cny-9-45-v1" }, now, true},
		{"other mode", func(r *PiknoLLMRequest) { r.BillingMode = "future" }, now, true},
		{"other price", func(r *PiknoLLMRequest) { r.PriceVersion = "chat-future" }, now, true},
		{"other model", func(r *PiknoLLMRequest) { r.Model = "other" }, now, true},
		{"changed rate", func(r *PiknoLLMRequest) { r.InputRate = 8 }, now, true},
		{"negative provider rate", func(r *PiknoLLMRequest) { r.ProviderInputRate = -1 }, now, true},
		{"reserved amount", func(r *PiknoLLMRequest) { r.ReservedQuota = 1 }, now, true},
		{"negative amount", func(r *PiknoLLMRequest) { r.ChargedQuota = -1 }, now, true},
		{"charged amount", func(r *PiknoLLMRequest) { r.ChargedQuota = 1 }, now, true},
		{"refunded amount", func(r *PiknoLLMRequest) { r.RefundedQuota = 1 }, now, true},
		{"input usage", func(r *PiknoLLMRequest) { r.InputTokens = 1 }, now, true},
		{"output usage", func(r *PiknoLLMRequest) { r.OutputTokens = 1 }, now, true},
		{"cached usage", func(r *PiknoLLMRequest) { r.CachedTokens = 1 }, now, true},
		{"estimate", func(r *PiknoLLMRequest) { estimate := 0; r.EstimatedCostQuota = &estimate }, now, true},
		{"legacy input limit", func(r *PiknoLLMRequest) { r.InputLimit = 1 }, now, true},
		{"empty output bound", func(r *PiknoLLMRequest) { r.OutputLimit = 0 }, now, true},
		{"large output bound", func(r *PiknoLLMRequest) { r.OutputLimit = PiknoLLMMaxOutputTokens + 1 }, now, true},
		{"missing created", func(r *PiknoLLMRequest) { r.CreatedAt = 0 }, now, true},
		{"negative created", func(r *PiknoLLMRequest) { r.CreatedAt = math.MinInt64 }, now, true},
		{"missing updated", func(r *PiknoLLMRequest) { r.UpdatedAt = 0 }, now, true},
		{"reverse time", func(r *PiknoLLMRequest) { r.CreatedAt = r.UpdatedAt + 1 }, now, true},
		{"future update", func(r *PiknoLLMRequest) { r.UpdatedAt = now + 1 }, now, true},
		{"extreme future", func(r *PiknoLLMRequest) { r.UpdatedAt = math.MaxInt64 }, now, true},
		{"owner missing", func(r *PiknoLLMRequest) { r.UserID = 0 }, now, true},
		{"key missing", func(r *PiknoLLMRequest) { r.TokenID = 0 }, now, true},
		{"request malformed", func(r *PiknoLLMRequest) { r.RequestID = "bad" }, now, true},
		{"identity changed", func(r *PiknoLLMRequest) { r.ID = strings.Repeat("a", 64) }, now, true},
		{"digest missing", func(r *PiknoLLMRequest) { r.BodySHA256 = "" }, now, true},
		{"nullable record", func(r *PiknoLLMRequest) { r.admissionRecordIncomplete = true }, now, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := base
			if tc.change != nil {
				tc.change(&r)
			}
			before := r
			assert.Equal(t, tc.blocked, r.AdmissionBlocking(tc.at))
			assert.Equal(t, before, r, "admission never changes a ledger record")
		})
	}
}
