package skills

import (
	"archive/zip"
	"bytes"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestArchiveFromMarkdownInfersMetadata(t *testing.T) {
	archive, err := archiveFromMarkdown([]byte("# 小说转分镜\n\n把小说段落拆成可拍摄的镜头。\n"), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if archive.Metadata.Name != "小说转分镜" || archive.Metadata.Description != "把小说段落拆成可拍摄的镜头。" {
		t.Fatalf("metadata = %#v", archive.Metadata)
	}
	if string(archive.Files["SKILL.md"]) == "" || archive.ContentHash == "" {
		t.Fatal("archive did not preserve the entry file or compute a hash")
	}
}

func TestArchiveFromZipNormalizesWrapperAndNestedFiles(t *testing.T) {
	data := skillZip(t, map[string]string{
		"director-main/SKILL.md":             "---\nname: AI 导演\ndescription: 导演工作流\nmetadata:\n  version: 2.1\n---\n",
		"director-main/references/camera.md": "# Camera",
		"director-main/scripts/check.js":     "export default true",
	})
	archive, err := archiveFromZip(data, "")
	if err != nil {
		t.Fatal(err)
	}
	if archive.Metadata.Version != "2.1" || len(archive.Files) != 3 {
		t.Fatalf("archive = %#v", archive)
	}
	if string(archive.Files["references/camera.md"]) != "# Camera" {
		t.Fatalf("nested file missing: %#v", archive.Files)
	}
}

func TestArchiveFromZipRejectsTraversalAndMultipleSkills(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"traversal": {"../SKILL.md": "# Bad"},
		"multiple": {
			"one/SKILL.md": "# One\n\nFirst",
			"two/SKILL.md": "# Two\n\nSecond",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := archiveFromZip(skillZip(t, files), ""); err == nil {
				t.Fatal("expected package validation error")
			}
		})
	}
}

func TestParseGitHubSkillURL(t *testing.T) {
	spec, err := parseGitHubSkillURL("https://github.com/ddcat-ai/open-ai-canvas/tree/main/skills/canvas-context", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if spec.Owner != "ddcat-ai" || spec.Repo != "open-ai-canvas" || spec.Ref != "main" || spec.Subdir != "skills/canvas-context" {
		t.Fatalf("spec = %#v", spec)
	}
	if _, err := parseGitHubSkillURL("https://github.com/ddcat-ai/open-ai-canvas/blob/main/SKILL.md", "", ""); err == nil {
		t.Fatal("expected blob URL to be rejected")
	}
}

func TestEnsureSkillPackagesMigratesAndRefreshesBuiltinSkills(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}); err != nil {
		t.Fatal(err)
	}
	svc := New(repository.New(db), t.TempDir(), nil)
	builtin := model.Skill{ID: kernel.NewID(), Name: "内置导演", Description: "内置工作流", Instruction: "# 内置导演\n\n第一版", Status: skillStatusEnabled, Source: 3}
	userSkill := model.Skill{ID: kernel.NewID(), Name: "用户技能", Description: "用户工作流", Instruction: "# 用户技能\n\n第一版", Status: skillStatusEnabled, Source: skillSourceUser}
	if err := db.Create(&builtin).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&userSkill).Error; err != nil {
		t.Fatal(err)
	}

	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 1)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 1)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	if err := db.Model(&model.Skill{}).Where("id = ?", builtin.ID).Update("instruction", "# 内置导演\n\n第二版").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Skill{}).Where("id = ?", userSkill.ID).Update("instruction", "# 用户技能\n\n不应在启动时重建").Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.EnsureSkillPackages(); err != nil {
		t.Fatal(err)
	}
	assertSkillVersionCount(t, db, builtin.ID, 2)
	assertSkillVersionCount(t, db, userSkill.ID, 1)

	var refreshed model.Skill
	if err := db.First(&refreshed, "id = ?", builtin.ID).Error; err != nil {
		t.Fatal(err)
	}
	wantArchive, err := archiveFromMarkdown([]byte(refreshed.Instruction), refreshed.Name, refreshed.Description)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.ContentHash != wantArchive.ContentHash || refreshed.CurrentVersionID == "" {
		t.Fatalf("builtin package was not refreshed: %#v", refreshed)
	}
}

