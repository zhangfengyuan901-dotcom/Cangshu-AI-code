package piknocatalog

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const syncFixture = `{"defaults":{"pointPricing":{"pointsPerYuan":100},"videoProviders":[{"id":"new_line","label":"New model","providerRoute":"provider_router","providerLine":"new_line","apiBasePath":"/new_line/api/v3","pricingMode":"fixed","pointsCost":50,"allowedResolutions":["720p"],"allowedDurations":[4,5],"limits":{"maxImages":2,"maxVideos":1,"maxAudio":1}}],"protocolLines":[{"id":"new_line","profile":{"allowTextOnly":true,"allowAudioOnly":true}}]}}`

func TestSyncSnapshotKnownProtocol(t *testing.T) {
	snapshot, err := ParseProviderSnapshot("canseedream", []byte(syncFixture), time.Unix(100, 0))
	require.NoError(t, err)
	require.Len(t, snapshot.Items, 1)
	item := snapshot.Items[0]
	require.NotNil(t, item.Adapter)
	require.Equal(t, "/api/v3/contents/generations/tasks", item.Adapter.Path)
	require.Equal(t, "new_line", item.Adapter.Line)
	require.False(t, item.Entry.PriceIssue)
	require.Equal(t, "request", item.Entry.Prices[0].Unit)
	require.Equal(t, 1.0, item.Entry.Prices[0].RetailCNY)
	models := map[string]AdapterDescriptor{item.Entry.ID: *item.Adapter}
	source, version, hash, err := GenerateSyncPlugin("canseedream", models)
	require.NoError(t, err)
	require.Contains(t, source, "version: '"+version+"'")
	require.Len(t, hash, 64)
	again, err := ParseProviderSnapshot("canseedream", []byte(syncFixture), time.Unix(200, 0))
	require.NoError(t, err)
	require.Equal(t, snapshot.Hash, again.Hash)
	for _, field := range []string{`"enabled":false,`, `"available":false,`, `"disabled":true,`} {
		disabled := strings.Replace(syncFixture, `"id":"new_line",`, `"id":"new_line",`+field, 1)
		value, err := ParseProviderSnapshot("canseedream", []byte(disabled), time.Now())
		require.NoError(t, err)
		require.False(t, value.Items[0].Entry.Available)
	}
}
func TestSyncSnapshotUnknownProtocolIsNotGeneralized(t *testing.T) {
	for _, body := range []string{strings.Replace(syncFixture, `"provider_router"`, `"unreviewed_route"`, 1), strings.Replace(syncFixture, `"providerLine":"new_line"`, `"providerLine":"https://evil.invalid/api"`, 1), strings.Replace(syncFixture, `[4,5]`, `[4.5]`, 1)} {
		snapshot, err := ParseProviderSnapshot("canseedream", []byte(body), time.Now())
		require.NoError(t, err)
		require.Nil(t, snapshot.Items[0].Adapter)
		require.NotEmpty(t, snapshot.Items[0].AdapterIssue)
	}
	ambiguous := strings.Replace(syncFixture, `"pricingMode":"fixed","pointsCost":50`, `"pricingMode":"per_second","pointsPerSecond":54,"resolutionPoints":{"720p":104}`, 1)
	snapshot, err := ParseProviderSnapshot("canseedream", []byte(ambiguous), time.Now())
	require.NoError(t, err)
	require.False(t, snapshot.Items[0].Entry.PriceIssue)
	require.Equal(t, "second", snapshot.Items[0].Entry.BillingUnit)
	require.Empty(t, snapshot.Items[0].Entry.CostIssueCode)
	require.Empty(t, snapshot.Items[0].Entry.BillingIssueCode)
	require.Len(t, snapshot.Items[0].Entry.Prices, 1)
	require.Equal(t, 1.04, *snapshot.Items[0].Entry.Prices[0].CostCNY)
	require.Equal(t, 2.08, snapshot.Items[0].Entry.Prices[0].RetailCNY)
	for _, body := range []string{`{}`, `{"defaults":{"videoProviders":null}}`, strings.Replace(syncFixture, `"label":"New model",`, `"enabled":"false",`, 1)} {
		_, err := ParseProviderSnapshot("canseedream", []byte(body), time.Now())
		require.Error(t, err)
	}
}

