package controller

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay/channel/openai"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type piknoMailTransport func(*http.Request) (*http.Response, error)

func (f piknoMailTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Exercise real dashboard authentication, single-use security proofs, financial
// transactions and the durable email worker together. No upstream or email
// provider is contacted; all users and credits belong to this isolated fixture.
func TestPiknoSettlementHTTP(t *testing.T) {
	user, _ := setupSecurityEnrollmentTest(t)
	previousBatch := common.BatchUpdateEnabled
	common.BatchUpdateEnabled = false
	t.Cleanup(func() { common.BatchUpdateEnabled = previousBatch })
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}, &model.Channel{}, &model.Ability{}, &model.Task{}))
	require.NoError(t, model.MigratePiknoSettlements(model.DB))
	require.NoError(t, model.DB.Model(user).Updates(map[string]any{"quota": 10000000, "email": "customer@example.com"}).Error)
	admin := model.User{Username: "piknoadmin", Password: user.Password, Role: 100, Status: 1, Group: "default", AffCode: "admin16", AuthVersion: 1, Email: "admin@example.com"}
	require.NoError(t, model.DB.Create(&admin).Error)
	require.NoError(t, model.PublishUserAuthCache(admin.Id))
	adminBundle, err := service.CreateLoginSession(admin.Id, "password", "127.0.0.1", "test")
	require.NoError(t, err)
	identity, err := service.ParseAccessToken(adminBundle.AccessToken)
	require.NoError(t, err)
	userBundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "test")
	require.NoError(t, err)
	token := model.Token{UserId: user.Id, Key: "isolated-only", RemainQuota: 5000000, Status: 1, ExpiredTime: -1}
	require.NoError(t, model.DB.Create(&token).Error)
	channel := model.Channel{Key: "isolated-only", Name: "fixture"}
	require.NoError(t, model.DB.Create(&channel).Error)
	quote := model.PiknoSettlementQuote{OrderID: "review-http", UserID: user.Id, TokenID: token.Id, ChannelID: channel.Id, Model: "video", AccountRef: "private-account", UpstreamTaskID: "private-task", PriceMode: "cost_x2", QuoteQuota: 1520000}
	_, err = model.ReservePiknoSettlement(quote)
	require.NoError(t, err)
	task := model.Task{TaskID: quote.OrderID, UserId: user.Id, ChannelId: channel.Id, Status: model.TaskStatusFailure, PrivateData: model.TaskPrivateData{BillingSource: service.BillingSourcePikno, TokenId: token.Id, UpstreamTaskID: quote.UpstreamTaskID}}
	require.NoError(t, model.DB.Create(&task).Error)
	_, err = model.ApplyPiknoSettlement(model.PiknoSettlementCommand{OrderID: quote.OrderID, OperationID: "observed", ExpectedVersion: 1, Action: "observe", Outcome: "failed"})
	require.NoError(t, err)
	router := gin.New()
	self := router.Group("/api/pikno/settlements/self", middleware.UserAuth())
	self.GET("/:id", PiknoSettlementDetail)
	root := router.Group("/api/pikno/settlements/admin", middleware.RootAuth(), PiknoSettlementReviewGuard)
	root.GET("", PiknoSettlementList)
	root.POST("/:id/preview", PiknoSettlementReview)
	root.POST("/:id/apply", PiknoSettlementReview)
	request := func(method, path, credential, body, proof, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+credential)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Security-Proof", proof)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	path := "/api/pikno/settlements/admin/review-http"
	origin := "https://www.piknoai.com"
	body := `{"operation_id":"review-1","version":2,"action":"failure","reason":"verified upstream debit","evidence_ref":"receipt-sha256","charged_quota":760000}`
	t.Run("customer_isolated_and_private_evidence_hidden", func(t *testing.T) {
		assert.Equal(t, 403, request("GET", "/api/pikno/settlements/admin", userBundle.AccessToken, "", "", origin).Code)
		assert.Equal(t, 403, request("POST", path+"/apply", userBundle.AccessToken, body, "", origin).Code)
		own := request("GET", "/api/pikno/settlements/self/review-http", userBundle.AccessToken, "", "", origin)
		require.Equal(t, 200, own.Code, own.Body.String())
		for _, private := range []string{"private-account", "private-task", "net_cost_quota", "evidence", "review_reason"} {
			assert.NotContains(t, own.Body.String(), private)
		}
		assert.Equal(t, 404, request("GET", "/api/pikno/settlements/self/review-http", adminBundle.AccessToken, "", "", origin).Code)
	})
	t.Run("preview_cannot_charge_and_missing_proof_or_wrong_origin_is_rejected", func(t *testing.T) {
		assert.Equal(t, 403, request("POST", path+"/preview", adminBundle.AccessToken, body, "", "https://evil.example").Code)
		assert.Equal(t, 403, request("POST", path+"/apply", adminBundle.AccessToken, body, "", origin).Code)
		preview := request("POST", path+"/preview", adminBundle.AccessToken, body, "", origin)
		require.Equal(t, 200, preview.Code, preview.Body.String())
		var response struct {
			Data model.PiknoReviewPreview `json:"data"`
		}
		require.NoError(t, common.Unmarshal(preview.Body.Bytes(), &response))
		assert.Equal(t, 760000, response.Data.AfterNet)
		assert.Equal(t, 760000, response.Data.WalletDelta)
		var wallet model.User
		require.NoError(t, model.DB.First(&wallet, user.Id).Error)
		assert.Equal(t, 8480000, wallet.Quota)
		assert.Zero(t, wallet.UsedQuota)
		ctx, err := common.Marshal(service.PiknoSettlementProofContext{Digest: response.Data.Digest})
		require.NoError(t, err)
		op := service.VerificationOperation{Scope: service.VerificationScopePiknoSettlementReview, Context: ctx}
		proof := issueSecurityEnrollmentProof(t, identity, op, service.VerificationMethodPassword)
		changed := strings.Replace(body, "760000", "700000", 1)
		assert.Equal(t, 403, request("POST", path+"/apply", adminBundle.AccessToken, changed, proof, origin).Code)
		proof = issueSecurityEnrollmentProof(t, identity, op, service.VerificationMethodPassword)
		applied := request("POST", path+"/apply", adminBundle.AccessToken, body, proof, origin)
		require.Equal(t, 200, applied.Code, applied.Body.String())
		assert.Equal(t, 409, request("POST", path+"/apply", adminBundle.AccessToken, body, proof, origin).Code)
		require.NoError(t, model.DB.First(&wallet, user.Id).Error)
		assert.Equal(t, 9240000, wallet.Quota)
		assert.Equal(t, 760000, wallet.UsedQuota)
		require.NoError(t, model.DB.First(&task, task.ID).Error)
		assert.Equal(t, 760000, task.Quota, "task log must track reviewed consumption, not the quote")
		var count int64
		require.NoError(t, model.DB.Model(&model.PiknoSettlementEvent{}).Where("order_id = ? AND action = ?", quote.OrderID, "failure").Count(&count).Error)
		assert.EqualValues(t, 1, count)
	})
	t.Run("outbox_retries_use_identical_payload_and_provider_key", func(t *testing.T) {
		// Include a poison item: it must not block valid notifications.
		bad := model.PiknoSettlementOutbox{EventID: 900001, UserID: 999999, Kind: "admin_review_reminder", Payload: `{}`}
		require.NoError(t, model.DB.Create(&bad).Error)
		now := common.GetTimestamp()
		_, err := model.ClaimPiknoSettlementMail(bad.ID, now)
		require.NoError(t, err)
		require.NoError(t, model.DB.First(&bad, bad.ID).Error)
		assert.Equal(t, "manual_review", bad.DeliveryState)
		// Customer consumption emails are disabled. Exercise retry delivery using
		// synthetic administrator reminders instead of the legacy customer rows.
		var settlement model.PiknoSettlement
		require.NoError(t, model.DB.First(&settlement, "id = ?", quote.OrderID).Error)
		payload, err := common.Marshal(settlement.CustomerView())
		require.NoError(t, err)
		for index := range 2 {
			reminder := model.PiknoSettlementOutbox{EventID: int64(900002 + index), UserID: admin.Id, Kind: "admin_review_reminder", Payload: string(payload)}
			require.NoError(t, model.DB.Create(&reminder).Error)
		}
		var item model.PiknoSettlementOutbox
		require.NoError(t, model.DB.Where("user_id = ?", admin.Id).Order("id desc").First(&item).Error)
		claimed, err := model.ClaimPiknoSettlementMail(item.ID, now)
		require.NoError(t, err)
		require.NotNil(t, claimed)
		require.Equal(t, admin.Email, claimed.Recipient)
		again, err := model.ClaimPiknoSettlementMail(item.ID, now)
		require.NoError(t, err)
		require.Nil(t, again)
		var requests, keys []string
		client := &http.Client{Transport: piknoMailTransport(func(r *http.Request) (*http.Response, error) {
			b, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			requests = append(requests, string(b))
			keys = append(keys, r.Header.Get("Idempotency-Key"))
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"test"}`)), Header: make(http.Header)}, nil
		})}
		mailer := service.PiknoResendMailer{Client: client, Key: "test-not-real", From: "billing@example.com"}
		require.NoError(t, mailer.Send(context.Background(), claimed))
		// Provider accepted, process crashed before ack; lease expires and retry
		// receives the same request even after a sender configuration change.
		retry, err := model.ClaimPiknoSettlementMail(item.ID, now+61)
		require.NoError(t, err)
		require.NotNil(t, retry)
		mailer.From = "changed@example.com"
		require.NoError(t, mailer.Send(context.Background(), retry))
		assert.Equal(t, requests[0], requests[1])
		assert.Equal(t, keys[0], keys[1])
		assert.NotContains(t, requests[0], "receipt-sha256")
		assert.NotContains(t, requests[0], "private-account")
		require.ErrorIs(t, model.FinishPiknoSettlementMail(claimed, now+62, true), model.ErrPiknoConflict)
		require.NoError(t, model.FinishPiknoSettlementMail(retry, now+62, true))
		again, err = model.ClaimPiknoSettlementMail(item.ID, now+63)
		require.NoError(t, err)
		require.Nil(t, again)
		var another model.PiknoSettlementOutbox
		require.NoError(t, model.DB.Where("user_id = ? AND id <> ?", admin.Id, item.ID).First(&another).Error)
		_, err = model.ClaimPiknoSettlementMail(another.ID, now)
		require.NoError(t, err)
		again, err = model.ClaimPiknoSettlementMail(another.ID, now+23*3600)
		require.NoError(t, err)
		require.Nil(t, again)
		require.NoError(t, model.DB.First(&another, another.ID).Error)
		assert.Equal(t, "manual_review", another.DeliveryState)
	})
}

func TestPiknoSettlementLifecycle(t *testing.T) {
	user, _ := setupSecurityEnrollmentTest(t)
	t.Setenv("PIKNO_SETTLEMENT_ENABLED", "true")
	oldBatch := common.BatchUpdateEnabled
	common.BatchUpdateEnabled = false
	t.Cleanup(func() { common.BatchUpdateEnabled = oldBatch })
	require.NoError(t, model.DB.AutoMigrate(&model.Token{}, &model.Channel{}, &model.Ability{}, &model.Task{}))
	require.NoError(t, service.InitPiknoSettlement())
	require.NoError(t, model.DB.Model(user).Update("quota", 10000000).Error)
	token := model.Token{UserId: user.Id, Key: "lifecycle-only", Group: "image-standard", RemainQuota: 5000000, Status: 1, ExpiredTime: -1}
	require.NoError(t, model.DB.Create(&token).Error)
	baseURL := "https://cf.api.fan"
	channel := model.Channel{Type: 1, Key: "lifecycle-only", Name: "fixture", Status: common.ChannelStatusEnabled, BaseURL: &baseURL, Group: "default"}
	require.NoError(t, channel.Insert())
	line := model.PiknoLineSeed{PublicModel: "pikno-image-legacy-test", SourceID: "gpt-image-2.5-flare", DisplayName: "Flare", Kind: "image", Provider: "packy", UpstreamModel: "gpt-image-2.5-flare", ChannelID: channel.Id, Enabled: true, UpstreamAvailable: true, Resolutions: []string{"1024x1024"}, Prices: []model.PiknoLinePrice{{Resolution: "default", Unit: "image", SuggestedCNY: 0.1, RetailQuota: 100000}}}
	require.NoError(t, model.SyncPiknoLines([]model.PiknoLineSeed{line}, user.Id))
	_, err := model.PublishPiknoLine(line.PublicModel, 1, user.Id)
	require.NoError(t, err)
	publicCatalog, err := PiknoPublicLinesData()
	require.NoError(t, err)
	publicJSON, err := common.Marshal(publicCatalog)
	require.NoError(t, err)
	assert.Contains(t, string(publicJSON), line.PublicModel)
	for _, privateField := range []string{`"provider"`, `"upstream_model"`, `"channel_id"`, `"cost_cny"`, `"retail_quota"`} {
		assert.NotContains(t, string(publicJSON), privateField)
	}
	var publishedChannel model.Channel
	require.NoError(t, model.DB.First(&publishedChannel, channel.Id).Error)
	require.Contains(t, publishedChannel.GetModels(), line.PublicModel)
	var publishedAbilities []model.Ability
	require.NoError(t, model.DB.Where("channel_id = ?", channel.Id).Find(&publishedAbilities).Error)
	require.NotEmpty(t, publishedAbilities)
	for _, handler := range []struct {
		name string
		run  func(*gin.Context)
	}{
		{name: "legacy pricing", run: PiknoLines},
		{name: "user model selector", run: PiknoUserModels},
		{name: "dashboard models", run: PiknoDashboardModels},
	} {
		t.Run(handler.name+" exposes aliases only", func(t *testing.T) {
			recorder := httptest.NewRecorder()
			requestContext, _ := gin.CreateTestContext(recorder)
			requestContext.Set("id", user.Id)
			common.SetContextKey(requestContext, constant.ContextKeyUserGroup, "default")
			common.SetContextKey(requestContext, constant.ContextKeyTokenGroup, "image-standard")
			require.Equal(t, "default", common.GetContextKeyString(requestContext, constant.ContextKeyUserGroup))
			handler.run(requestContext)
			assert.Equal(t, http.StatusOK, recorder.Code)
			assert.Contains(t, recorder.Body.String(), line.PublicModel)
			assert.NotContains(t, recorder.Body.String(), line.UpstreamModel)
			if handler.name == "legacy pricing" {
				assert.Contains(t, recorder.Body.String(), `"retail_cny":"0.100000"`)
			} else {
				assert.NotContains(t, recorder.Body.String(), `"prices"`)
			}
			assert.NotContains(t, recorder.Body.String(), `"cost_cny"`)
		})
	}
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest("POST", "/v1/images/generations", strings.NewReader(`{}`))
	image := &relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, RequestId: "flare-lifecycle", OriginModelName: line.PublicModel, Request: &dto.ImageRequest{Size: "1024x1024"}, ChannelMeta: &relaycommon.ChannelMeta{ChannelId: channel.Id, ChannelBaseUrl: baseURL, ApiKey: "test-only"}}
	require.Nil(t, service.PrepareImageBillingForRequest(context, image, 1))
	require.NoError(t, service.PiknoBeforeDispatch(image))
	require.Error(t, service.PiknoBeforeDispatch(image), "a second generation must never be sent for the same reservation")
	image.UpdateImageCount(1)
	require.NoError(t, service.SettleBilling(context, image, 999999), "legacy calculated quota is not authoritative for fixed-price Flare")
	image.Billing.Refund(context)
	require.NoError(t, service.SettleBilling(context, image, 999999))
	var wallet model.User
	require.NoError(t, model.DB.First(&wallet, user.Id).Error)
	assert.Equal(t, 9900000, wallet.Quota)
	assert.Equal(t, 100000, wallet.UsedQuota)
	assert.Equal(t, 1, wallet.RequestCount)
	var limited model.Token
	require.NoError(t, model.DB.First(&limited, token.Id).Error)
	assert.Equal(t, 4900000, limited.RemainQuota)
	assert.Equal(t, 100000, limited.UsedQuota)
	t.Run("image_usage_without_client_quote", func(t *testing.T) {
		line := line
		line.PublicModel, line.SourceID, line.UpstreamModel = "pikno-image-flare", "gpt-image-2", "gpt-image-2"
		require.NoError(t, model.SyncPiknoLines([]model.PiknoLineSeed{line}, user.Id))
		_, err := model.PublishPiknoLine(line.PublicModel, 1, user.Id)
		require.NoError(t, err)
		published, err := model.GetPublishedPiknoLine(line.PublicModel)
		require.NoError(t, err)
		t.Setenv("PIKNO_IMAGE_USAGE_BILLING_ENABLED", "false")
		assert.Empty(t, publicPiknoLine(*published).ImageBilling)
		legacyQuoteRecorder := httptest.NewRecorder()
		legacyQuoteContext, _ := gin.CreateTestContext(legacyQuoteRecorder)
		legacyQuoteContext.Request = httptest.NewRequest(http.MethodPost, "/v1/client/quote", strings.NewReader(`{"model":"pikno-image-flare","operation":"image","quantity":1,"resolution":"1024x1024"}`))
		legacyQuoteContext.Request.Header.Set("Content-Type", "application/json")
		legacyQuoteContext.Set("id", user.Id)
		legacyQuoteContext.Set("token_id", token.Id)
		common.SetContextKey(legacyQuoteContext, constant.ContextKeyTokenGroup, "image-standard")
		PiknoPriceQuote(legacyQuoteContext)
		require.Equal(t, http.StatusOK, legacyQuoteRecorder.Code)
		assert.Contains(t, legacyQuoteRecorder.Body.String(), `"unit_price_cny":"0.100000"`)
		t.Setenv("PIKNO_IMAGE_USAGE_BILLING_ENABLED", "true")
		assert.Equal(t, service.PiknoImageUsageVersion, publicPiknoLine(*published).ImageBilling)

		params := model.PiknoPriceParameters{Model: line.PublicModel, Operation: "image", Quantity: 1, Resolution: "1024x1024"}
		oldQuote, err := model.SignPiknoPriceContext(model.PiknoPriceContext{UserID: user.Id, TokenID: token.Id, Revision: published.Revision, Quota: 100000, Parameters: params})
		require.NoError(t, err)
		oldContext, err := model.ParsePiknoPriceContext(oldQuote)
		require.NoError(t, err)
		oldSlot, err := model.PiknoPriceSlotID(oldContext, 0)
		require.NoError(t, err)
		for _, route := range []struct {
			path      string
			body      string
			guard     gin.HandlerFunc
			withQuote bool
		}{
			{"/v1/client/quote", `{"model":"pikno-image-flare","operation":"image","quantity":1,"resolution":"1024x1024"}`, PiknoPriceQuote, false},
			{"/v1/images/generations", `{"model":"pikno-image-flare","prompt":"synthetic","size":"1024x1024","n":1}`, PiknoMediaGuard, false},
			{"/v1/images/generations", `{"model":"pikno-image-flare","prompt":"synthetic","size":"1024x1024","n":1}`, PiknoMediaGuard, true},
		} {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, route.path, strings.NewReader(route.body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			ctx.Set("id", user.Id)
			ctx.Set("token_id", token.Id)
			common.SetContextKey(ctx, constant.ContextKeyTokenGroup, "image-standard")
			if route.withQuote {
				ctx.Request.Header.Set("X-PIKNO-Quote", oldQuote)
				ctx.Request.Header.Set("X-PIKNO-Quote-Index", "0")
			}
			route.guard(ctx)
			require.True(t, ctx.IsAborted())
			assert.Equal(t, http.StatusConflict, recorder.Code)
			assert.Contains(t, recorder.Body.String(), service.PiknoImageUpgradeCode)
			assert.Contains(t, recorder.Body.String(), "请更新仓鼠AI")
		}
		unclaimed, err := model.FindPiknoPriceSlot(oldSlot)
		require.NoError(t, err)
		assert.Nil(t, unclaimed, "reject legacy attempts before claiming their quote")
		legacy := relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: line.PublicModel, Request: image.Request, ChannelMeta: image.ChannelMeta}
		refusal := service.PrepareImageBillingForRequest(context, &legacy, 1)
		require.NotNil(t, refusal)
		assert.Equal(t, service.PiknoImageUpgradeCode, string(refusal.GetErrorCode()))
		assert.Nil(t, legacy.Billing)
		for _, tc := range []struct {
			name, outcome, review   string
			opening, tokenOpening   int
			outputTokens, net, held int
		}{
			{"refund_unused_reservation", "succeeded", "", 10_000_000, 5_000_000, 100, 30_050, 0},
			{"debit_more_than_reservation", "succeeded", "", 10_000_000, 5_000_000, 1_000, 300_050, 0},
			{"wallet_cannot_cover_delta", "succeeded", "insufficient_balance_for_image_usage", 150_000, 5_000_000, 1_000, 0, 100_000},
			{"limited_key_cannot_cover_delta", "succeeded", "insufficient_balance_for_image_usage", 10_000_000, 150_000, 1_000, 0, 100_000},
			{"no_trusted_usage", "succeeded", "missing_final_image_usage", 10_000_000, 5_000_000, 0, 0, 100_000},
			{"explicit_failure_releases_reservation", "failed", "", 10_000_000, 5_000_000, 0, 0, 0},
		} {
			t.Run(tc.name, func(t *testing.T) {
				require.NoError(t, model.DB.Model(user).Updates(map[string]any{"quota": tc.opening, "used_quota": 0, "request_count": 0}).Error)
				require.NoError(t, model.DB.Model(&token).Updates(map[string]any{"remain_quota": tc.tokenOpening, "used_quota": 0}).Error)
				op := "image-" + tc.name + ":0"
				ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
				ctx.Request = httptest.NewRequest("POST", "/v1/images/generations", strings.NewReader(`{"model":"pikno-image-flare","prompt":"synthetic","size":"1024x1024","n":1}`))
				ctx.Request.Header.Set("Content-Type", "application/json")
				ctx.Request.Header.Set("X-Pikno-Image-Billing", "usage-v1")
				ctx.Request.Header.Set("Idempotency-Key", op)
				ctx.Set("id", user.Id)
				ctx.Set("token_id", token.Id)
				common.SetContextKey(ctx, constant.ContextKeyTokenGroup, "image-standard")
				PiknoMediaGuard(ctx)
				require.False(t, ctx.IsAborted())
				require.Equal(t, op, ctx.GetString("pikno_image_operation"))
				require.Empty(t, ctx.GetHeader("Idempotency-Key"))
				i := relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: line.PublicModel,
					PiknoImageOperation: ctx.GetString("pikno_image_operation"), Request: &dto.ImageRequest{Size: "1024x1024"}, ChannelMeta: image.ChannelMeta}
				require.Nil(t, service.PrepareImageBillingForRequest(ctx, &i, 1))
				require.NoError(t, service.PiknoBeforeDispatch(&i))
				replay := relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: line.PublicModel,
					PiknoImageOperation: op, Request: i.Request, ChannelMeta: i.ChannelMeta}
				duplicate := service.PrepareImageBillingForRequest(ctx, &replay, 1)
				require.NotNil(t, duplicate)
				assert.Equal(t, 409, duplicate.StatusCode)
				assert.Nil(t, replay.Billing)
				if tc.outcome == "failed" {
					i.PiknoExplicitFailure = true
					i.Billing.Refund(ctx)
				} else {
					body := `{"data":[{"b64_json":"synthetic"}]}`
					if tc.outputTokens > 0 {
						body = fmt.Sprintf(`{"data":[{"b64_json":"synthetic"}],"usage":{"input_tokens":1,"output_tokens":%d,"total_tokens":%d}}`, tc.outputTokens, tc.outputTokens+1)
					}
					_, parseErr := openai.OpenaiImageHandler(ctx, &i, &http.Response{StatusCode: http.StatusOK,
						Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))})
					require.Nil(t, parseErr)
					require.NoError(t, service.SettleBilling(ctx, &i, 999999), "only authenticated image usage determines the net debit")
				}
				var latest model.PiknoSettlement
				// Select the exact server-scoped operation rather than any earlier pending order.
				digest := sha256.Sum256([]byte(fmt.Sprintf("%d\x00%s", user.Id, op)))
				require.NoError(t, model.DB.First(&latest, "id = ?", fmt.Sprintf("img_%x", digest)).Error)
				assert.Equal(t, tc.outcome, latest.GenerationState)
				assert.Equal(t, tc.net, latest.NetQuota)
				assert.Equal(t, tc.held, latest.ReservedQuota)
				assert.Equal(t, tc.review, latest.ReviewReason)
				if tc.outputTokens > 0 {
					require.NotNil(t, latest.ImageUsageQuota)
					assert.Equal(t, tc.outputTokens*300+50, *latest.ImageUsageQuota)
					assert.Equal(t, latest.ImageUsageQuota, latest.AdminView().ImageUsageQuota)
					customer, err := common.Marshal(latest.CustomerView())
					require.NoError(t, err)
					assert.NotContains(t, string(customer), "image_usage_quota")
				}
				require.NoError(t, model.DB.First(&wallet, user.Id).Error)
				assert.Equal(t, tc.opening-tc.net-tc.held, wallet.Quota)
				assert.Equal(t, tc.net, wallet.UsedQuota)
				assert.Equal(t, 1, wallet.RequestCount)
				require.NoError(t, model.DB.First(&limited, token.Id).Error)
				assert.Equal(t, tc.tokenOpening-tc.net-tc.held, limited.RemainQuota)
			})
		}
		require.NoError(t, model.DB.Model(user).Update("quota", 50_000).Error)
		unfunded := relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: line.PublicModel,
			PiknoImageOperation: "image-insufficient:0", Request: image.Request, ChannelMeta: image.ChannelMeta}
		refusal = service.PrepareImageBillingForRequest(context, &unfunded, 1)
		require.NotNil(t, refusal)
		assert.Equal(t, http.StatusPaymentRequired, refusal.StatusCode)
		assert.Equal(t, "insufficient_balance", string(refusal.GetErrorCode()))
		assert.Nil(t, unfunded.Billing)
		t.Setenv("PIKNO_IMAGE_USAGE_BILLING_ENABLED", "false")
		digest := sha256.Sum256([]byte(fmt.Sprintf("%d\x00%s", user.Id, "image-debit_more_than_reservation:0")))
		var settledUsage model.PiknoSettlement
		require.NoError(t, model.DB.First(&settledUsage, "id = ?", fmt.Sprintf("img_%x", digest)).Error)
		assert.Equal(t, 300_050, settledUsage.CustomerView().NetQuota)
		require.NoError(t, model.DB.Model(user).Updates(map[string]any{"quota": 9_900_000, "used_quota": 100_000, "request_count": 1}).Error)
		require.NoError(t, model.DB.Model(&token).Updates(map[string]any{"remain_quota": 4_900_000, "used_quota": 100_000}).Error)
	})
	video := &relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: "video", TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_recover"}, ChannelMeta: image.ChannelMeta}
	require.Nil(t, service.PreConsumeBilling(context, 1520000, video))
	require.NoError(t, service.PiknoBeforeDispatch(video))
	require.NoError(t, service.SettleBilling(context, video, 0), "submission is not final consumption")
	task := model.Task{TaskID: "task_recover", UserId: user.Id, ChannelId: channel.Id, Quota: 1520000, Status: model.TaskStatusFailure, PrivateData: model.TaskPrivateData{BillingSource: service.BillingSourcePikno, TokenId: token.Id, UpstreamTaskID: "upstream-recovery"}}
	require.NoError(t, model.DB.Create(&task).Error)
	// Simulate process death before the terminal settlement callback. The
	// bounded scan repairs the task/order association and queues manual review.
	_, err = service.ReconcilePiknoSettlements("", common.GetTimestamp())
	require.NoError(t, err)
	assert.False(t, service.RefundTaskQuota(context, &task, "legacy fallback"))
	service.RecalculateTaskQuota(context, &task, 0, "legacy fallback")
	service.LogTaskConsumption(context, video, &task)
	var order model.PiknoSettlement
	require.NoError(t, model.DB.First(&order, "id = ?", task.TaskID).Error)
	assert.Equal(t, "pending_review", order.FinancialState)
	assert.Equal(t, "failed", order.GenerationState)
	assert.Equal(t, 1520000, order.ReservedQuota)
	assert.Zero(t, order.NetQuota)
	require.NoError(t, model.DB.First(&wallet, user.Id).Error)
	assert.Equal(t, 8380000, wallet.Quota)
	assert.Equal(t, 100000, wallet.UsedQuota)
	assert.Equal(t, 2, wallet.RequestCount)
	var observations int64
	require.NoError(t, model.DB.Model(&model.PiknoSettlementEvent{}).Where("order_id = ? AND action = ?", task.TaskID, "observe").Count(&observations).Error)
	assert.EqualValues(t, 1, observations)
	for _, tc := range []struct {
		name, model, body string
		status            model.TaskStatus
		net, reserved     int
	}{
		{"sanbao-success", "sanbao/video/test", `{"data":{"id":"upstream-v2","status":"succeeded","cost":999,"video_url":"https://example.com/video.mp4"}}`, model.TaskStatusSuccess, 1520000, 0},
		{"cansee-success", "canseedream/video/test", `{"id":"upstream-v2","status":"succeeded","content":{"video_url":"https://example.com/video.mp4"},"usage":{"points":999}}`, model.TaskStatusSuccess, 1520000, 0},
		{"failure", "canseedream/video/test", `{"id":"upstream-v2","status":"failed","usage":{"points":76}}`, model.TaskStatusFailure, 0, 0},
		{"local-poll-failure", "sanbao/video/test", `{"data":{"id":"upstream-v2","status":"processing"}}`, model.TaskStatusFailure, 0, 1520000},
		{"empty-result", "sanbao/video/test", `{"data":{"id":"upstream-v2","status":"succeeded","video_url":""}}`, model.TaskStatusSuccess, 0, 1520000},
		{"wrong-task", "canseedream/video/test", `{"id":"other","status":"failed"}`, model.TaskStatusFailure, 0, 1520000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, model.DB.Model(user).Update("quota", 10000000).Error)
			require.NoError(t, model.DB.Model(&token).Update("remain_quota", 5000000).Error)
			v := &relaycommon.RelayInfo{UserId: user.Id, TokenId: token.Id, OriginModelName: tc.model, TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "v2-" + tc.name}, ChannelMeta: image.ChannelMeta}
			require.NoError(t, service.NewPiknoBillingSession(v, 1520000))
			job := model.Task{TaskID: v.PublicTaskID, UserId: user.Id, ChannelId: channel.Id, Status: tc.status, PrivateData: model.TaskPrivateData{BillingSource: service.BillingSourcePikno, UpstreamTaskID: "upstream-v2"}}
			job.Data = []byte(tc.body)
			require.NoError(t, model.DB.Create(&job).Error)
			require.NoError(t, service.PiknoRecordTask(&job))
			require.NoError(t, service.PiknoRecordTask(&job))
			var s model.PiknoSettlement
			require.NoError(t, model.DB.First(&s, "id = ?", job.TaskID).Error)
			assert.Equal(t, "video_success_quote", s.PriceMode)
			assert.Equal(t, tc.net, s.NetQuota)
			assert.Equal(t, tc.reserved, s.ReservedQuota)
			var balance model.User
			require.NoError(t, model.DB.First(&balance, user.Id).Error)
			assert.Equal(t, 10000000-tc.net-tc.reserved, balance.Quota)
		})
	}
}
