package controller

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"net/http"
)

// Called after read-only key identification on GET /v1/client/context only.
// Chat keys may inspect their identity when exhausted; all media keys still
// execute the original full TokenAuth (quota, group, expiry and IP included).
func PiknoClientContextAuth(c *gin.Context) {
	var token model.Token
	if model.DB.Select("id", "group").First(&token, c.GetInt("token_id")).Error != nil {
		piknoLLMError(c, 401, "llm_auth_required", "not_submitted")
		return
	}
	if token.Group == model.PiknoLLMGroup {
		if _, _, ok := piknoLLMReadAccess(c); !ok {
			return
		}
		common.SetContextKey(c, constant.ContextKeyTokenGroup, model.PiknoLLMGroup)
		c.Next()
		return
	}
	middleware.TokenAuth()(c)
}

func PiknoClientContext(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	userID, tokenID := c.GetInt("id"), c.GetInt("token_id")
	if userID < 1 || tokenID < 1 {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	group := common.GetContextKeyString(c, constant.ContextKeyTokenGroup)
	if group != "image-standard" && group != "video-standard" && group != "tool-standard" && group != model.PiknoLLMGroup {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Use a PIKNO customer key"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"user_id": userID, "group": group})
}