func TestSyncSnapshotPromptCapKeepsReviewedProtocol(t *testing.T) {
	for _, id := range []string{"donggua_pool", "ningmeng_pool", "xigua2_pool"} {
		t.Run(id, func(t *testing.T) {
			var body map[string]any
			require.NoError(t, json.Unmarshal([]byte(syncFixture), &body))
			raw := body["defaults"].(map[string]any)["videoProviders"].([]any)[0].(map[string]any)
			raw["id"], raw["maxPromptCharacters"] = id, 30000
			delete(raw, "providerRoute")
			delete(raw, "providerLine")
			encoded, err := json.Marshal(body)
			require.NoError(t, err)
			snapshot, err := ParseProviderSnapshot("canseedream", encoded, time.Now())
			require.NoError(t, err)
			require.Empty(t, snapshot.Items[0].AdapterIssue)
			require.NotNil(t, snapshot.Items[0].Adapter)
			require.Equal(t, id, snapshot.Items[0].Adapter.Route)
			require.Equal(t, 20000, snapshot.Items[0].Adapter.MaxPrompt)
		})
	}
}

func TestSyncSnapshotPromptDeclarationMustBePositiveInteger(t *testing.T) {
	for _, test := range []struct {
		name    string
		value   any
		allowed bool
		limit   int
	}{
		{"minimum", 1, true, 1},
		{"smaller upstream limit", 15000, true, 15000},
		{"local limit", 20000, true, 20000},
		{"larger upstream limit", 30000, true, 20000},
		{"large positive integer", 1e100, true, 20000},
		{"zero", 0, false, 0},
		{"negative", -1, false, 0},
		{"fraction", 123.5, false, 0},
		{"larger fraction", 30000.5, false, 0},
		{"text is not inferred", "30000", false, 0},
		{"null is not inferred", nil, false, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			var body map[string]any
			require.NoError(t, json.Unmarshal([]byte(syncFixture), &body))
			raw := body["defaults"].(map[string]any)["videoProviders"].([]any)[0].(map[string]any)
			raw["maxPromptCharacters"] = test.value
			encoded, err := json.Marshal(body)
			require.NoError(t, err)
			snapshot, err := ParseProviderSnapshot("canseedream", encoded, time.Now())
			require.NoError(t, err)
			if test.allowed {
				require.Empty(t, snapshot.Items[0].AdapterIssue)
				require.NotNil(t, snapshot.Items[0].Adapter)
				require.Equal(t, test.limit, snapshot.Items[0].Adapter.MaxPrompt)
			} else {
				require.Equal(t, "prompt_contract_unknown", snapshot.Items[0].AdapterIssue)
				require.Nil(t, snapshot.Items[0].Adapter)
			}
		})
	}
}

type syncTransport func(*http.Request) (*http.Response, error)

func (f syncTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestSyncSnapshotConditionalFetchNoUntrustedURL(t *testing.T) {
	client := &http.Client{Transport: syncTransport(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "https://see.ximeiedu.org/health", req.URL.String())
		require.Equal(t, `"known"`, req.Header.Get("If-None-Match"))
		return &http.Response{StatusCode: 304, Header: http.Header{"Etag": []string{`"known"`}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
	})}
	response, err := FetchProviderSnapshot(context.Background(), client, "canseedream", ConditionalCatalog{ETag: `"known"`}, time.Now())
	require.NoError(t, err)
	require.True(t, response.NotModified)
	_, err = FetchProviderSnapshot(context.Background(), client, "untrusted", ConditionalCatalog{}, time.Now())
	require.Error(t, err)
}

func TestSyncSnapshotRetirementAuthority(t *testing.T) {
	for _, provider := range []string{"sanbao", "canseedream"} {
		empty := `{"data":[]}`
		field := "data"
		if provider == "canseedream" {
			empty = `{"defaults":{"videoProviders":[]}}`
			field = "videoProviders"
		}
		t.Run(provider, func(t *testing.T) {
			snapshot, err := ParseProviderSnapshot(provider, []byte(empty), time.Now())
			require.NoError(t, err)
			assert.Empty(t, snapshot.Items)
			closures, err := ParseAvailabilityClosures(provider, []byte(empty))
			require.NoError(t, err)
			assert.Empty(t, closures.ClosedIDs)
			for _, body := range []string{
				`{}`, strings.Replace(empty, `[]`, `null`, 1), strings.Replace(empty, `[]`, `{}`, 1),
				strings.Replace(empty, `[]`, `[null]`, 1), strings.Replace(empty, `[]`, `[{}]`, 1),
				strings.TrimSuffix(empty, "}"), empty + `{}`,
				strings.Replace(empty, `"`+field+`":[]`, `"`+field+`":[],"`+field+`":[]`, 1),
				strings.Replace(empty, `{`, `{"has_more":true,`, 1),
				strings.Replace(empty, `{`, `{"next_cursor":"second-page",`, 1),
				strings.Replace(empty, `{`, `{"meta":{"has_more":true},`, 1),
				strings.Replace(empty, `{`, `{"pagination":{"page":1,"total_pages":2},`, 1),
			} {
				_, err := ParseProviderSnapshot(provider, []byte(body), time.Now())
				assert.Error(t, err)
			}
		})
	}
	for _, test := range []struct {
		name        string
		conditional ConditionalCatalog
	}{
		{name: "retired full fetch"},
		{name: "retired conditional fetch", conditional: ConditionalCatalog{ETag: `"known"`, LastModified: "Wed, 21 Oct 2015 07:28:00 GMT"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: syncTransport(func(request *http.Request) (*http.Response, error) {
				calls++
				return nil, io.ErrUnexpectedEOF
			})}
			result, err := FetchProviderSnapshot(context.Background(), client, "sanbao", test.conditional, time.Now())
			assert.ErrorContains(t, err, "retired")
			assert.Nil(t, result.Snapshot)
			assert.Nil(t, result.Closures)
			assert.Zero(t, calls)
		})
	}
}

