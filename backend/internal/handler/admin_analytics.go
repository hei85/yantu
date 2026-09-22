package handler

import (
	"fmt"
	"net/http"
	"time"

	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
)

func RegisterAdminAnalyticsRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/admin/analytics/overview", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.AdminAnalytics(user, analyticsQuery(c))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.GET("/admin/analytics/models", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.AdminAnalytics(user, analyticsQuery(c))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"models": result.Models})
	})
	r.GET("/admin/analytics/users", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		result, err := svc.AdminAnalytics(user, analyticsQuery(c))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"users": result.Users, "dau": result.KPI.DAU, "wau": result.KPI.WAU, "mau": result.KPI.MAU})
	})
	r.GET("/admin/analytics/export.csv", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		data, err := svc.AdminAnalyticsCSV(user, analyticsQuery(c))
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=usage-%s.csv", time.Now().UTC().Format("20060102-150405")))
		c.Data(http.StatusOK, "text/csv; charset=utf-8", data)
	})
}

func analyticsQuery(c *gin.Context) service.AnalyticsQuery {
	return service.AnalyticsQuery{
		From: c.Query("from"), To: c.Query("to"), UserID: c.Query("userId"),
		Model: c.Query("model"), ChannelID: c.Query("channelId"), Capability: c.Query("capability"),
	}
}
