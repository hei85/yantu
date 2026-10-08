package handler

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestUpdateSkillPackageRouteUploadsVersionToExistingSkill(t *testing.T) {
	t.Setenv("CANVAS_PORTABLE_NO_LOGIN", "1")
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{}); err != nil {
		t.Fatal(err)
	}
	svc := service.New(repository.New(db), t.TempDir())
	user, err := svc.PortableAdminUser()
	if err != nil {
		t.Fatal(err)
	}
	firstArchive := testSkillZip(t, map[string]string{
		"SKILL.md": "---\nname: Production\ndescription: First package\n---\n# First\n",
	})
	created, err := svc.InstallSkillUpload(user.ID, "zip", testSkillUploadHeader(t, "production.zip", firstArchive), service.SkillInstallRequest{})
	if err != nil {
		t.Fatal(err)
	}

	secondArchive := testSkillZip(t, map[string]string{
		"SKILL.md":          "---\nname: Production\ndescription: Updated package\nmetadata:\n  version: 2.0.0\n---\n# Updated\n",
		"references/new.md": "new version",
	})
	requestBody, contentType := testSkillMultipartBody(t, "production-v2.zip", secondArchive)
	request := httptest.NewRequest(http.MethodPut, "/api/skills/"+created.SkillID+"/package", requestBody)
	request.RemoteAddr = "127.0.0.1:43210"
	request.Header.Set("Content-Type", contentType)
	response := httptest.NewRecorder()
	router := gin.New()
	RegisterSkillRoutes(router.Group("/api"), svc)
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("PUT /skills/:id/package returned %d: %s", response.Code, response.Body.String())
	}
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Skill struct {
				SkillID   string `json:"skillId"`
				VersionID string `json:"versionId"`
				Version   string `json:"version"`
			} `json:"skill"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != service.CodeOK || envelope.Data.Skill.SkillID != created.SkillID || envelope.Data.Skill.VersionID == created.VersionID || envelope.Data.Skill.Version != "2.0.0" {
		t.Fatalf("unexpected API response: %#v", envelope)
	}
}

func testSkillZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	for name, content := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func testSkillUploadHeader(t *testing.T, filename string, data []byte) *multipart.FileHeader {
	t.Helper()
	body, contentType := testSkillMultipartBody(t, filename, data)
	request := httptest.NewRequest(http.MethodPost, "/", body)
	request.Header.Set("Content-Type", contentType)
	if err := request.ParseMultipartForm(int64(len(data) + 1024)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if request.MultipartForm != nil {
			_ = request.MultipartForm.RemoveAll()
		}
	})
	return request.MultipartForm.File["file"][0]
}

func testSkillMultipartBody(t *testing.T, filename string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, writer.FormDataContentType()
}