func TestSyncVideoReferencePolicy(t *testing.T) {
	for _, policy := range []struct {
		name        string
		text, audio bool
	}{
		{"visual required", false, false},
		{"text permitted", true, false},
		{"audio permitted", false, true},
		{"both permitted", true, true},
	} {
		t.Run(policy.name, func(t *testing.T) {
			var raw map[string]any
			require.NoError(t, common.Unmarshal([]byte(syncFixture), &raw))
			raw["defaults"].(map[string]any)["protocolLines"] = []any{map[string]any{
				"id": "new_line", "profile": map[string]any{"allowTextOnly": policy.text, "allowAudioOnly": policy.audio},
			}}
			encoded, err := common.Marshal(raw)
			require.NoError(t, err)
			snapshot, err := ParseProviderSnapshot("canseedream", encoded, time.Unix(100, 0))
			require.NoError(t, err)
			item := snapshot.Items[0]
			require.NotNil(t, item.Adapter)
			source, _, _, err := GenerateSyncPlugin("canseedream", map[string]AdapterDescriptor{item.Entry.ID: *item.Adapter})
			require.NoError(t, err)
			engine, err := jsplugin.Compile(source, jsplugin.Options{})
			require.NoError(t, err)
			for _, sample := range []struct {
				name, field string
				value       any
				allowed     bool
				withAudio   bool
			}{
				{"text", "", nil, policy.text, false},
				{"audio", "audio_urls", []any{map[string]any{"url": "https://fixture.invalid/audio", "durationSeconds": 3}}, policy.audio, false},
				{"image", "image_urls", []any{"https://fixture.invalid/image"}, true, false},
				{"video", "video_urls", []any{map[string]any{"url": "https://fixture.invalid/video", "durationSeconds": 3}}, true, false},
				{"empty references", "image_urls", []any{}, policy.text, false},
				{"image and audio", "image_urls", []any{"https://fixture.invalid/image"}, true, true},
				{"video and audio", "video_urls", []any{map[string]any{"url": "https://fixture.invalid/video", "durationSeconds": 3}}, true, true},
			} {
				t.Run(sample.name, func(t *testing.T) {
					input := map[string]any{"model": item.Entry.ID, "prompt": "Synthetic fixture", "duration": 4, "resolution": "720p"}
					if sample.field != "" {
						input[sample.field] = sample.value
					}
					if sample.withAudio {
						input["audio_urls"] = []any{map[string]any{"url": "https://fixture.invalid/audio", "durationSeconds": 3}}
					}
					ctx := map[string]any{"model": item.Entry.ID, "requestBody": input, "body": map[string]any{"kind": "json", "value": input}, "baseUrl": "https://see.ximeiedu.org", "apiKey": "synthetic-only", "publicTaskId": "task_fixture"}
					_, nativeErr := engine.CallMember(context.Background(), "native", "create", ctx)
					built, buildErr := engine.Call(context.Background(), "buildSubmitRequest", ctx)
					protocolInput := map[string]any{"model": item.Entry.ID, "prompt": "Synthetic fixture", "seconds": 4, "resolution": "720p"}
					if sample.field != "" {
						protocolInput[sample.field] = sample.value
					}
					if sample.withAudio {
						protocolInput["audio_urls"] = input["audio_urls"]
					}
					protocolCtx := map[string]any{"model": item.Entry.ID, "body": map[string]any{"kind": "json", "value": protocolInput}}
					_, protocolErr := engine.CallPath(context.Background(), "protocols", []string{"openai_video", "decodeRequest"}, protocolCtx)
					for _, hookErr := range []error{nativeErr, buildErr, protocolErr} {
						if sample.allowed {
							require.NoError(t, hookErr)
						} else {
							require.ErrorContains(t, hookErr, "requires an image or video reference")
						}
					}
					if sample.allowed {
						data, err := common.Marshal(built)
						require.NoError(t, err)
						var request struct {
							URL, Method string
							Headers     map[string]string
							Body        map[string]any
						}
						require.NoError(t, common.Unmarshal(data, &request))
						assert.Equal(t, "https://see.ximeiedu.org/api/v3/contents/generations/tasks", request.URL)
						assert.Equal(t, "POST", request.Method)
						assert.Equal(t, "pikno-task_fixture", request.Headers["Idempotency-Key"])
						assert.Equal(t, "provider_router", request.Body["provider_route"])
						assert.Equal(t, "new_line", request.Body["provider_line"])
						usage, err := engine.Call(context.Background(), "extractUsage", ctx)
						require.NoError(t, err)
						data, err = common.Marshal(usage)
						require.NoError(t, err)
						var facts map[string]any
						require.NoError(t, common.Unmarshal(data, &facts))
						images := 0.0
						if sample.field == "image_urls" {
							images = float64(len(sample.value.([]any)))
						}
						assert.Equal(t, map[string]any{"requests": 1.0, "seconds": 4.0, "image_count": 0.0, "reference_images": images, "resolution": "720p", "quality": "unspecified", "variant": "unspecified"}, facts)
					}
				})
			}
			// Historical polling has a frozen descriptor without the new flags.
			query, err := engine.Call(context.Background(), "buildQueryRequest", map[string]any{
				"model": "retired-model", "baseUrl": "https://see.ximeiedu.org", "apiKey": "synthetic-only", "taskId": "old_task",
				"state": map[string]any{"config": map[string]any{"path": "/api/v3/contents/generations/tasks"}},
			})
			require.NoError(t, err)
			data, err := common.Marshal(query)
			require.NoError(t, err)
			assert.JSONEq(t, `{"url":"https://see.ximeiedu.org/api/v3/contents/generations/tasks/old_task","method":"GET","headers":{"Authorization":"Bearer synthetic-only"}}`, string(data))
		})
	}
}

