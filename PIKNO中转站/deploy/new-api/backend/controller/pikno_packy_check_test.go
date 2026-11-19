package controller

import (
	"context"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPiknoPackyChannelChecks(t *testing.T) {
	baseURL := "https://cf.api.fan"
	channel := &model.Channel{Type: constant.ChannelTypeOpenAI, BaseURL: &baseURL, Status: common.ChannelStatusEnabled}
	t.Run("legacy manual tests cannot submit image or chat requests", func(t *testing.T) {
		// No database or HTTP transport is initialized: these requests must stop
		// before user/price lookup, credential access or upstream submission.
		for _, endpoint := range []string{"", "openai", "image-generation"} {
			for _, name := range []string{"gpt-image-2", "gpt-image-2.5-flare", "pikno-image-flare"} {
				result := testChannel(context.Background(), channel, 0, name, endpoint, false)
				require.Error(t, result.localErr)
				assert.Equal(t, piknoPackyChannelTestMessage, result.localErr.Error())
				assert.Nil(t, result.context)
			}
		}
	})
	t.Run("automatic tests neither submit nor alter health", func(t *testing.T) {
		for _, status := range []int{common.ChannelStatusEnabled, common.ChannelStatusAutoDisabled} {
			channel.Status = status
			summary := testChannelForHealthCheck(context.Background(), channel, 0, true, 1)
			assert.Equal(t, channelTestSummary{}, summary)
			assert.Equal(t, status, channel.Status)
		}
	})
	t.Run("guard is limited to the Packy OpenAI connection", func(t *testing.T) {
		for _, tc := range []struct {
			baseURL string
			kind    int
			want    bool
		}{
			{"https://CF.API.FAN/", constant.ChannelTypeOpenAI, true},
			{"https://other.example", constant.ChannelTypeOpenAI, false},
			{"https://cf.api.fan.other.example", constant.ChannelTypeOpenAI, false},
			{"https://cf.api.fan", constant.ChannelTypeTaskPlugin, false},
		} {
			assert.Equal(t, tc.want, isPiknoPackyImageChannel(&model.Channel{Type: tc.kind, BaseURL: &tc.baseURL}))
		}
		assert.False(t, isPiknoPackyImageChannel(nil))
	})
}
