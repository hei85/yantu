package handler

import (
	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/service"
	"net/http"
)

func RegisterWorkspaceRoutes(api *gin.RouterGroup, svc *service.Service) {
	api.GET("/workspace/documents", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if key := c.Query("key"); key != "" {
			document, err := svc.ReadWorkspaceDocument(c.Request.Context(), user.ID, key)
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, document)
			return
		}
		documents, err := svc.ReadWorkspaceRevisions(c.Request.Context(), user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"documents": documents})
	})
	api.PUT("/workspace/documents", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 72<<20)
		var input struct {
			Key          string  `json:"key" binding:"required"`
			Value        *string `json:"value"`
			BaseRevision *int64  `json:"baseRevision" binding:"required"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		document, err := svc.SaveWorkspaceDocument(c.Request.Context(), user.ID, input.Key, input.Value, *input.BaseRevision)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, document)
	})
}
