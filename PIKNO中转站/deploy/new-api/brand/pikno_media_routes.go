package router

import (
 "github.com/gin-gonic/gin"
 "github.com/QuantumNous/new-api/controller"
 "github.com/QuantumNous/new-api/middleware"
)

func setPiknoMediaRoutes(router *gin.Engine) {
 assistant := router.Group("/assistant")
 assistant.POST("/v1/activate", middleware.TokenAuth(), middleware.UserCriticalRateLimit("assistant-activate"), controller.PiknoAssistantActivate)
 assistant.Any("/api/v3/*operation", controller.PiknoAssistantProxy)
 client := router.Group("/v1/client")
 client.Use(middleware.TokenAuth(), middleware.UserCriticalRateLimit("desktop-context"))
 client.GET("/context", controller.PiknoClientContext)
 group := router.Group("/v1/media")
 group.Use(middleware.TokenAuth(), middleware.UserCriticalRateLimit("media-upload"))
 group.POST("/uploads", controller.PiknoMediaUpload)
 group.POST("/complete", controller.PiknoMediaComplete)
}