func TestUpdateSkillPackageUploadAddsVersionAndPreservesSkillReferences(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"owner-1", "reader-1", "stranger-1"} {
		if err := db.Create(&model.User{ID: id, Username: id}).Error; err != nil {
			t.Fatal(err)
		}
	}
	dataDir := t.TempDir()
	repo := repository.New(db)
	svc := New(repo, dataDir, nil)

	firstArchive := skillZip(t, map[string]string{
		"SKILL.md":            "---\nname: 漫剧制作\ndescription: 第一版制作流程\nmetadata:\n  version: 1.0.0\n---\n# First version\n",
		"references/first.md": "first package content",
	})
	created, err := svc.InstallSkillUpload("owner-1", "zip", skillUploadHeader(t, "production.zip", firstArchive), SkillInstallRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetSkillAdded("reader-1", created.SkillID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetSkillLiked("reader-1", created.SkillID, true); err != nil {
		t.Fatal(err)
	}
	ownerStateBefore, err := repo.UserSkillState("owner-1", created.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	readerStateBefore, err := repo.UserSkillState("reader-1", created.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	oldVersion, err := repo.SkillVersion(created.VersionID)
	if err != nil {
		t.Fatal(err)
	}
	oldPackagePath := filepath.Join(dataDir, "skill-packages", filepath.FromSlash(oldVersion.PackageKey))

	secondArchive := skillZip(t, map[string]string{
		"SKILL.md":             "---\nname: 漫剧制作 V2\ndescription: 第二版制作流程\nmetadata:\n  version: 2.0.0\n---\n# Second version\n",
		"references/second.md": "second package content",
	})
	updated, err := svc.UpdateSkillPackageUpload("owner-1", created.SkillID, skillUploadHeader(t, "production-v2.zip", secondArchive))
	if err != nil {
		t.Fatal(err)
	}
	if updated.SkillID != created.SkillID || updated.VersionID == created.VersionID {
		t.Fatalf("update changed skill identity or failed to add a version: before=%#v after=%#v", created, updated)
	}
	if updated.SkillName != "漫剧制作 V2" || updated.Description != "第二版制作流程" || updated.Version != "2.0.0" || updated.Instruction != "---\nname: 漫剧制作 V2\ndescription: 第二版制作流程\nmetadata:\n  version: 2.0.0\n---\n# Second version\n" {
		t.Fatalf("updated package metadata was not applied: %#v", updated)
	}
	assertSkillVersionCount(t, db, created.SkillID, 2)
	if _, err := os.Stat(oldPackagePath); err != nil {
		t.Fatalf("old package archive was not preserved: %v", err)
	}
	oldFiles, err := repo.SkillFiles(created.VersionID)
	if err != nil || len(oldFiles) != 2 {
		t.Fatalf("old version files were not preserved: files=%#v err=%v", oldFiles, err)
	}
	newFiles, err := repo.SkillFiles(updated.VersionID)
	if err != nil || len(newFiles) != 2 {
		t.Fatalf("new version files were not added: files=%#v err=%v", newFiles, err)
	}
	ownerStateAfter, err := repo.UserSkillState("owner-1", created.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	readerStateAfter, err := repo.UserSkillState("reader-1", created.SkillID)
	if err != nil {
		t.Fatal(err)
	}
	if ownerStateAfter.ID != ownerStateBefore.ID || ownerStateAfter.SkillID != created.SkillID || readerStateAfter.ID != readerStateBefore.ID || readerStateAfter.SkillID != created.SkillID || readerStateAfter.InstalledVersionID != created.VersionID || !readerStateAfter.Added || !readerStateAfter.Liked {
		t.Fatalf("existing skill references or install state changed: owner before=%#v after=%#v; reader before=%#v after=%#v", ownerStateBefore, ownerStateAfter, readerStateBefore, readerStateAfter)
	}

	if _, err := svc.UpdateSkillPackageUpload("stranger-1", created.SkillID, skillUploadHeader(t, "unauthorized.zip", secondArchive)); err == nil {
		t.Fatal("expected a non-owner package update to be rejected")
	}
	assertSkillVersionCount(t, db, created.SkillID, 2)
}

func TestUpdateSkillPackageUploadRejectsInvalidPackageAndNonZipSkill(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+kernel.NewID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.User{ID: "owner-2", Username: "owner-2"}).Error; err != nil {
		t.Fatal(err)
	}
	svc := New(repository.New(db), t.TempDir(), nil)
	markdown, err := svc.InstallSkillUpload("owner-2", "markdown", skillUploadHeader(t, "skill.md", []byte("# Markdown skill\n\nA description.\n")), SkillInstallRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateSkillPackageUpload("owner-2", markdown.SkillID, skillUploadHeader(t, "replacement.zip", skillZip(t, map[string]string{"SKILL.md": "---\nname: Replacement\ndescription: New description\n---\n"}))); err == nil {
		t.Fatal("expected updating a Markdown skill with ZIP to be rejected")
	}
	assertSkillVersionCount(t, db, markdown.SkillID, 1)

	zipSkill, err := svc.InstallSkillUpload("owner-2", "zip", skillUploadHeader(t, "skill.zip", skillZip(t, map[string]string{"SKILL.md": "---\nname: ZIP skill\ndescription: Original description\n---\n"})), SkillInstallRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateSkillPackageUpload("owner-2", zipSkill.SkillID, skillUploadHeader(t, "invalid.zip", []byte("not a zip archive"))); err == nil {
		t.Fatal("expected an invalid ZIP upload to be rejected")
	}
	assertSkillVersionCount(t, db, zipSkill.SkillID, 1)
}

func assertSkillVersionCount(t *testing.T, db *gorm.DB, skillID string, want int64) {
	t.Helper()
	var got int64
	if err := db.Model(&model.SkillVersion{}).Where("skill_id = ?", skillID).Count(&got).Error; err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("skill %s version count = %d, want %d", skillID, got, want)
	}
}

func skillZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for filePath, content := range files {
		entry, err := writer.Create(filePath)
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
	return buffer.Bytes()
}

func skillUploadHeader(t *testing.T, filename string, data []byte) *multipart.FileHeader {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
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
