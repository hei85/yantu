package handler

import (
	"net/http"
	"time"

	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
)

func RegisterChannelModelAdminRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/admin/channels/:id/models", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		items, err := svc.AdminChannelModels(user, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		models := make([]adminChannelModelResponse, 0, len(items))
		for _, item := range items {
			models = append(models, adminChannelModel(item))
		}
		ok(c, gin.H{"models": models})
	})
	r.POST("/admin/channels/:id/models/fetch", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "admin-channel-models-fetch:"+user.ID+":"+c.Param("id"), 10, time.Minute) {
			return
		}
		models, err := svc.PreviewAdminChannelModels(c.Request.Context(), user, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"models": models})
	})
	r.POST("/admin/channels/:id/models/import", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "admin-channel-models-import:"+user.ID+":"+c.Param("id"), 10, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req service.AdminChannelModelImportRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := svc.ImportAdminChannelModels(c.Request.Context(), user, c.Param("id"), req.Models)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/admin/channels/:id/models/test", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "admin-channel-model-test:"+user.ID+":"+c.Param("id"), 5, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req service.ChannelModelRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := svc.TestAdminChannelModel(c.Request.Context(), user, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/admin/channels/:id/models", func(c *gin.Context) {
		saveChannelModel(c, svc, "")
	})
	r.POST("/admin/channels/:id/models/batch-delete", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		var req struct {
			ModelIDs []string `json:"modelIds"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		deleted, err := svc.DeleteAdminChannelModels(user, c.Param("id"), req.ModelIDs)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"deleted": deleted})
	})
	r.PATCH("/admin/channels/:id/models/:modelId", func(c *gin.Context) {
		saveChannelModel(c, svc, c.Param("modelId"))
	})
	r.PATCH("/admin/channels/:id/models/:modelId/sort", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req service.ChannelModelSortRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := svc.UpdateAdminChannelModelSort(user, c.Param("id"), c.Param("modelId"), req); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"updated": true})
	})
	r.DELETE("/admin/channels/:id/models/:modelId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteAdminChannelModel(user, c.Param("id"), c.Param("modelId")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"ok": true})
	})
}

func saveChannelModel(c *gin.Context, svc *service.Service, id string) {
	user, err := currentUser(c, svc)
	if err != nil {
		failService(c, err)
		return
	}
	var req service.ChannelModelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	item, err := svc.SaveAdminChannelModel(user, c.Param("id"), id, req)
	if err != nil {
		failService(c, err)
		return
	}
	ok(c, gin.H{"model": adminChannelModel(*item)})
}
