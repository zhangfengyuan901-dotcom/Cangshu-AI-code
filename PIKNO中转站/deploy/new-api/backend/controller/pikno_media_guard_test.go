package controller

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/piknocatalog"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type piknoTestTransport func(*http.Request) (*http.Response, error)

func (f piknoTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPiknoMediaGuard(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "test-only-media-guard-secret-1234567890"
	t.Setenv("PIKNO_MEDIA_ENABLED", "true")
	t.Setenv("PIKNO_MEDIA_TICKET_KEY", secret)
	setupSecurityEnrollmentTest(t)
	require.NoError(t, model.DB.AutoMigrate(&model.Channel{}, &model.Ability{}, &model.PiknoLine{}))
	baseURL := "https://cf.api.fan"
	channel := model.Channel{Type: constant.ChannelTypeOpenAI, Key: "test-only", Name: "media-guard", Status: common.ChannelStatusEnabled, BaseURL: &baseURL, Group: "default"}
	require.NoError(t, channel.Insert())
	lines := []model.PiknoLineSeed{
		{PublicModel: "pikno-image-flare", SourceID: "gpt-image-2", DisplayName: "Image", Kind: "image", Provider: "packy", UpstreamModel: "gpt-image-2", ChannelID: channel.Id, Enabled: true, UpstreamAvailable: true, Resolutions: []string{"1024x1024", "auto", "1536x1024", "3840x2160"}, Qualities: []string{"auto", "low", "medium", "high"}, MaxImages: 1, Prices: []model.PiknoLinePrice{{Resolution: "default", Unit: "image", RetailQuota: 100000}}},
		{PublicModel: "pikno-video-test", SourceID: "video-test", DisplayName: "Video", Kind: "video", Provider: "packy", UpstreamModel: "video-test", ChannelID: channel.Id, Enabled: true, UpstreamAvailable: true, Resolutions: []string{"480p"}, Durations: []float64{4}, MaxImages: 1, Prices: []model.PiknoLinePrice{{Resolution: "480p", Unit: "second", RetailQuota: 100000}}},
	}
	require.NoError(t, model.SyncPiknoLines(lines, 1))
	for _, line := range lines {
		_, err := model.PublishPiknoLine(line.PublicModel, 1, 1)
		require.NoError(t, err)
	}
	now := time.Now().Unix()
	p := piknoMediaTicket{1, "pikno-relay-media", 7, strings.Repeat("a", 32), "read", now, now + 3600, "image/png", 16}
	link := func(p piknoMediaTicket) string {
		v, err := piknoSignMedia(p, secret)
		require.NoError(t, err)
		return "https://www.piknoai.com/media/v1/assets/" + p.ID + "?ticket=" + v
	}
	valid := link(p)
	require.NotEmpty(t, valid)
	for _, tc := range []struct {
		name, url, kind string
		uid             int
		ok              bool
	}{
		{"valid", valid, "image", 7, true}, {"foreign", valid, "image", 8, false},
		{"wrong type", valid, "video", 7, false}, {"external", "https://example.com/a.png", "image", 7, false},
		{"forged", valid + "x", "image", 7, false}, {"credentials", strings.Replace(valid, "https://", "https://x@", 1), "image", 7, false},
		{"extra query", valid + "&x=y", "image", 7, false}, {"duplicate query", valid + "&ticket=x", "image", 7, false},
		{"fragment", valid + "#x", "image", 7, false}, {"port", strings.Replace(valid, ".com/", ".com:443/", 1), "image", 7, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := piknoValidateMediaURL(tc.url, tc.uid, tc.kind)
			require.Equal(t, tc.ok, err == nil)
		})
	}
	p.Expires = now - 1
	_, err := piknoValidateMediaURL(link(p), 7, "image")
	require.Error(t, err)
	p.Expires = now + 3600
	old := http.DefaultTransport
	defer func() { http.DefaultTransport = old }()
	calls := 0
	http.DefaultTransport = piknoTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, "POST", r.Method)
		require.Equal(t, "www.piknoai.com", r.URL.Host)
		require.Nil(t, r.Body)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"` + p.ID + `","owner_id":7,"size":16,"content_type":"image/png","status":"ready"}`)), Header: make(http.Header)}, nil
	})
	run := func(path, body, ct string, uid int, group string) (int, bool) {
		next := false
		r := gin.New()
		r.POST(path, func(c *gin.Context) {
			c.Set("id", uid)
			common.SetContextKey(c, constant.ContextKeyTokenGroup, group)
		}, PiknoMediaGuard, func(c *gin.Context) {
			next = true
			data, _ := io.ReadAll(c.Request.Body)
			require.Equal(t, body, string(data))
			c.Status(204)
		})
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Header.Set("Content-Type", ct)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code, next
	}
	body, _ := json.Marshal(map[string]any{"model": "pikno-video-test", "image_urls": []string{valid}})
	for _, path := range []string{"/v1/videos", "/pikno-sanbao/tasks", "/pikno-canseedream/tasks"} {
		code, next := run(path, string(body), "application/json", 7, "video-standard")
		require.Equal(t, 204, code)
		require.True(t, next)
	}
	require.Equal(t, 3, calls)
	for _, tc := range []struct {
		body, ct string
		code     int
	}{
		{`{"model":"pikno-video-test","image_urls":["https://evil.example/x"]}`, "application/json", 403},
		{`{"model":"pikno-video-test","images":[{"data_url":"data:image/png;base64,AAAA"}]}`, "application/json", 400},
		{`{"model":"pikno-video-test","image_urls":null}`, "application/json", 400},
		{`{}`, "multipart/form-data; boundary=x", 415},
		{strings.Repeat("x", 65537), "application/json", 413},
	} {
		code, next := run("/v1/videos", tc.body, tc.ct, 7, "video-standard")
		require.Equal(t, tc.code, code)
		require.False(t, next)
	}
	require.Equal(t, 3, calls, "invalid references must never make an HTTP request")
	code, next := run("/v1/videos", string(body), "application/json", 8, "video-standard")
	require.Equal(t, 403, code)
	require.False(t, next)
	http.DefaultTransport = piknoTestTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(`{}`)), Header: make(http.Header)}, nil
	})
	code, next = run("/v1/videos", string(body), "application/json", 7, "video-standard")
	require.Equal(t, 409, code)
	require.False(t, next)
	code, next = run("/v1/videos", `{"prompt":"text only"}`, "application/json", 7, "video-standard")
	require.Equal(t, 400, code)
	require.False(t, next)
	for _, body := range []string{`{"model":"pikno-image-flare","prompt":"x","n":2}`, `{"model":"pikno-image-flare","prompt":"x","response_format":"b64_json"}`, `{"model":"pikno-image-flare","prompt":"x","image":"data:image/png;base64,AAAA"}`} {
		code, next = run("/v1/images/generations", body, "application/json", 7, "image-standard")
		require.Equal(t, 400, code)
		require.False(t, next)
	}
	code, next = run("/v1/images/generations", `{"model":"pikno-image-flare","prompt":"x","n":1}`, "application/json", 7, "image-standard")
	require.Equal(t, 204, code)
	require.True(t, next)
	for _, tc := range []struct {
		name, options string
		status        int
	}{
		{"landscape", `"size":"1536x1024","quality":"high"`, 204},
		{"auto", `"size":"auto","quality":"auto"`, 204},
		{"4k", `"size":"3840x2160","output_format":"jpeg"`, 204},
		{"unsupported size", `"size":"512x512"`, 400},
		{"oversized", `"size":"4096x4096"`, 400},
		{"invalid quality", `"quality":"hd"`, 400},
		{"null size", `"size":null`, 400},
		{"webp", `"output_format":"webp"`, 400},
		{"stream", `"stream":true`, 400},
		{"jpeg min compression", `"output_format":"jpeg","output_compression":0`, 204},
		{"jpeg max compression", `"output_format":"jpeg","output_compression":100`, 204},
		{"optional fields", `"background":"opaque","moderation":"low","user":"test-only"`, 204},
		{"png compression", `"output_format":"png","output_compression":85`, 400},
		{"compression without format", `"output_compression":85`, 400},
		{"negative compression", `"output_format":"jpeg","output_compression":-1`, 400},
		{"excess compression", `"output_format":"jpeg","output_compression":101`, 400},
		{"fraction compression", `"output_format":"jpeg","output_compression":1.5`, 400},
		{"string compression", `"output_format":"jpeg","output_compression":"85"`, 400},
		{"null compression", `"output_format":"jpeg","output_compression":null`, 400},
		{"transparent", `"background":"transparent"`, 400},
		{"invalid moderation", `"moderation":"off"`, 400},
		{"fidelity without editing", `"input_fidelity":"high"`, 400},
		{"null quality", `"quality":null`, 400},
		{"null format", `"output_format":null`, 400},
		{"numeric user", `"user":7`, 400},
		{"empty user", `"user":""`, 400},
		{"multiline user", `"user":"test\nuser"`, 400},
		{"oversized user", `"user":"` + strings.Repeat("x", 257) + `"`, 400},
		{"nonmultiple dimension", `"size":"1025x1024"`, 400},
		{"over ratio", `"size":"3840x1264"`, 400},
		{"over pixel count", `"size":"2896x2896"`, 400},
		{"under pixel count", `"size":"800x800"`, 400},
		{"valid but not published size", `"size":"1024x640"`, 400},
		{"partial images", `"partial_images":1`, 400},
		{"legacy style", `"style":"vivid"`, 400},
		{"mask not exposed", `"mask":"test-only"`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, next := run("/v1/images/generations", `{"model":"pikno-image-flare","prompt":"x",`+tc.options+`}`, "application/json", 7, "image-standard")
			require.Equal(t, tc.status, code)
			require.Equal(t, tc.status == 204, next)
		})
	}
	code, next = run("/v1/images/edits", `{"model":"pikno-image-flare","prompt":"x"}`, "application/json", 7, "image-standard")
	require.Equal(t, 415, code)
	require.False(t, next)
	code, next = run("/v1/videos", string(body), "application/json", 7, "image-standard")
	require.Equal(t, 403, code)
	require.False(t, next)
	code, next = run("/v1/images/generations", `{"model":"pikno-image-flare","prompt":"x","n":1}`, "application/json", 7, "video-standard")
	require.Equal(t, 403, code)
	require.False(t, next)

	t.Run("editing fields and reference count before inspection", func(t *testing.T) {
		inspections := 0
		http.DefaultTransport = piknoTestTransport(func(r *http.Request) (*http.Response, error) {
			inspections++
			require.Equal(t, "POST", r.Method)
			require.Equal(t, "/media/v1/assets/"+p.ID+"/inspect", r.URL.Path)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":"` + p.ID + `","owner_id":7,"size":16,"content_type":"image/png","status":"ready"}`)), Header: make(http.Header)}, nil
		})
		edit := map[string]any{"model": "pikno-image-flare", "prompt": "x", "images": []string{valid}, "input_fidelity": "high", "quality": "high", "output_format": "jpeg", "output_compression": 0, "background": "opaque", "moderation": "auto", "user": "test-only"}
		raw, err := json.Marshal(edit)
		require.NoError(t, err)
		code, next := run("/v1/images/edits", string(raw), "application/json", 7, "image-standard")
		require.Equal(t, 415, code)
		require.False(t, next)
		require.Equal(t, 0, inspections)
		for _, patch := range []map[string]any{
			{"images": []string{valid, valid}}, {"images": []string{}}, {"images": nil},
			{"input_fidelity": "low"}, {"input_fidelity": nil}, {"output_compression": 101},
		} {
			invalid := make(map[string]any, len(edit))
			for key, value := range edit {
				invalid[key] = value
			}
			for key, value := range patch {
				invalid[key] = value
			}
			raw, err := json.Marshal(invalid)
			require.NoError(t, err)
			code, next := run("/v1/images/edits", string(raw), "application/json", 7, "image-standard")
			require.Equal(t, 415, code, string(raw))
			require.False(t, next)
		}
		require.Equal(t, 0, inspections, "JSON image inputs must not inspect assets or reach billing")
	})
	t.Run("direct multipart uses actual files and validates before any media service access", func(t *testing.T) {
		router := gin.New()
		router.POST("/v1/images/edits", func(c *gin.Context) {
			c.Set("id", 7)
			common.SetContextKey(c, constant.ContextKeyTokenGroup, "image-standard")
			defer common.CleanupBodyStorage(c)
			c.Next()
		}, PiknoMediaGuard, func(c *gin.Context) {
			require.True(t, c.GetBool("pikno_direct_multipart"))
			require.Len(t, c.Request.MultipartForm.File["image"], 1)
			c.Status(204)
		})
		for _, tc := range []struct {
			field, value, mime string
			status             int
		}{
			{"quality", "high", "image/png", 204},
			{"input_fidelity", "high", "image/png", 400},
			{"n", "2", "image/png", 400},
			{"quality", "hd", "image/png", 400},
			{"quality", "high", "audio/wav", 400},
		} {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			require.NoError(t, writer.WriteField("model", "pikno-image-flare"))
			require.NoError(t, writer.WriteField("prompt", "synthetic"))
			require.NoError(t, writer.WriteField("size", "1024x1024"))
			require.NoError(t, writer.WriteField(tc.field, tc.value))
			header := make(textproto.MIMEHeader)
			header.Set("Content-Disposition", `form-data; name="image"; filename="private-name.png"`)
			header.Set("Content-Type", tc.mime)
			part, err := writer.CreatePart(header)
			require.NoError(t, err)
			_, err = part.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0})
			require.NoError(t, err)
			require.NoError(t, writer.Close())
			req := httptest.NewRequest("POST", "/v1/images/edits", &body)
			req.Header.Set("Content-Type", writer.FormDataContentType())
			req.Header.Set(common.PiknoDirectMediaHeader, common.PiknoDirectMediaVersion)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			require.Equal(t, tc.status, response.Code)
		}
	})

	t.Run("catalog capabilities survive seed publication and public projection", func(t *testing.T) {
		entry := piknocatalog.PackyImageEntry()
		seed, err := catalogEntrySeed(entry, "2026-10-12T00:00:00Z")
		require.NoError(t, err)
		require.Equal(t, "pikno-image-flare", seed.PublicModel)
		require.Equal(t, "gpt-image-2", seed.UpstreamModel)
		require.Equal(t, entry.Resolutions, seed.Resolutions)
		require.Equal(t, entry.Ratios, seed.Ratios)
		require.Equal(t, []string{"auto", "low", "medium", "high"}, seed.Qualities)
		require.Equal(t, 5, seed.MaxImages)
		require.Len(t, seed.Prices, 1)
		require.Equal(t, 100000, seed.Prices[0].RetailQuota)
		require.Nil(t, seed.Prices[0].CostCNY, "retail price is not evidence of upstream cost")
		published, err := model.GetPublishedPiknoLine(seed.PublicModel)
		require.NoError(t, err)
		require.Equal(t, lines[0].Qualities, published.Qualities)
		for _, quality := range seed.Qualities {
			raw, err := json.Marshal(map[string]any{"quality": quality})
			require.NoError(t, err)
			var options map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(raw, &options))
			require.NoError(t, validatePiknoImage2Options(options, false, &seed))
		}
		for _, size := range seed.Resolutions {
			options := map[string]json.RawMessage{"size": json.RawMessage(`"` + size + `"`)}
			require.NoError(t, validatePiknoImage2Options(options, false, &seed), size)
		}
		limited := seed
		limited.Qualities = []string{"high"}
		require.Error(t, validatePiknoImage2Options(map[string]json.RawMessage{"quality": json.RawMessage(`"low"`)}, false, &limited))
		publicRaw, err := json.Marshal(publicPiknoLine(seed))
		require.NoError(t, err)
		var public map[string]any
		require.NoError(t, json.Unmarshal(publicRaw, &public))
		keys := make([]string, 0, len(public))
		for key := range public {
			keys = append(keys, key)
		}
		require.ElementsMatch(t, []string{"id", "name", "kind", "resolutions", "ratios", "qualities", "durations", "max_images", "max_videos", "max_audio", "max_media_total", "currency", "line_revision", "prices", "reference_surcharge_cny"}, keys)
		require.Equal(t, []any{"auto", "low", "medium", "high"}, public["qualities"])
		for _, size := range published.Resolutions {
			quote, err := model.QuotePublishedPiknoLine(seed.PublicModel, channel.Id, model.PiknoLineUsage{Resolution: size, Images: 1})
			require.NoError(t, err)
			require.Equal(t, 100000, quote.Quota, "published default price covers each offered size")
		}
	})
}

