package router

import (
 "github.com/gin-gonic/gin"
 "github.com/QuantumNous/new-api/controller"
 "github.com/QuantumNous/new-api/middleware"
)

func setPiknoMediaRoutes(router *gin.Engine) {
 group := router.Group("/v1/media")
 group.Use(middleware.TokenAuth(), middleware.UserCriticalRateLimit("media-upload"))
 group.POST("/uploads", controller.PiknoMediaUpload)
 group.POST("/complete", controller.PiknoMediaComplete)
}
