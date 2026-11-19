package middleware

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

// Original-request status checks have a short read budget, separate from
// inference, file upload, quote and media upload write limits.
func AssistantChatStatusRateLimit() func(c *gin.Context) {
	if !common.CriticalRateLimitEnable {
		return defNext
	}
	return userRateLimitFactory(60, 60, "UC:assistant-chat-status-v1")
}
