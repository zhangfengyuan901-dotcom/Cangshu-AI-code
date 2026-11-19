package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func setPiknoLineRoutes(api *gin.RouterGroup) {
	api.GET("/pikno/lines", middleware.HeaderNavModuleAuth("pricing"), controller.PiknoLines)
	admin := api.Group("/pikno/lines/admin")
	admin.Use(middleware.RootAuth(), middleware.DisableCache())
	admin.GET("", controller.PiknoLinesAdmin)
	admin.POST("/sync", middleware.CriticalRateLimit(), controller.PiknoLinesSync)
	admin.PATCH("", middleware.CriticalRateLimit(), controller.PiknoLineUpdate)
	admin.POST("/validate", middleware.CriticalRateLimit(), controller.PiknoLineValidate)
	admin.POST("/publish", middleware.CriticalRateLimit(), controller.PiknoLinePublish)
	admin.POST("/disable", middleware.CriticalRateLimit(), controller.PiknoLineDisable)
	admin.POST("/rollback", middleware.CriticalRateLimit(), controller.PiknoLineRollback)
}
