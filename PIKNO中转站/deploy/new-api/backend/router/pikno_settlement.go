package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func setPiknoSettlementRoutes(api *gin.RouterGroup) {
	self := api.Group("/pikno/settlements/self", middleware.UserAuth(), middleware.DisableCache())
	self.GET("", controller.PiknoSettlementList)
	self.GET("/:id", controller.PiknoSettlementDetail)
	admin := api.Group("/pikno/settlements/admin", middleware.RootAuth(), middleware.DisableCache(), controller.PiknoSettlementReviewGuard)
	admin.GET("", controller.PiknoSettlementList)
	admin.GET("/:id", controller.PiknoSettlementDetail)
	admin.POST("/:id/preview", middleware.CriticalRateLimit(), controller.PiknoSettlementReview)
	admin.POST("/:id/apply", middleware.CriticalRateLimit(), controller.PiknoSettlementReview)
}
