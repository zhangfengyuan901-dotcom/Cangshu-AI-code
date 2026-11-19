package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func setPiknoMediaRoutes(router *gin.Engine) {
	reverseRead := router.Group("/v1/reverse")
	reverseRead.Use(middleware.TokenAuthReadOnly(), middleware.ReverseStatusRateLimit())
	reverseRead.GET("/capabilities", controller.PiknoReverseCapabilities)
	reverseRead.GET("/quote", controller.PiknoReverseQuote)
	reverseRead.GET("/tasks/:id", controller.PiknoReverseTask)
	reverseRead.GET("/operations/:operation_id", controller.PiknoReverseOperation)
	reverseWrite := router.Group("/v1/reverse")
	reverseWrite.Use(middleware.TokenAuth(), middleware.UserCriticalRateLimit("reverse-write"))
	reverseWrite.POST("/uploads", controller.PiknoReverseUpload)
	reverseWrite.POST("/tasks", controller.PiknoReverseSubmit)
	assistant := router.Group("/assistant")
	assistant.Any("/v1/activate", controller.PiknoLLMLegacyClosed)
	assistant.Any("/api/v3/*operation", controller.PiknoLLMLegacyClosed)
	llm := assistant.Group("/v2")
	llm.POST("/activate", middleware.TokenAuthReadOnly(), middleware.DesktopConnectionRateLimit(), controller.PiknoLLMActivate)
	llm.POST("/responses", middleware.TokenAuth(), middleware.UserCriticalRateLimit("assistant-llm"), controller.PiknoLLMResponses)
	llm.POST("/files", middleware.TokenAuth(), middleware.UserCriticalRateLimit("assistant-files"), controller.PiknoLLMFiles)
	llm.GET("/files/:file", middleware.TokenAuthReadOnly(), middleware.AssistantFileStatusRateLimit(), controller.PiknoLLMFiles)
	llm.DELETE("/files/:file", middleware.TokenAuthReadOnly(), middleware.UserCriticalRateLimit("assistant-files"), controller.PiknoLLMFiles)
	assistant.GET("/v2/requests/:id", middleware.TokenAuthReadOnly(), middleware.UserCriticalRateLimit("assistant-llm-status"), controller.PiknoLLMRequestStatus)
	client := router.Group("/v1/client")
	client.GET("/context", middleware.TokenAuthReadOnly(), middleware.DesktopConnectionRateLimit(), controller.PiknoClientContextAuth, controller.PiknoClientContext)
	client.POST("/quote", middleware.TokenAuth(), middleware.UserCriticalRateLimit("desktop-context"), controller.PiknoPriceQuote)
	group := router.Group("/v1/media")
	group.Use(middleware.TokenAuth())
	group.POST("/uploads", middleware.MediaUploadRateLimit("ticket"), controller.PiknoMediaUpload)
	group.POST("/direct-uploads", middleware.MediaUploadRateLimit("direct"), controller.PiknoDirectMediaUpload)
	group.POST("/complete", middleware.MediaUploadRateLimit("complete"), controller.PiknoMediaComplete)
}
