package handler

import (
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
)

// RegisterAudioResultRoutes exposes a local, authenticated download for signed
// generated audio URLs whose storage host does not permit browser CORS.
func RegisterAudioResultRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.POST("/ai/audio-result", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		policy, available := loadRuntimePolicy(c, svc)
		if !available || !enforceRateLimit(c, "audio-result:"+user.ID, policy.Request.ResourceImportPerMinute, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8<<10)
		var req struct {
			URL string `json:"url"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if strings.TrimSpace(req.URL) == "" {
			fail(c, http.StatusBadRequest, service.BadAuthRequest("音频结果地址不能为空"))
			return
		}
		data, mimeType, err := svc.DownloadGeneratedAudioURL(req.URL)
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "private, no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Referrer-Policy", "no-referrer")
		c.Data(http.StatusOK, mimeType, data)
	})
}
