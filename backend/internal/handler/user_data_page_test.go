package handler

import (
	"testing"

	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
)

func TestPersonalCloudAssetRoutesAreNotRegistered(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterUserDataRoutes(router.Group("/api"), &service.Service{})
	removed := map[string]bool{
		"POST /api/assets/batch":                false,
		"GET /api/assets":                       false,
		"GET /api/assets/:id":                   false,
		"PUT /api/assets/:id":                   false,
		"DELETE /api/assets/:id":                false,
		"GET /api/user-data/snapshot":           false,
		"GET /api/asset-folders":                false,
		"POST /api/asset-folders":               false,
		"PATCH /api/assets/folder":              false,
	}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := removed[key]; exists {
			removed[key] = true
		}
	}
	for route, found := range removed {
		if found {
			t.Errorf("personal cloud asset route is still registered: %s", route)
		}
	}
}