func TestPiknoDirectToolMedia(t *testing.T) {
	gin.SetMode(gin.TestMode)
	secret := "direct-test-only-media-secret-123456789"
	bridge := "direct-test-only-bridge-secret-123456789"
	t.Setenv("PIKNO_MEDIA_ENABLED", "true")
	t.Setenv("PIKNO_TOOLS_ENABLED", "true")
	t.Setenv("PIKNO_MEDIA_TICKET_KEY", secret)
	t.Setenv("PIKNO_TOOLS_BRIDGE_SECRET", bridge)
	now := time.Now().Unix()
	claim := piknoToolInputTicket{Version: 1, Audience: "pikno-tool-input", UserID: 7, ID: strings.Repeat("a", 32), Issued: now, Expires: now + 7200, MIME: "image/png", Size: 16, Filename: "openapi/reference.png", CredentialVersion: "legacy"}
	sign := func(value piknoToolInputTicket) string {
		raw, err := common.Marshal(value)
		require.NoError(t, err)
		payload := base64.RawURLEncoding.EncodeToString(raw)
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte(payload))
		return "https://www.piknoai.com/media/v1/tool-inputs/" + value.ID + "?ticket=" + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	}
	valid := sign(claim)
	_, err := piknoValidateToolInput(valid, 7, "image")
	require.NoError(t, err)
	for _, tc := range []struct {
		uid        int
		kind, link string
	}{
		{8, "image", valid}, {7, "video", valid}, {7, "image", valid + "x"}, {7, "image", valid + "&extra=x"},
	} {
		_, err := piknoValidateToolInput(tc.link, tc.uid, tc.kind)
		require.Error(t, err)
	}
	expired := claim
	expired.Expires = now - 1
	_, err = piknoValidateToolInput(sign(expired), 7, "image")
	require.Error(t, err)
	traversal := claim
	traversal.Filename = "../secret.png"
	_, err = piknoValidateToolInput(sign(traversal), 7, "image")
	require.Error(t, err)
	oldTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = oldTransport })
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0}
	calls := 0
	http.DefaultTransport = piknoTestTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		require.Equal(t, "https://www.piknoai.com/media/v1/tools/uploads", request.URL.String())
		require.Equal(t, "Bearer "+bridge, request.Header.Get("Authorization"))
		require.Equal(t, "7", request.Header.Get("X-Pikno-User"))
		require.Equal(t, int64(len(png)), request.ContentLength)
		body, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		require.Equal(t, png, body)
		result, err := common.Marshal(gin.H{"url": valid, "expires_at": claim.Expires})
		require.NoError(t, err)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(result))}, nil
	})
	for _, group := range []string{"tool-standard", "image-standard", "video-standard"} {
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Set("id", 7)
		common.SetContextKey(c, constant.ContextKeyTokenGroup, group)
		c.Request = httptest.NewRequest("POST", "/v1/media/direct-uploads", bytes.NewReader(png))
		c.Request.Header.Set("Content-Type", "image/png")
		PiknoDirectMediaUpload(c)
		if group == "tool-standard" {
			require.Equal(t, 201, response.Code)
		} else {
			require.Equal(t, 403, response.Code)
		}
	}
	require.Equal(t, 1, calls)
	for _, group := range []string{"tool-standard", "image-standard"} {
		response := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(response)
		c.Set("id", 7)
		common.SetContextKey(c, constant.ContextKeyTokenGroup, group)
		c.Request = httptest.NewRequest("POST", "/v1/media/uploads", strings.NewReader(`{"content_type":"image/png","size":16}`))
		PiknoMediaUpload(c)
		require.Equal(t, 415, response.Code)
	}
}

