package router

import (
 "github.com/gin-gonic/gin"
 "github.com/QuantumNous/new-api/controller"
 "github.com/QuantumNous/new-api/middleware"
)
func setPiknoCatalogRoutes(api *gin.RouterGroup){
 api.GET("/pikno/catalog",middleware.HeaderNavModuleAuth("pricing"),controller.PiknoCatalog)
 admin:=api.Group("/pikno/catalog/admin")
 admin.Use(middleware.RootAuth(),middleware.DisableCache())
 admin.GET("",controller.PiknoCatalogAdmin)
 admin.POST("/sync",middleware.CriticalRateLimit(),controller.PiknoCatalogSync)
 admin.POST("/publish",middleware.CriticalRateLimit(),controller.PiknoCatalogPublish)
 admin.POST("/rollback",middleware.CriticalRateLimit(),controller.PiknoCatalogRollback)
}
