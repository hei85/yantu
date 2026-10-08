// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestDistributionCustomRelayRouteRejectsBeforeDispatch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterCustomRelayRoutes(router.Group("/api"), nil)
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		request := httptest.NewRequest(method, "/api/ai/custom", nil)
		request.Header.Set("X-Canvas-Upstream-URL", "https://other.example/v1/models")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "Axon") {
			t.Fatalf("custom relay response: status=%d", response.Code)
		}
	}
}
