package controller

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func hamster53OldUnknown(t *testing.T, user *model.User, token *model.Token) *model.PiknoLLMRequest {
	t.Helper()
	id := strings.Repeat("a", 32)
	r, created, err := model.ReservePiknoLLM(user.Id, token.Id, id, strings.Repeat("b", 64), model.PiknoLLMPriceVersion, 100)
	require.NoError(t, err)
	require.True(t, created)
	require.NoError(t, model.DispatchPiknoLLM(user.Id, id))
	_, err = model.FinishPiknoLLM(user.Id, id, "unknown", 0, 0)
	require.NoError(t, err)
	now := common.GetTimestamp()
	require.NoError(t, model.DB.Model(r).Updates(map[string]any{"created_at": now - 1800, "updated_at": now - 901}).Error)
	r, err = model.GetPiknoLLMRequest(user.Id, id)
	require.NoError(t, err)
	require.False(t, r.CustomerView().AdmissionBlocking)
	return r
}

func TestHamster53LLMAdmissionIntegration(t *testing.T) {
	t.Run("view and activation are read only and never claim settlement", func(t *testing.T) {
		user, token, router := setupPiknoLLMTest(t)
		assert.False(t, model.DB.Migrator().HasColumn(&model.PiknoLLMRequest{}, "admission_record_incomplete"))
		assert.False(t, model.DB.Migrator().HasColumn(&model.PiknoLLMRequest{}, "admission_record_complete"))
		old := hamster53OldUnknown(t, user, token)
		before := *old
		for range 2 {
			w := piknoLLMTestCall(router, token, "GET", "/assistant/v2/requests/"+old.RequestID, "", "")
			require.Equal(t, 200, w.Code, w.Body.String())
			var view model.PiknoLLMView
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &view))
			assert.Contains(t, w.Body.String(), `"admission_blocking":false`)
			assert.Equal(t, "unknown", view.Status)
			assert.True(t, view.ReviewRequired)
			assert.Nil(t, view.Usage)
			assert.Zero(t, view.ChargedQuota)
		}
		w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/activate", "", "")
		require.Equal(t, 200, w.Code)
		assert.Contains(t, w.Body.String(), `"unknown_review_policy":"background_after_cooldown_v1"`)
		assert.Contains(t, w.Body.String(), `"unknown_review_cooldown_seconds":900`)
		assert.Contains(t, w.Body.String(), `"one_inflight_per_user":true`)
		after, err := model.GetPiknoLLMRequest(user.Id, old.RequestID)
		require.NoError(t, err)
		assert.Equal(t, before, *after)
	})
	t.Run("old request cannot redispatch while a new explicit request can complete", func(t *testing.T) {
		user, token, router := setupPiknoLLMTest(t)
		old := hamster53OldUnknown(t, user, token)
		before := *old
		r, created, err := model.ReservePiknoLLM(user.Id, token.Id, old.RequestID, old.BodySHA256, old.PriceVersion, old.OutputLimit)
		require.NoError(t, err)
		assert.False(t, created)
		assert.Equal(t, before, *r)
		assert.ErrorIs(t, model.DispatchPiknoLLM(user.Id, old.RequestID), model.ErrPiknoLLMConflict)
		count := 0
		piknoLLMTransport = piknoAssistantRoundTripFunc(func(*http.Request) (*http.Response, error) {
			count++
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}`))}, nil
		})
		body := `{"model":"pikno-chat-standard","input":"new explicit message","max_output_tokens":100}`
		w := piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", old.RequestID, body)
		assert.Equal(t, 409, w.Code)
		assert.Zero(t, count)
		id := strings.Repeat("c", 32)
		w = piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, body)
		require.Equal(t, 200, w.Code, w.Body.String())
		assert.Equal(t, 1, count)
		assert.Equal(t, 409, piknoLLMTestCall(router, token, "POST", "/assistant/v2/responses", id, body).Code)
		assert.Equal(t, 1, count)
		after, err := model.GetPiknoLLMRequest(user.Id, old.RequestID)
		require.NoError(t, err)
		assert.Equal(t, before, *after, "new submission preserves every old ledger field")
	})
	t.Run("live requests legacy rows and malformed nullable records still block", func(t *testing.T) {
		cases := []struct {
			name    string
			changes map[string]any
		}{
			{"reserved", map[string]any{"state": "reserved"}},
			{"dispatched", map[string]any{"state": "dispatched"}},
			{"recent unknown", map[string]any{"updated_at": common.GetTimestamp()}},
			{"legacy", map[string]any{"billing_mode": "", "price_version": "chat-cny-9-45-v1"}},
			{"other price", map[string]any{"price_version": "chat-future"}},
			{"reserved amount", map[string]any{"reserved_quota": 1}},
			{"charged amount", map[string]any{"charged_quota": 1}},
			{"refunded amount", map[string]any{"refunded_quota": 1}},
			{"future", map[string]any{"updated_at": common.GetTimestamp() + 3600}},
			{"unrecognized state", map[string]any{"state": "damaged"}},
		}
		for _, column := range []string{"state", "reserved_quota", "charged_quota", "refunded_quota", "input_tokens", "input_limit", "token_limited", "created_at", "updated_at", "billing_mode", "provider_input_rate"} {
			cases = append(cases, struct {
				name    string
				changes map[string]any
			}{"NULL " + column, map[string]any{column: nil}})
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				user, token, router := setupPiknoLLMTest(t)
				old := hamster53OldUnknown(t, user, token)
				// Preserve the deliberately malformed timestamp without GORM's
				// automatic UpdatedAt assignment (which duplicates NULL on PostgreSQL).
				require.NoError(t, model.DB.Model(old).UpdateColumns(tc.changes).Error)
				old, err := model.GetPiknoLLMRequest(user.Id, old.RequestID)
				require.NoError(t, err)
				assert.True(t, old.CustomerView().AdmissionBlocking)
				w := piknoLLMTestCall(router, token, "GET", "/assistant/v2/requests/"+old.RequestID, "", "")
				require.Equal(t, 200, w.Code)
				assert.Contains(t, w.Body.String(), `"admission_blocking":true`)
				_, _, err = model.ReservePiknoLLM(user.Id, token.Id, strings.Repeat("c", 32), strings.Repeat("b", 64), model.PiknoLLMPriceVersion, 100)
				assert.ErrorIs(t, err, model.ErrPiknoLLMBusy)
			})
		}
	})
	t.Run("late old usage and accepted new usage settle once without waiving debt", func(t *testing.T) {
		user, token, _ := setupPiknoLLMTest(t)
		old := hamster53OldUnknown(t, user, token)
		require.NoError(t, model.DB.Model(user).Update("quota", 1).Error)
		require.NoError(t, model.DB.Model(token).Update("remain_quota", 1).Error)
		id := strings.Repeat("c", 32)
		_, created, err := model.ReservePiknoLLM(user.Id, token.Id, id, strings.Repeat("b", 64), model.PiknoLLMPriceVersion, 100)
		require.NoError(t, err)
		require.True(t, created)
		require.NoError(t, model.DispatchPiknoLLM(user.Id, id))
		for range 2 {
			_, err = model.FinishPiknoLLM(user.Id, old.RequestID, "usage", 10, 2, 4)
			require.NoError(t, err)
		}
		_, err = model.FinishPiknoLLM(user.Id, old.RequestID, "not_submitted", 0, 0)
		require.NoError(t, err)
		_, err = model.FinishPiknoLLM(user.Id, id, "usage", 3, 1)
		require.NoError(t, err)
		var fresh model.User
		require.NoError(t, model.DB.First(&fresh, user.Id).Error)
		assert.Equal(t, -251, fresh.Quota)
		assert.Equal(t, 252, fresh.UsedQuota)
		assert.Equal(t, 2, fresh.RequestCount)
		old, err = model.GetPiknoLLMRequest(user.Id, old.RequestID)
		require.NoError(t, err)
		assert.Equal(t, 180, old.ChargedQuota)
		assert.Zero(t, old.RefundedQuota)
		assert.Equal(t, old.PriceVersion, model.PiknoLLMPriceVersion)
		_, _, err = model.ReservePiknoLLM(user.Id, token.Id, strings.Repeat("d", 32), strings.Repeat("b", 64), model.PiknoLLMPriceVersion, 100)
		assert.ErrorIs(t, err, model.ErrPiknoLLMQuota)
	})
	t.Run("expired unknown does not allow two new live slots", func(t *testing.T) {
		user, token, _ := setupPiknoLLMTest(t)
		old := hamster53OldUnknown(t, user, token)
		var wg sync.WaitGroup
		results := make(chan error, 2)
		for index := range 2 {
			wg.Go(func() {
				_, _, err := model.ReservePiknoLLM(user.Id, token.Id, strings.Repeat(fmt.Sprint(index+1), 32), strings.Repeat("b", 64), model.PiknoLLMPriceVersion, 100)
				results <- err
			})
		}
		wg.Wait()
		close(results)
		created := 0
		for err := range results {
			if err == nil {
				created++
			} else {
				assert.True(t, errors.Is(err, model.ErrPiknoLLMBusy), "%v", err)
			}
		}
		assert.Equal(t, 1, created)
		after, err := model.GetPiknoLLMRequest(user.Id, old.RequestID)
		require.NoError(t, err)
		assert.Equal(t, *old, *after)
	})
}
