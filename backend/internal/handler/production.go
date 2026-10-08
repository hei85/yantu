package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/service"
)

func RegisterProductionRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/production-runs", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		value, err := svc.ListProductionRuns(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})

	r.POST("/production-runs", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req service.ProductionRunRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.CreateProductionRun(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})

	r.GET("/production-runs/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		after, _ := strconv.ParseInt(c.DefaultQuery("after", "0"), 10, 64)
		value, err := svc.GetProductionRun(user.ID, c.Param("id"), after)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})

	r.PATCH("/production-runs/:id/plan", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req service.ProductionPlanRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.UpdateProductionPlan(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})

	r.POST("/production-runs/:id/authorize", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
		var req service.ProductionAuthorizeRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.AuthorizeProductionRun(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})

	r.POST("/production-runs/:id/actions", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
		var req service.ProductionActionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.ChangeProductionRunStatus(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})

	r.POST("/production-runs/:id/steps/submit", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<20)
		var req service.ProductionSubmitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.SubmitProductionStep(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})

	r.POST("/production-runs/:id/steps/result", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
		var req service.ProductionStepResultRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.RecordProductionStepResult(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})

	r.POST("/production-runs/:id/steps/render", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8<<20)
		var req service.ProductionRenderSubmitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.SubmitProductionRenderStep(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})
	r.POST("/production-runs/:id/complete", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
		var req service.ProductionCompleteRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.CompleteProductionRun(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})
	r.POST("/production-runs/:id/verify", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
		var req service.ProductionDeliveryVerificationRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		value, err := svc.VerifyProductionDelivery(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})
	r.GET("/production-runs/:id/tasks", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		value, err := svc.GetProductionTasks(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, value)
	})
}
