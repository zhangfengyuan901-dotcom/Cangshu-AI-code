package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func setPiknoCatalogRoutes(api *gin.RouterGroup) {
	rh := api.Group("/pikno/rh-config")
	rh.Use(middleware.RootAuth(), middleware.DisableCache())
	rh.GET("", controller.PiknoRHConfig)
	rh.POST("", middleware.CriticalRateLimit(), controller.PiknoRHConfig)
	rh.POST("/check", middleware.CriticalRateLimit(), controller.PiknoRHConfig)
	api.GET("/pikno/catalog", middleware.HeaderNavModuleAuth("pricing"), controller.PiknoCatalog)
	admin := api.Group("/pikno/catalog/admin")
	admin.Use(middleware.RootAuth(), middleware.DisableCache())
	admin.GET("", controller.PiknoCatalogAdmin)
	admin.POST("/sync", middleware.CriticalRateLimit(), controller.PiknoCatalogSync)
	admin.POST("/publish", middleware.CriticalRateLimit(), controller.PiknoCatalogPublish)
	admin.POST("/rollback", middleware.CriticalRateLimit(), controller.PiknoCatalogRollback)
}
