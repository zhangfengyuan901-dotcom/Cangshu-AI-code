package controller

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
)

// TokenAuth owns token expiry, revocation, user status and IP restrictions.
// This read-only identity binds the desktop's two keys to one customer without
// exposing balance, credential, pricing, channel or upstream information.
func PiknoClientContext(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	userID, tokenID := c.GetInt("id"), c.GetInt("token_id")
	if userID < 1 || tokenID < 1 {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	group := common.GetContextKeyString(c, constant.ContextKeyTokenGroup)
	if group != "image-standard" && group != "video-standard" {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Use an image or video key"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"user_id": userID, "group": group})
}
