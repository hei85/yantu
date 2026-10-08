package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
)

func TestRegisterCanvasAPIExposesOpenAPIAndProjects(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterCanvasAPI(router.Group("/api"), &service.Service{})

	wanted := map[string]bool{
		"GET /api/openapi.yaml":        false,
		"GET /api/projects":            false,
		"POST /api/tasks":              false,
		"GET /api/resources":           false,
		"GET /api/resources/:id/probe": false,
		"PUT /api/skills/:id/package":  false,
	}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := wanted[key]; exists {
			wanted[key] = true
		}
	}
	for route, found := range wanted {
		if !found {
			t.Errorf("route %s is not registered", route)
		}
	}
	removed := map[string]bool{
		"GET /api/canvas-projects":              false,
		"GET /api/canvas-projects/:id":          false,
		"PUT /api/canvas-projects/:id":          false,
		"DELETE /api/canvas-projects/:id":       false,
		"GET /api/canvas-projects/:id/history":  false,
		"GET /api/canvas-projects/:id/share":    false,
		"POST /api/canvas-projects/:id/share":   false,
		"DELETE /api/canvas-projects/:id/share": false,
		"GET /api/public/canvas-shares/:token":  false,
	}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := removed[key]; exists {
			removed[key] = true
		}
	}
	for route, found := range removed {
		if found {
			t.Errorf("cloud canvas persistence route is still registered: %s", route)
		}
	}

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/openapi.yaml", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "openapi: 3.0.3") || !strings.Contains(recorder.Body.String(), "url: /api") || !strings.Contains(recorder.Body.String(), "videoFrameSamples") || !strings.Contains(recorder.Body.String(), "/skills/{id}/package") {
		t.Fatalf("openapi.yaml status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}
