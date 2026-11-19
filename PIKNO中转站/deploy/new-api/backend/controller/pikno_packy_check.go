package controller

import (
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
)

// Packy image channels use the PIKNO image relay, not the legacy chat test.
// The admin UI checks the saved connection's model catalogue without generating
// an image. A catalogue response must never be reported as generation success.
const piknoPackyChannelTestMessage = "此通用模型测试不适用于 PackyAPI 图片连接。请重新打开上游连接的检测窗口，执行只读连接检查；真实生图请通过已发布线路验收，会产生上游费用。"

func isPiknoPackyImageChannel(channel *model.Channel) bool {
	if channel == nil || channel.Type != constant.ChannelTypeOpenAI {
		return false
	}
	u, err := url.Parse(strings.TrimSpace(channel.GetBaseURL()))
	return err == nil && strings.EqualFold(u.Hostname(), "cf.api.fan")
}
