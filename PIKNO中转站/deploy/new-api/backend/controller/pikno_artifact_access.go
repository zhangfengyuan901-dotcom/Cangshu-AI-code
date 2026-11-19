package controller

import (
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
)

func PiknoVideoProxy(c *gin.Context) {
	if !piknoArtifactTokenModelAllowed(c, c.Param("task_id")) {
		return
	}
	VideoProxy(c)
}

func PiknoTaskArtifactContent(c *gin.Context) {
	if !piknoArtifactTokenModelAllowed(c, c.Param("key")) {
		return
	}
	TaskArtifactContent(c)
}

// Historical reads stay account-owned, including old video Keys. A token's
// explicit model restriction must also apply to PIKNO binary content. Existing
// dashboard/capability authorization and non-PIKNO task behavior are unchanged.
func piknoArtifactTokenModelAllowed(c *gin.Context, taskID string) bool {
	if c.GetInt("token_id") == 0 || !common.GetContextKeyBool(c, constant.ContextKeyTokenModelLimitEnabled) {
		return true
	}
	task, exists, err := getTaskForArtifactRequest(c, taskID)
	if err != nil {
		writeTaskArtifactError(c, http.StatusInternalServerError, "artifact_internal_error", "Failed to query task")
		return false
	}
	if !exists || task == nil {
		// Preserve the original handler's hidden/not-found response.
		return true
	}
	publicModel := strings.TrimSpace(task.Properties.OriginModelName)
	if !strings.HasPrefix(publicModel, "pikno-") && task.Platform != "pikno-tools" {
		return true
	}
	if strings.HasPrefix(publicModel, "pikno-") && piknoTokenCanUseModel(c, publicModel) {
		return true
	}
	c.Header("Cache-Control", "private, no-store")
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": gin.H{
		"type": "model_not_allowed", "code": "model_not_allowed", "message": "This API key is not authorized for this task model",
	}})
	return false
}
