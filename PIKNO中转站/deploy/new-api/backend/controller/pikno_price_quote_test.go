package controller

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

//go:embed testdata/node-name-price.json
var piknoNodePriceWireContract []byte

func TestPiknoPriceQuote(t *testing.T) {
	require.NoError(t, i18n.Init())
	gin.SetMode(gin.TestMode)
	user, _ := setupResponsesWSRequestTest(t)
	require.NoError(t, model.DB.Model(user).Update("quota", 50_000_000).Error)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.Task{}, &model.PiknoLine{}))
	// Upgrade an existing database, then repeat migration. Existing customer
	// rows and balances survive; only the new admission table is added.
	require.NoError(t, model.DB.AutoMigrate(&model.PiknoSettlement{}, &model.PiknoSettlementEvent{}, &model.PiknoSettlementOutbox{}))
	historical := model.PiknoSettlement{ID: "price-upgrade-history", UserID: user.Id, TokenID: 1, Model: "historical-model", QuoteQuota: 123456, NetQuota: 123456, GenerationState: "succeeded", FinancialState: "settled"}
	require.NoError(t, model.DB.Create(&historical).Error)
	require.NoError(t, model.MigratePiknoSettlements(model.DB))
	require.NoError(t, model.MigratePiknoSettlements(model.DB))
	require.NoError(t, model.DB.First(&historical, "id = ?", historical.ID).Error)
	assert.Equal(t, 123456, historical.NetQuota)
	require.NoError(t, model.DB.First(user, user.Id).Error)
	assert.Equal(t, 50_000_000, user.Quota)
	t.Setenv("PIKNO_SETTLEMENT_ENABLED", "true")
	t.Setenv("PIKNO_MEDIA_ENABLED", "true")
	t.Setenv("PIKNO_MEDIA_TICKET_KEY", "price-test-only-media-secret-123456789")
	t.Setenv("PIKNO_TOOLS_ENABLED", "true")
	t.Setenv("PIKNO_TOOLS_BRIDGE_SECRET", "price-test-only-bridge-secret-123456789")
	oldGroups, oldRatios := setting.UserUsableGroups2JSONString(), ratio_setting.GroupRatio2JSONString()
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"Default","image-standard":"Image","video-standard":"Video","tool-standard":"Tools"}`))
	require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(`{"default":1,"image-standard":1,"video-standard":1,"tool-standard":1}`))
	t.Cleanup(func() {
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(oldGroups))
		require.NoError(t, ratio_setting.UpdateGroupRatioByJSONString(oldRatios))
	})
	keys := map[string]string{}
	tokens := map[string]model.Token{}
	for _, kind := range []string{"image", "video", "tool"} {
		token := model.Token{UserId: user.Id, Name: "price-fixture", Key: "price" + kind + "testonly1234567890123456789", Group: kind + "-standard", Status: common.TokenStatusEnabled, ExpiredTime: -1, UnlimitedQuota: true}
		require.NoError(t, model.DB.Create(&token).Error)
		tokens[kind], keys[kind] = token, "Bearer sk-"+token.Key
	}
	baseURL := "https://cf.api.fan"
	channel := model.Channel{Name: "price-fixture", Key: "private-upstream-test-only", Status: common.ChannelStatusEnabled, Type: constant.ChannelTypeOpenAI, BaseURL: &baseURL}
	require.NoError(t, channel.Insert())
	cost := 123.456
	lines := map[string]model.PiknoLineConfig{
		"image":   {PublicModel: "pikno-image-price-test", DisplayName: "图片产品示例", Kind: "image", Provider: "packy", SourceID: "private/source", UpstreamModel: "gpt-image-2", Resolutions: []string{"1024x1024", "1536x1024"}, Qualities: []string{"auto", "high"}, MaxImages: 1, Prices: []model.PiknoLinePrice{{Resolution: "default", Unit: "image", RetailQuota: 100000, CostCNY: &cost, SuggestedCNY: 987}, {Resolution: "1536x1024", Unit: "image", RetailQuota: 200000}}},
		"video":   {PublicModel: "pikno-video-price-test", DisplayName: "视频产品示例", Kind: "video", Provider: "canseedream", SourceID: "private/source-video", UpstreamModel: "private-video-id", Resolutions: []string{"480p", "720p"}, Ratios: []string{"16:9"}, Durations: []float64{4, 8}, MaxImages: 2, MaxVideos: 1, MaxAudio: 1, ReferenceSurchargeQuota: 100000, Prices: []model.PiknoLinePrice{{Resolution: "480p", Unit: "second", RetailQuota: 200000, CostCNY: &cost}, {Resolution: "720p", Unit: "request", RetailQuota: 3000000}}},
		"digital": {PublicModel: "pikno-tool-digital", DisplayName: "数字人产品示例", Kind: "video", Provider: "hamster-tools", UpstreamModel: "digital", PluginKey: "pikno-tools", MaxImages: 1, MaxAudio: 1, Prices: []model.PiknoLinePrice{{Resolution: "default", Unit: "request", RetailQuota: 5000000}}},
		"depth":   {PublicModel: "pikno-tool-depth", DisplayName: "深度产品示例", Kind: "video", Provider: "hamster-tools", UpstreamModel: "depth", PluginKey: "pikno-tools", MaxVideos: 1, Prices: []model.PiknoLinePrice{{Resolution: "default", Unit: "request", RetailQuota: 500000}}},
	}
	for key, line := range lines {
		line.Enabled, line.UpstreamAvailable, line.ChannelID, line.Revision = true, true, channel.Id, 1
		raw, err := common.Marshal(line)
		require.NoError(t, err)
		require.NoError(t, model.DB.Create(&model.PiknoLine{PublicModel: line.PublicModel, Version: 1, PublishedConfig: string(raw)}).Error)
		group := key
		if key == "digital" || key == "depth" {
			group = "tool"
		}
		require.NoError(t, model.DB.Create(&model.Ability{Group: group + "-standard", Model: line.PublicModel, ChannelId: channel.Id, Enabled: true}).Error)
		lines[key] = line
	}
	seeds := []model.PiknoLineSeed{}
	for _, line := range lines {
		seeds = append(seeds, line)
	}
	require.NoError(t, model.SyncPiknoLines(seeds, 1))
	t.Cleanup(func() {
		for _, line := range lines {
			require.NoError(t, model.DB.Unscoped().Where("public_model = ?", line.PublicModel).Delete(&model.PiknoLine{}).Error)
		}
		require.NoError(t, model.DB.Where("channel_id = ?", channel.Id).Delete(&model.Ability{}).Error)
		require.NoError(t, model.DB.Unscoped().Delete(&channel).Error)
		require.NoError(t, model.DB.Where("user_id = ?", user.Id).Delete(&model.PiknoPriceQuoteSlot{}).Error)
		require.NoError(t, model.DB.Where("user_id = ?", user.Id).Delete(&model.PiknoSettlement{}).Error)
		require.NoError(t, model.DB.Where("name = ?", "price-fixture").Delete(&model.Token{}).Error)
	})
	transport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = transport })
	var networkCalls, dispatches atomic.Int64
	http.DefaultTransport = piknoTestTransport(func(r *http.Request) (*http.Response, error) {
		networkCalls.Add(1)
		if r.URL.Path == "/media/v1/tools/status" {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"enabled":true,"credential_configured":true,"ready":true,"tools":{"digital":{"available":true,"max_audio_seconds":30},"depth":{"available":true}}}`))}, nil
		}
		kind := "image/png"
		if strings.Contains(r.URL.Path, strings.Repeat("b", 32)) {
			kind = "video/mp4"
		}
		if strings.Contains(r.URL.Path, strings.Repeat("c", 32)) {
			kind = "audio/mpeg"
		}
		id := strings.Split(r.URL.Path, "/")[4]
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(fmt.Sprintf(`{"id":%q,"owner_id":%d,"size":16,"content_type":%q,"status":"ready"}`, id, user.Id, kind)))}, nil
	})
	assets := map[string]string{}
	for kind, letter := range map[string]string{"image": "a", "video": "b", "audio": "c"} {
		mime := map[string]string{"image": "image/png", "video": "video/mp4", "audio": "audio/mpeg"}[kind]
		now := time.Now().Unix()
		ticket := piknoMediaTicket{1, "pikno-relay-media", user.Id, strings.Repeat(letter, 32), "read", now, now + 3600, mime, 16}
		signed, err := piknoSignMedia(ticket, "price-test-only-media-secret-123456789")
		require.NoError(t, err)
		assets[kind] = "https://www.piknoai.com/media/v1/assets/" + ticket.ID + "?ticket=" + signed
	}
	engine := gin.New()
	engine.POST("/v1/client/quote", middleware.TokenAuth(), PiknoPriceQuote)
	var repriceBeforeReservation bool
	handler := func(c *gin.Context) {
		raw, _ := io.ReadAll(c.Request.Body)
		var body map[string]any
		if c.GetBool("pikno_direct_multipart") {
			body = make(map[string]any)
			for field, values := range c.Request.MultipartForm.Value {
				body[field] = values[0]
			}
		} else if common.Unmarshal(raw, &body) != nil {
			c.Status(400)
			return
		}
		id, _ := body["model"].(string)
		line, err := model.GetPublishedPiknoLine(id)
		if err != nil {
			c.Status(500)
			return
		}
		usage := model.PiknoLineUsage{Requests: 1, Images: 1}
		if size, ok := body["size"].(string); ok {
			usage.Resolution = size
		}
		if resolution, ok := body["resolution"].(string); ok {
			usage.Resolution = resolution
		}
		if seconds, ok := body["seconds"].(float64); ok {
			usage.Seconds = int(seconds)
		}
		if refs, ok := body["image_urls"].([]any); ok {
			usage.ReferenceImages = len(refs)
		}
		quote, err := model.QuotePublishedPiknoLine(id, line.ChannelID, usage)
		if err != nil {
			c.Status(500)
			return
		}
		common.SetContextKey(c, constant.ContextKeyOriginalModel, id)
		info := relaycommon.GenRelayInfoImage(c, nil)
		info.UserId, info.TokenId, info.OriginModelName = user.Id, c.GetInt("token_id"), id
		info.ChannelMeta = &relaycommon.ChannelMeta{ChannelId: channel.Id, ApiKey: channel.Key, ChannelBaseUrl: baseURL}
		info.PiknoLineRevision, info.PiknoLineQuoteQuota, info.PiknoLinePriceUnit = quote.Revision, quote.Quota, quote.Unit
		info.ImageRequestCount = 1
		if line.Kind == "video" {
			info.TaskRelayInfo = &relaycommon.TaskRelayInfo{PublicTaskID: "task_np_" + common.GetRandomString(20)}
		}
		if repriceBeforeReservation {
			next := *line
			next.Revision++
			next.Prices = append([]model.PiknoLinePrice{}, line.Prices...)
			next.Prices[0].RetailQuota++
			updated, _ := common.Marshal(next)
			if model.DB.Model(&model.PiknoLine{}).Where("public_model = ?", id).Updates(map[string]any{"version": next.Revision, "published_config": string(updated)}).Error != nil {
				c.Status(500)
				return
			}
		}
		if apiErr := service.PreConsumeBilling(c, quote.Quota, info); apiErr != nil {
			if apiErr.StatusCode == http.StatusPaymentRequired {
				assert.True(t, service.TaskErrorFromAPIError(apiErr).LocalError, "the wallet rejection is local to the customer")
			}
			c.JSON(apiErr.StatusCode, gin.H{"error": gin.H{"code": string(apiErr.GetErrorCode())}})
			return
		}
		if err := service.PiknoBeforeDispatch(info); err != nil {
			c.Status(500)
			return
		}
		dispatches.Add(1)
		c.Status(204)
	}
	for _, path := range []string{"/v1/images/generations", "/v1/images/edits", "/v1/videos", "/v1/tools/digital", "/v1/tools/depth"} {
		engine.POST(path, middleware.TokenAuth(), PiknoMediaGuard, handler)
	}
	call := func(path, key string, payload any, quote string, index string, checkBalance ...bool) *httptest.ResponseRecorder {
		raw, _ := common.Marshal(payload)
		req := httptest.NewRequest("POST", path, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		if path == "/v1/images/edits" {
			var fields map[string]any
			require.NoError(t, common.Unmarshal(raw, &fields))
			var multipartBody bytes.Buffer
			writer := multipart.NewWriter(&multipartBody)
			for field, value := range fields {
				if field == "images" {
					refs, _ := value.([]any)
					for range refs {
						header := make(textproto.MIMEHeader)
						header.Set("Content-Disposition", `form-data; name="image"; filename="reference.png"`)
						header.Set("Content-Type", "image/png")
						part, err := writer.CreatePart(header)
						require.NoError(t, err)
						_, err = part.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0})
						require.NoError(t, err)
					}
					continue
				}
				text, ok := value.(string)
				if !ok {
					number, numeric := value.(float64)
					require.True(t, numeric)
					text = strconv.FormatFloat(number, 'f', -1, 64)
				}
				require.NoError(t, writer.WriteField(field, text))
			}
			require.NoError(t, writer.Close())
			req = httptest.NewRequest("POST", path, &multipartBody)
			req.Header.Set("Content-Type", writer.FormDataContentType())
			req.Header.Set(common.PiknoDirectMediaHeader, common.PiknoDirectMediaVersion)
		}
		req.Header.Set("Authorization", key)
		if quote != "" {
			req.Header.Set("X-PIKNO-Quote", quote)
		}
		if index != "" {
			req.Header.Set("X-PIKNO-Quote-Index", index)
		}
		if len(checkBalance) > 0 && checkBalance[0] {
			req.Header.Set(service.PiknoBalanceCheckHeader, "1")
		}
		out := httptest.NewRecorder()
		engine.ServeHTTP(out, req)
		return out
	}
	readQuote := func(t *testing.T, p model.PiknoPriceParameters, key string) piknoCustomerQuote {
		out := call("/v1/client/quote", key, p, "", "")
		require.Equal(t, 200, out.Code, out.Body.String())
		var decoded struct {
			Data piknoCustomerQuote `json:"data"`
		}
		require.NoError(t, common.Unmarshal(out.Body.Bytes(), &decoded))
		return decoded.Data
	}
	params := map[string]model.PiknoPriceParameters{
		"image":      {Model: lines["image"].PublicModel, Operation: "image", Resolution: "1024x1024", Quality: "auto", Quantity: 1},
		"image_edit": {Model: lines["image"].PublicModel, Operation: "image_edit", Resolution: "1536x1024", Quality: "high", ReferenceImages: 1, Quantity: 1},
		"video":      {Model: lines["video"].PublicModel, Operation: "video", Resolution: "480p", Ratio: "16:9", Seconds: 4, ReferenceImages: 1, Quantity: 2},
		"digital":    {Model: lines["digital"].PublicModel, Operation: "digital", ReferenceImages: 1, ReferenceAudio: 1, Quantity: 1},
		"depth":      {Model: lines["depth"].PublicModel, Operation: "depth", ReferenceVideos: 1, Quantity: 1},
	}
	toolAssets := map[string]string{}
	for kind, letter := range map[string]string{"image": "a", "video": "b", "audio": "c"} {
		now := time.Now().Unix()
		claim := piknoToolInputTicket{Version: 1, Audience: "pikno-tool-input", UserID: user.Id, ID: strings.Repeat(letter, 32), Issued: now, Expires: now + 7200, MIME: map[string]string{"image": "image/png", "video": "video/mp4", "audio": "audio/mpeg"}[kind], Size: 16, Filename: "openapi/reference", CredentialVersion: "legacy"}
		raw, err := common.Marshal(claim)
		require.NoError(t, err)
		payload := base64.RawURLEncoding.EncodeToString(raw)
		mac := hmac.New(sha256.New, []byte("price-test-only-media-secret-123456789"))
		mac.Write([]byte(payload))
		toolAssets[kind] = "https://www.piknoai.com/media/v1/tool-inputs/" + claim.ID + "?ticket=" + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	}
	payloads := map[string]any{
		"image":      gin.H{"model": lines["image"].PublicModel, "prompt": "test-only", "n": 1, "size": "1024x1024", "quality": "auto"},
		"image_edit": gin.H{"model": lines["image"].PublicModel, "prompt": "test-only", "n": 1, "size": "1536x1024", "quality": "high", "images": []string{assets["image"]}},
		"video":      gin.H{"model": lines["video"].PublicModel, "seconds": 4, "resolution": "480p", "aspect_ratio": "16:9", "image_urls": []string{assets["image"]}},
		"digital":    gin.H{"model": lines["digital"].PublicModel, "images": []gin.H{{"url": toolAssets["image"]}}, "audios": []gin.H{{"url": toolAssets["audio"], "durationSeconds": 4}}},
		"depth":      gin.H{"model": lines["depth"].PublicModel, "videos": []gin.H{{"url": toolAssets["video"]}}},
	}
	groups := map[string]string{"image": "image", "image_edit": "image", "video": "video", "digital": "tool", "depth": "tool"}
	paths := map[string]string{"image": "/v1/images/generations", "image_edit": "/v1/images/edits", "video": "/v1/videos", "digital": "/v1/tools/digital", "depth": "/v1/tools/depth"}
	t.Run("read only precise public contract", func(t *testing.T) {
		expected := map[string]string{"image": "0.100000", "image_edit": "0.200000", "video": "1.800000", "digital": "5.000000", "depth": "0.500000"}
		for operation, p := range params {
			q := readQuote(t, p, keys[groups[operation]])
			assert.Equal(t, expected[operation], q.Total)
			assert.Equal(t, 1, int(q.Revision))
			assert.NotEmpty(t, q.Name)
		}
		assert.Zero(t, networkCalls.Load())
		assert.Zero(t, dispatches.Load())
		var count int64
		require.NoError(t, model.DB.Model(&model.PiknoPriceQuoteSlot{}).Count(&count).Error)
		assert.Zero(t, count)
		require.NoError(t, model.DB.Model(&model.PiknoSettlement{}).Where("user_id = ?", user.Id).Count(&count).Error)
		assert.EqualValues(t, 1, count)
		for _, line := range lines {
			raw, err := common.Marshal(publicPiknoLine(line))
			require.NoError(t, err)
			assert.NotContains(t, string(raw), "private")
			assert.NotContains(t, string(raw), "cost_cny")
			assert.NotContains(t, string(raw), "suggested")
			assert.NotContains(t, string(raw), "channel_id")
		}
	})
	t.Run("opt-in balance check covers the full quote without reserving funds", func(t *testing.T) {
		t.Cleanup(func() { require.NoError(t, model.DB.Model(user).Update("quota", 50_000_000).Error) })
		p := params["video"]
		for _, tc := range []struct {
			name    string
			balance int
			check   bool
			status  int
		}{
			{"legacy quote with low balance", 1_799_999, false, http.StatusOK},
			{"balance below the full batch", 1_799_999, true, http.StatusPaymentRequired},
			{"balance equals the full batch", 1_800_000, true, http.StatusOK},
		} {
			t.Run(tc.name, func(t *testing.T) {
				require.NoError(t, model.DB.Model(user).Update("quota", tc.balance).Error)
				out := call("/v1/client/quote", keys["video"], p, "", "", tc.check)
				require.Equal(t, tc.status, out.Code)
				if tc.status == http.StatusOK {
					var decoded struct {
						Data map[string]any `json:"data"`
					}
					require.NoError(t, common.Unmarshal(out.Body.Bytes(), &decoded))
					assert.Equal(t, "1.800000", decoded.Data["total_cny"])
					if tc.check {
						assert.Equal(t, true, decoded.Data["balance_checked"])
					} else {
						assert.NotContains(t, decoded.Data, "balance_checked")
					}
				} else {
					assert.JSONEq(t, `{"error":{"code":"insufficient_balance","message":"Insufficient wallet balance for this quote","submission_state":"not_submitted"}}`, out.Body.String())
				}
				balance, err := model.GetUserQuota(user.Id, true)
				require.NoError(t, err)
				assert.Equal(t, tc.balance, balance)
			})
		}
		assert.Zero(t, networkCalls.Load())
		assert.Zero(t, dispatches.Load())
		var count int64
		require.NoError(t, model.DB.Model(&model.PiknoPriceQuoteSlot{}).Count(&count).Error)
		assert.Zero(t, count)
		require.NoError(t, model.DB.Model(&model.PiknoSettlement{}).Where("user_id = ?", user.Id).Count(&count).Error)
		assert.EqualValues(t, 1, count)
	})
	t.Run("submission opt-in classifies only the wallet shortfall after a successful quote", func(t *testing.T) {
		token := tokens["image"]
		t.Cleanup(func() {
			require.NoError(t, model.DB.Model(user).Update("quota", 50_000_000).Error)
			require.NoError(t, model.DB.Model(&token).Updates(map[string]any{"unlimited_quota": true, "remain_quota": 0}).Error)
		})
		for _, tc := range []struct {
			name    string
			wallet  int
			limited bool
			check   bool
			status  int
			code    string
		}{
			{"wallet changed", 99_999, false, true, http.StatusPaymentRequired, "insufficient_balance"},
			{"legacy wallet failure", 99_999, false, false, http.StatusForbidden, "insufficient_user_quota"},
			{"limited Key", 100_000, true, true, http.StatusForbidden, "insufficient_user_quota"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				require.NoError(t, model.DB.Model(user).Update("quota", 100_000).Error)
				out := call("/v1/client/quote", keys["image"], params["image"], "", "", tc.check)
				require.Equal(t, http.StatusOK, out.Code)
				var quoted struct {
					Data piknoCustomerQuote `json:"data"`
				}
				require.NoError(t, common.Unmarshal(out.Body.Bytes(), &quoted))
				require.NotEmpty(t, quoted.Data.QuoteID)
				require.NoError(t, model.DB.Model(user).Update("quota", tc.wallet).Error)
				require.NoError(t, model.DB.Model(&token).Updates(map[string]any{"unlimited_quota": !tc.limited, "remain_quota": 1}).Error)
				out = call(paths["image"], keys["image"], payloads["image"], quoted.Data.QuoteID, "0", tc.check)
				require.Equal(t, tc.status, out.Code)
				assert.JSONEq(t, fmt.Sprintf(`{"error":{"code":%q}}`, tc.code), out.Body.String())
				balance, err := model.GetUserQuota(user.Id, true)
				require.NoError(t, err)
				assert.Equal(t, tc.wallet, balance)
			})
		}
		assert.Zero(t, dispatches.Load())
	})
	t.Run("declared maxima and effective aggregate agree across quote and execution", func(t *testing.T) {
		original := lines["video"]
		widened := original
		widened.MaxImages, widened.MaxVideos, widened.MaxAudio = 30, 10, 10
		write := func(line model.PiknoLineConfig) {
			raw, err := common.Marshal(line)
			require.NoError(t, err)
			require.NoError(t, model.DB.Model(&model.PiknoLine{}).Where("public_model = ?", line.PublicModel).Update("published_config", string(raw)).Error)
			seeds := []model.PiknoLineSeed{}
			for key, seed := range lines {
				if key == "video" {
					seed = line
				}
				seeds = append(seeds, seed)
			}
			require.NoError(t, model.SyncPiknoLines(seeds, 1))
		}
		write(widened)
		defer write(original)
		public := publicPiknoLine(widened)
		assert.Equal(t, 30, public.MaxImages, "a valid declared maximum must remain intact")
		assert.Equal(t, 20, public.MaxMediaTotal)
		total := func(value int) *int { return &value }
		for _, tc := range []struct {
			name                  string
			images, videos, audio int
			valid                 bool
			total                 *int
		}{
			{"one reference", 1, 0, 0, true, nil},
			{"twenty images", 20, 0, 0, true, nil},
			{"twenty-one images", 21, 0, 0, false, nil},
			{"mixed twenty", 10, 5, 5, true, nil},
			{"mixed twenty-one", 10, 6, 5, false, nil},
			{"per-type maximum", 0, 11, 0, false, nil},
			{"new thirty images", 30, 0, 0, true, total(50)},
			{"new thirty-one images", 31, 0, 0, false, total(50)},
			{"new mixed fifty", 30, 10, 10, true, total(50)},
			{"lower aggregate at boundary", 9, 3, 0, true, total(12)},
			{"lower aggregate overflow", 9, 3, 1, false, total(12)},
			{"zero aggregate", 1, 0, 0, false, total(0)},
			{"invalid aggregate", 1, 0, 0, false, total(1001)},
		} {
			t.Run(tc.name, func(t *testing.T) {
				widened.MaxMediaTotal = tc.total
				write(widened)
				assert.Equal(t, widened.MediaTotalLimit(), publicPiknoLine(widened).MaxMediaTotal)
				p := params["video"]
				p.Quantity, p.ReferenceImages, p.ReferenceVideos, p.ReferenceAudio = 1, tc.images, tc.videos, tc.audio
				beforeNetwork, beforeDispatch := networkCalls.Load(), dispatches.Load()
				out := call("/v1/client/quote", keys["video"], p, "", "")
				assert.Equal(t, beforeNetwork, networkCalls.Load(), "quote never inspects or uploads media")
				assert.Equal(t, beforeDispatch, dispatches.Load())
				body := gin.H{"model": p.Model, "seconds": p.Seconds, "resolution": p.Resolution, "aspect_ratio": p.Ratio}
				for kind, count := range map[string]int{"image": tc.images, "video": tc.videos, "audio": tc.audio} {
					refs := make([]string, count)
					for i := range refs {
						refs[i] = assets[kind]
					}
					body[kind+"_urls"] = refs
				}
				if !tc.valid {
					require.Equal(t, 400, out.Code, out.Body.String())
					exec := call("/v1/videos", keys["video"], body, "", "")
					assert.Equal(t, 400, exec.Code, exec.Body.String())
					assert.Equal(t, beforeNetwork, networkCalls.Load(), "out-of-bound requests fail before media inspection")
					assert.Equal(t, beforeDispatch, dispatches.Load())
					return
				}
				require.Equal(t, 200, out.Code, out.Body.String())
				var decoded struct {
					Data piknoCustomerQuote `json:"data"`
				}
				require.NoError(t, common.Unmarshal(out.Body.Bytes(), &decoded))
				exec := call("/v1/videos", keys["video"], body, decoded.Data.QuoteID, "0")
				require.Equal(t, 204, exec.Code, exec.Body.String())
				assert.Equal(t, beforeDispatch+1, dispatches.Load())
				legacy := call("/v1/videos", keys["video"], body, "", "")
				require.Equal(t, 204, legacy.Code, legacy.Body.String())
				assert.Equal(t, beforeDispatch+2, dispatches.Load(), "legacy headerless clients retain the same accepted capability")
			})
		}
	})

	t.Run("multiple image references and new aspect sizes", func(t *testing.T) {
		original := lines["image"]
		updated := original
		updated.MaxImages = 5
		updated.Resolutions = append(append([]string(nil), original.Resolutions...), "1536x1152", "1152x1536")
		write := func(line model.PiknoLineConfig) {
			raw, err := common.Marshal(line)
			require.NoError(t, err)
			require.NoError(t, model.DB.Model(&model.PiknoLine{}).Where("public_model = ?", line.PublicModel).Update("published_config", string(raw)).Error)
			seeds := []model.PiknoLineSeed{}
			for key, seed := range lines {
				if key == "image" {
					seed = line
				}
				seeds = append(seeds, seed)
			}
			require.NoError(t, model.SyncPiknoLines(seeds, 1))
		}
		write(updated)
		defer write(original)
		for _, tc := range []struct {
			name, size string
			count      int
			valid      bool
		}{
			{"four by three", "1536x1152", 5, true}, {"three by four", "1152x1536", 5, true},
			{"two references", "1536x1152", 2, true}, {"over maximum", "1536x1152", 6, false},
			{"missing references", "1536x1152", 0, false}, {"unpublished size", "1408x1024", 2, false},
		} {
			t.Run(tc.name, func(t *testing.T) {
				p := params["image_edit"]
				p.Resolution, p.ReferenceImages = tc.size, tc.count
				beforeNetwork, beforeDispatch := networkCalls.Load(), dispatches.Load()
				q := call("/v1/client/quote", keys["image"], p, "", "")
				require.Equal(t, beforeNetwork, networkCalls.Load())
				refs := make([]string, tc.count)
				for i := range refs {
					refs[i] = assets["image"]
				}
				body := gin.H{"model": p.Model, "prompt": "Synthetic fixture", "n": 1, "size": p.Resolution, "quality": p.Quality, "images": refs}
				if !tc.valid {
					require.Equal(t, 400, q.Code, q.Body.String())
					exec := call("/v1/images/edits", keys["image"], body, "", "")
					require.Equal(t, 400, exec.Code, exec.Body.String())
					require.Equal(t, beforeNetwork, networkCalls.Load())
					require.Equal(t, beforeDispatch, dispatches.Load())
					return
				}
				require.Equal(t, 200, q.Code, q.Body.String())
				var decoded struct {
					Data piknoCustomerQuote `json:"data"`
				}
				require.NoError(t, common.Unmarshal(q.Body.Bytes(), &decoded))
				require.Equal(t, "0.100000", decoded.Data.Total, "new ratios and reference counts retain the flat image price")
				exec := call("/v1/images/edits", keys["image"], body, decoded.Data.QuoteID, "0")
				require.Equal(t, 204, exec.Code, exec.Body.String())
				require.Equal(t, beforeDispatch+1, dispatches.Load())
			})
		}
	})
	t.Run("auth permissions and bounds", func(t *testing.T) {
		assert.NotEqual(t, 200, call("/v1/client/quote", "", params["image"], "", "").Code)
		assert.Equal(t, 403, call("/v1/client/quote", keys["video"], params["image"], "", "").Code)
		wrong := params["video"]
		wrong.Seconds = 2147483647
		assert.Equal(t, 400, call("/v1/client/quote", keys["video"], wrong, "", "").Code)
		limited := tokens["image"]
		limited.Id = 0
		limited.Key = "pricelimitedtestonly1234567890123456789"
		limited.ModelLimitsEnabled = true
		limited.ModelLimits = "unrelated"
		require.NoError(t, model.DB.Create(&limited).Error)
		assert.Equal(t, 403, call("/v1/client/quote", "Bearer sk-"+limited.Key, params["image"], "", "").Code)
		expired := limited
		expired.Id = 0
		expired.Key = "priceexpiredtestonly1234567890123456789"
		expired.ModelLimitsEnabled = false
		expired.ExpiredTime = time.Now().Unix() - 10
		require.NoError(t, model.DB.Create(&expired).Error)
		assert.NotEqual(t, 200, call("/v1/client/quote", "Bearer sk-"+expired.Key, params["image"], "", "").Code)
		revoked := expired
		revoked.Id = 0
		revoked.Key = "pricerevokedtestonly1234567890123456789"
		revoked.ExpiredTime = -1
		revoked.Status = common.TokenStatusDisabled
		require.NoError(t, model.DB.Create(&revoked).Error)
		assert.NotEqual(t, 200, call("/v1/client/quote", "Bearer sk-"+revoked.Key, params["image"], "", "").Code)
	})
	t.Run("all paths bind prices and prevent replay", func(t *testing.T) {
		before := dispatches.Load()
		for _, operation := range []string{"image", "image_edit", "video", "digital", "depth"} {
			p := params[operation]
			q := readQuote(t, p, keys[groups[operation]])
			first := call(paths[operation], keys[groups[operation]], payloads[operation], q.QuoteID, "0")
			require.Equal(t, 204, first.Code, first.Body.String())
			duplicate := call(paths[operation], keys[groups[operation]], payloads[operation], q.QuoteID, "0")
			assert.Equal(t, 409, duplicate.Code)
			assert.Contains(t, duplicate.Body.String(), "quote_already_submitted")
			if operation == "video" {
				second := call(paths[operation], keys[groups[operation]], payloads[operation], q.QuoteID, "1")
				assert.Equal(t, 204, second.Code, second.Body.String())
				assert.Contains(t, duplicate.Body.String(), "task_id")
			}
		}
		assert.EqualValues(t, 6, dispatches.Load()-before)
	})
	t.Run("real Node wire contract reaches Go reservation guard", func(t *testing.T) {
		var cases []struct {
			Name   string                     `json:"name"`
			Quote  model.PiknoPriceParameters `json:"quote"`
			Submit struct {
				Route string         `json:"route"`
				Body  map[string]any `json:"body"`
			} `json:"submit"`
		}
		require.NoError(t, common.Unmarshal(piknoNodePriceWireContract, &cases))
		require.Len(t, cases, 5)
		for _, tc := range cases {
			t.Run(tc.Name, func(t *testing.T) {
				references := assets
				if groups[tc.Name] == "tool" {
					references = toolAssets
				}
				for field, kind := range map[string]string{"images": "image", "image_urls": "image", "videos": "video", "video_urls": "video", "audios": "audio", "audio_urls": "audio"} {
					refs, ok := tc.Submit.Body[field].([]any)
					if !ok {
						continue
					}
					for i, item := range refs {
						switch ref := item.(type) {
						case string:
							refs[i] = references[kind]
						case map[string]any:
							ref["url"] = references[kind]
						default:
							t.Fatal("unexpected Node reference type")
						}
					}
				}
				q := readQuote(t, tc.Quote, keys[groups[tc.Name]])
				before := dispatches.Load()
				out := call(tc.Submit.Route, keys[groups[tc.Name]], tc.Submit.Body, q.QuoteID, "0")
				assert.Equal(t, 204, out.Code, out.Body.String())
				assert.Equal(t, before+1, dispatches.Load())
				again := call(tc.Submit.Route, keys[groups[tc.Name]], tc.Submit.Body, q.QuoteID, "0")
				assert.Equal(t, 409, again.Code)
				assert.Equal(t, before+1, dispatches.Load())
			})
		}
	})
	t.Run("changed parameters tampering wrong account and partial headers", func(t *testing.T) {
		q := readQuote(t, params["image"], keys["image"])
		altered := gin.H{"model": lines["image"].PublicModel, "prompt": "test-only", "size": "1536x1024", "quality": "auto"}
		out := call(paths["image"], keys["image"], altered, q.QuoteID, "0")
		assert.Equal(t, 409, out.Code)
		assert.Contains(t, out.Body.String(), "quote_parameters_changed")
		assert.Equal(t, 409, call(paths["image"], keys["image"], payloads["image"], q.QuoteID+"x", "0").Code)
		assert.Equal(t, 409, call(paths["image"], keys["image"], payloads["image"], q.QuoteID, "").Code)
		assert.Equal(t, 409, call(paths["image"], keys["image"], payloads["image"], "", "0").Code)
		raw, _ := common.Marshal(payloads["image"])
		req := httptest.NewRequest("POST", paths["image"], strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", keys["image"])
		req.Header.Set("X-PIKNO-Quote", "")
		req.Header.Set("X-PIKNO-Quote-Index", "")
		emptyHeaders := httptest.NewRecorder()
		engine.ServeHTTP(emptyHeaders, req)
		assert.Equal(t, 409, emptyHeaders.Code)
		assert.Equal(t, 403, call(paths["image"], keys["video"], payloads["image"], q.QuoteID, "0").Code)
		other := tokens["image"]
		other.Id = 0
		other.Key = "priceotherkeytestonly1234567890123456789"
		require.NoError(t, model.DB.Create(&other).Error)
		assert.Equal(t, 409, call(paths["image"], "Bearer sk-"+other.Key, payloads["image"], q.QuoteID, "0").Code)
		assert.Equal(t, 204, call(paths["image"], keys["image"], payloads["image"], q.QuoteID, "0").Code)
	})
	t.Run("expired signed unused quote never admits a task", func(t *testing.T) {
		q := readQuote(t, params["image"], keys["image"])
		context, err := model.ParsePiknoPriceContext(q.QuoteID)
		require.NoError(t, err)
		context.Issued -= 400
		context.Expires -= 400
		raw, err := common.Marshal(context)
		require.NoError(t, err)
		mac := hmac.New(sha256.New, []byte(common.CryptoSecret))
		mac.Write([]byte("pikno-price-quote-aead-v1"))
		block, err := aes.NewCipher(mac.Sum(nil))
		require.NoError(t, err)
		aead, err := cipher.NewGCM(block)
		require.NoError(t, err)
		iv := make([]byte, aead.NonceSize())
		sealed := aead.Seal(iv, iv, raw, []byte("pikno-price-quote-v1"))
		signed := "npq1." + base64.RawURLEncoding.EncodeToString(sealed)
		before := dispatches.Load()
		out := call(paths["image"], keys["image"], payloads["image"], signed, "0")
		assert.Equal(t, 409, out.Code)
		assert.Contains(t, out.Body.String(), "quote_expired")
		assert.Contains(t, out.Body.String(), "not_submitted")
		assert.Equal(t, before, dispatches.Load())
	})
	t.Run("concurrent same slot dispatches exactly once", func(t *testing.T) {
		q := readQuote(t, params["image"], keys["image"])
		before := dispatches.Load()
		var wg sync.WaitGroup
		codes := make(chan int, 2)
		for range 2 {
			wg.Go(func() { codes <- call(paths["image"], keys["image"], payloads["image"], q.QuoteID, "0").Code })
		}
		wg.Wait()
		close(codes)
		actual := []int{}
		for code := range codes {
			actual = append(actual, code)
		}
		assert.ElementsMatch(t, []int{204, 409}, actual)
		assert.Equal(t, before+1, dispatches.Load())
	})
	t.Run("publication race rejects before wallet reservation", func(t *testing.T) {
		q := readQuote(t, params["image"], keys["image"])
		before := dispatches.Load()
		require.NoError(t, model.DB.First(user, user.Id).Error)
		balance := user.Quota
		repriceBeforeReservation = true
		out := call(paths["image"], keys["image"], payloads["image"], q.QuoteID, "0")
		repriceBeforeReservation = false
		assert.Equal(t, 409, out.Code, out.Body.String())
		assert.Contains(t, out.Body.String(), "quote_changed")
		assert.Equal(t, before, dispatches.Load())
		require.NoError(t, model.DB.First(user, user.Id).Error)
		assert.Equal(t, balance, user.Quota)
	})
	t.Run("legacy no quote header retains submission", func(t *testing.T) {
		out := call(paths["depth"], keys["tool"], payloads["depth"], "", "")
		assert.Equal(t, 204, out.Code, out.Body.String())
	})
	t.Run("only explicit published zero is free", func(t *testing.T) {
		depth := lines["depth"]
		depth.Prices = append([]model.PiknoLinePrice{}, depth.Prices...)
		depth.Prices[0].RetailQuota = 0
		publishFixture := func(line model.PiknoLineConfig) {
			raw, err := common.Marshal(line)
			require.NoError(t, err)
			require.NoError(t, model.DB.Model(&model.PiknoLine{}).Where("public_model = ?", line.PublicModel).Update("published_config", string(raw)).Error)
			seeds := []model.PiknoLineSeed{}
			for key, seed := range lines {
				if key == "depth" {
					seed = line
				}
				seed.Prices = append([]model.PiknoLinePrice{}, seed.Prices...)
				seeds = append(seeds, seed)
			}
			require.NoError(t, model.SyncPiknoLines(seeds, 1))
		}
		publishFixture(depth)
		assert.Equal(t, 400, call("/v1/client/quote", keys["tool"], params["depth"], "", "").Code)
		assert.Empty(t, publicPiknoLine(depth).Prices)
		depth.ExplicitFree = true
		publishFixture(depth)
		q := readQuote(t, params["depth"], keys["tool"])
		assert.Equal(t, "0.000000", q.Total)
		require.NoError(t, model.DB.First(user, user.Id).Error)
		balance := user.Quota
		out := call(paths["depth"], keys["tool"], payloads["depth"], q.QuoteID, "0")
		assert.Equal(t, 204, out.Code, out.Body.String())
		require.NoError(t, model.DB.First(user, user.Id).Error)
		assert.Equal(t, balance, user.Quota)
	})
}