func TestPiknoDirectImageBodyBudget(t *testing.T) {
	gin.SetMode(gin.TestMode)
	reader, pipe := io.Pipe()
	writer := multipart.NewWriter(pipe)
	completed := make(chan error, 1)
	go func() {
		var result error
		defer func() { _ = pipe.CloseWithError(result); completed <- result }()
		if result = writer.WriteField("model", "synthetic-image"); result != nil {
			return
		}
		if result = writer.WriteField("prompt", "synthetic"); result != nil {
			return
		}
		prefix := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0}
		for range 5 {
			header := make(textproto.MIMEHeader)
			header.Set("Content-Disposition", `form-data; name="image[]"; filename="reference.png"`)
			header.Set("Content-Type", "image/png")
			var part io.Writer
			part, result = writer.CreatePart(header)
			if result != nil {
				return
			}
			_, result = part.Write(prefix)
			if result != nil {
				return
			}
			zeros := bytes.NewReader(make([]byte, 26<<20-len(prefix)))
			_, result = io.Copy(part, zeros)
			if result != nil {
				return
			}
		}
		result = writer.Close()
	}()
	defer reader.Close()
	router := gin.New()
	router.Use(middleware.DecompressRequestMiddleware(), middleware.BodyStorageCleanup())
	router.POST("/v1/images/edits", func(c *gin.Context) {
		body, err := piknoReadDirectImage(c)
		require.NoError(t, err)
		defer c.Request.MultipartForm.RemoveAll()
		storage, err := common.GetBodyStorage(c)
		require.NoError(t, err)
		require.True(t, storage.IsDisk())
		require.Greater(t, storage.Size(), int64(128<<20))
		var images []string
		require.NoError(t, common.Unmarshal(body["images"], &images))
		require.Len(t, images, 5)
		c.Status(204)
	})
	request := httptest.NewRequest("POST", "/v1/images/edits", reader)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set(common.PiknoDirectMediaHeader, common.PiknoDirectMediaVersion)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 204, response.Code)
	require.NoError(t, <-completed)
	oversize, _ := gin.CreateTestContext(httptest.NewRecorder())
	oversize.Request = httptest.NewRequest("POST", "/v1/images/edits", strings.NewReader("bounded"))
	oversize.Request.ContentLength = common.PiknoDirectImageBodyLimit + 1
	oversize.Request.Header.Set(common.PiknoDirectMediaHeader, common.PiknoDirectMediaVersion)
	_, err := common.GetBodyStorage(oversize)
	require.ErrorIs(t, err, common.ErrRequestBodyTooLarge)
}
