package middleware

import "github.com/gin-gonic/gin"

// Processing is polled every two seconds. Do not consume the 20-minute
// critical-write bucket while waiting for an already uploaded file.
func AssistantFileStatusRateLimit() func(c *gin.Context) {
	return userRateLimitFactory(120, 60, "UC:assistant-file-status-v1")
}