func TestSyncReferencePolicyRequiresExplicitMatchingProfile(t *testing.T) {
	for _, sample := range []struct {
		name, profiles string
		valid          bool
	}{
		{"missing", `[]`, false},
		{"other route", `[{"id":"other","profile":{"allowTextOnly":false,"allowAudioOnly":false}}]`, false},
		{"missing text flag", `[{"id":"new_line","profile":{"allowAudioOnly":false}}]`, false},
		{"missing audio flag", `[{"id":"new_line","profile":{"allowTextOnly":false}}]`, false},
		{"null", `[{"id":"new_line","profile":{"allowTextOnly":null,"allowAudioOnly":false}}]`, false},
		{"string", `[{"id":"new_line","profile":{"allowTextOnly":false,"allowAudioOnly":"false"}}]`, false},
		{"match by route", `[{"id":"other","profile":{"allowTextOnly":true,"allowAudioOnly":true}},{"id":"new_line","profile":{"allowTextOnly":false,"allowAudioOnly":false}}]`, true},
	} {
		t.Run(sample.name, func(t *testing.T) {
			var body map[string]any
			require.NoError(t, common.Unmarshal([]byte(syncFixture), &body))
			var profiles []any
			require.NoError(t, common.Unmarshal([]byte(sample.profiles), &profiles))
			body["defaults"].(map[string]any)["protocolLines"] = profiles
			data, err := common.Marshal(body)
			require.NoError(t, err)
			snapshot, err := ParseProviderSnapshot("canseedream", data, time.Unix(100, 0))
			require.NoError(t, err)
			item := snapshot.Items[0]
			if !sample.valid {
				assert.Nil(t, item.Adapter)
				assert.Equal(t, "reference_policy_unknown", item.AdapterIssue)
				return
			}
			require.NotNil(t, item.Adapter)
			require.NotNil(t, item.Adapter.AllowTextOnly)
			require.NotNil(t, item.Adapter.AllowAudioOnly)
			assert.False(t, *item.Adapter.AllowTextOnly)
			assert.False(t, *item.Adapter.AllowAudioOnly)
			assert.Equal(t, 1.0, item.Entry.Prices[0].RetailCNY)
			source, _, _, err := GenerateSyncPlugin("canseedream", map[string]AdapterDescriptor{item.Entry.ID: *item.Adapter})
			require.NoError(t, err)
			models, err := ReviewedAdapterModels("canseedream", source)
			require.NoError(t, err)
			require.NotNil(t, models[item.Entry.ID].AllowTextOnly)
			assert.False(t, *models[item.Entry.ID].AllowTextOnly)
			oldSource := strings.ReplaceAll(strings.ReplaceAll(source, `,"allowTextOnly":false`, ""), `,"allowAudioOnly":false`, "")
			oldModels, err := ReviewedAdapterModels("canseedream", oldSource)
			require.NoError(t, err)
			assert.Nil(t, oldModels[item.Entry.ID].AllowTextOnly)
			assert.Nil(t, oldModels[item.Entry.ID].AllowAudioOnly)
		})
	}
}
