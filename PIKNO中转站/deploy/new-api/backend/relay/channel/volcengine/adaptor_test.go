package volcengine

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNativeChatCompletionsPreservesMediaAndStreamOptions(t *testing.T) {
	const requestBody = `{
		"model":"fixture-chat",
		"stream":true,
		"stream_options":{"include_usage":true},
		"messages":[{"role":"user","content":[
			{"type":"text","text":"Describe the media"},
			{"type":"image_url","image_url":{"url":"https://media.example.test/frame.png"}},
			{"type":"video_url","video_url":{"url":"https://tos.example.test/clip.mp4?fixture=1%2B2","fps":1.25}}
		]}]
	}`
	const endpointID = "ep-20260101000000-fixture"
	const baseURL = "https://ark.example.test"
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(requestBody))
	c.Request.Header.Set("Content-Type", "application/json")
	common.SetContextKey(c, constant.ContextKeyChannelType, constant.ChannelTypeVolcEngine)
	common.SetContextKey(c, constant.ContextKeyChannelBaseUrl, baseURL)
	common.SetContextKey(c, constant.ContextKeyChannelKey, "fixture-key")
	common.SetContextKey(c, constant.ContextKeyOriginalModel, "fixture-chat")
	c.Set("model_mapping", `{"fixture-chat":"`+endpointID+`"}`)

	request, err := helper.GetAndValidateTextRequest(c, relayconstant.RelayModeChatCompletions)
	require.NoError(t, err)
	info, err := relaycommon.GenRelayInfo(c, types.RelayFormatOpenAI, request, nil)
	require.NoError(t, err)
	info.InitChannelMeta(c)
	assert.True(t, info.IsStream)
	assert.True(t, info.SupportStreamOptions)

	outbound, err := common.DeepCopy(request)
	require.NoError(t, err)
	require.NoError(t, helper.ModelMappedHelper(c, info, outbound))
	adaptor := Adaptor{}
	requestURL, err := adaptor.GetRequestURL(info)
	require.NoError(t, err)
	assert.Equal(t, baseURL+"/api/v3/chat/completions", requestURL)

	headers := http.Header{}
	require.NoError(t, adaptor.SetupRequestHeader(c, &headers, info))
	assert.Equal(t, "Bearer fixture-key", headers.Get("Authorization"))
	converted, err := adaptor.ConvertOpenAIRequest(c, info, outbound)
	require.NoError(t, err)
	encoded, err := common.Marshal(converted)
	require.NoError(t, err)
	assert.JSONEq(t, strings.Replace(requestBody, `"fixture-chat"`, `"`+endpointID+`"`, 1), string(encoded))
}
