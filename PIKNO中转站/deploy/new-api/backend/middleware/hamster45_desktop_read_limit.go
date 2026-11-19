package middleware

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

// Desktop identity and activation checks are free reads. They share a small
// authenticated-user budget, separate from quote, payment and inference writes.
func DesktopConnectionRateLimit() func(c *gin.Context) {
	if !common.CriticalRateLimitEnable {
		return defNext
	}
	return userRateLimitFactory(60, 60, "UC:desktop-connection-read-v1")
}
