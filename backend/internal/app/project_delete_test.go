package app

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newProjectDeleteTestService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.Project{},
		&model.ProjectUnit{},
		&model.CanvasUnitLink{},
		&model.ProjectAssetLink{},
		&model.ProjectAssetFolder{},
		&model.ProjectAssetCandidate{},
		&model.Asset{},
		&model.Task{},
		&model.Shot{},
		&model.ShotRevision{},
		&model.ShotArtifact{},
		&model.ShotAssetReference{},
		&model.WorkflowInstance{},
		&model.WorkflowStepInstance{},
		&model.WorkflowStepTask{},
		&model.ProductionTaskLink{},
	); err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db)}, db
}

func TestDeleteProjectUnlinksCanvasAndKeepsIndependentRecords(t *testing.T) {
	service, db := newProjectDeleteTestService(t)
	project := model.Project{ID: "project-1", UserID: "user-1", Name: "短剧", Status: model.ProjectStatusActive}
	canvasID := "canvas-1"
	asset := model.Asset{ID: "asset-1", UserID: "user-1", Title: "角色", Status: model.AssetVersionStatusConfirmed}
	task := model.Task{ID: "task-1", UserID: "user-1", ProjectID: project.ID, Status: model.TaskStatusSucceeded, Prompt: "已完成"}
	canvasTask := model.Task{ID: "task-2", UserID: "user-1", ProjectID: canvasID, Status: model.TaskStatusSucceeded, Prompt: "画布任务"}
	seed := []any{
		&project,
		&model.ProjectUnit{ID: "unit-1", ProjectID: project.ID, Title: "第一集"},
		&model.CanvasUnitLink{ID: "canvas-link-1", ProjectID: project.ID, CanvasID: canvasID, UnitID: "unit-1"},
		&asset,
		&model.ProjectAssetLink{ID: "asset-link-1", ProjectID: project.ID, AssetID: asset.ID},
		&model.ProjectAssetFolder{ID: "folder-1", ProjectID: project.ID, Name: "角色", NameKey: "角色"},
		&model.ProjectAssetCandidate{ID: "candidate-1", ProjectID: project.ID, UnitID: "unit-1", Name: "角色", Status: "pending_confirmation"},
		&model.Shot{ID: "shot-1", ProjectID: project.ID, UnitID: "unit-1", CurrentRevisionID: "revision-1", Title: "镜头一"},
		&model.ShotRevision{ID: "revision-1", ShotID: "shot-1", Version: 1, PlotDescription: "角色入场"},
		&model.ShotArtifact{ID: "artifact-1", ProjectID: project.ID, UnitID: "unit-1", ShotID: "shot-1", RevisionID: "revision-1", Type: "storyboard", Version: 1, Status: "ready"},
		&task,
		&canvasTask,
		&model.ProductionTaskLink{ID: "production-link-1", TaskID: task.ID, ProjectID: project.ID, UnitID: "unit-1", ShotID: "shot-1"},
	}
	for _, item := range seed {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}

	if err := service.DeleteProject("user-1", project.ID); err != nil {
		t.Fatal(err)
	}

	var storedProject model.Project
	if err := db.First(&storedProject, "id = ?", project.ID).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("project error = %v, want record not found", err)
	}
	for _, check := range []struct {
		name  string
		model any
		where string
	}{
		{name: "canvas unit link", model: &model.CanvasUnitLink{}, where: "project_id = ?"},
		{name: "project unit", model: &model.ProjectUnit{}, where: "project_id = ?"},
		{name: "asset link", model: &model.ProjectAssetLink{}, where: "project_id = ?"},
		{name: "asset folder", model: &model.ProjectAssetFolder{}, where: "project_id = ?"},
		{name: "asset candidate", model: &model.ProjectAssetCandidate{}, where: "project_id = ?"},
		{name: "shot", model: &model.Shot{}, where: "project_id = ?"},
		{name: "shot artifact", model: &model.ShotArtifact{}, where: "project_id = ?"},
		{name: "production task link", model: &model.ProductionTaskLink{}, where: "project_id = ?"},
	} {
		var count int64
		if err := db.Model(check.model).Where(check.where, project.ID).Count(&count).Error; err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s count = %d, want 0", check.name, count)
		}
	}
	var storedAsset model.Asset
	if err := db.First(&storedAsset, "id = ?", asset.ID).Error; err != nil {
		t.Fatalf("asset should remain in the account library: %v", err)
	}

	var storedTask model.Task
	if err := db.First(&storedTask, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedTask.ProjectID != "" {
		t.Fatalf("direct project task id = %q, want empty", storedTask.ProjectID)
	}
	var storedCanvasTask model.Task
	if err := db.First(&storedCanvasTask, "id = ?", canvasTask.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedCanvasTask.ProjectID != canvasID {
		t.Fatalf("independent canvas task project id = %q, want %q", storedCanvasTask.ProjectID, canvasID)
	}
}

func TestDeleteProjectRejectsActiveProjectOrCanvasTasks(t *testing.T) {
	service, db := newProjectDeleteTestService(t)
	project := model.Project{ID: "project-1", UserID: "user-1", Name: "短剧", Status: model.ProjectStatusActive}
	canvasID := "canvas-1"
	canvasLink := model.CanvasUnitLink{ID: "canvas-link-1", ProjectID: project.ID, CanvasID: canvasID, UnitID: ""}
	activeTask := model.Task{ID: "task-1", UserID: "user-1", ProjectID: canvasID, Status: model.TaskStatusRunning, Prompt: "生成中"}
	for _, item := range []any{&project, &canvasLink, &activeTask} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}

	err := service.DeleteProject("user-1", project.ID)
	if err == nil || err.Error() != "项目仍有进行中的生成任务，请等待任务完成或取消后再删除" {
		t.Fatalf("DeleteProject() error = %v", err)
	}
	var storedProject model.Project
	if err := db.First(&storedProject, "id = ?", project.ID).Error; err != nil {
		t.Fatalf("project should remain after rejected deletion: %v", err)
	}
	var storedTask model.Task
	if err := db.First(&storedTask, "id = ?", activeTask.ID).Error; err != nil {
		t.Fatal(err)
	}
	if storedTask.ProjectID != canvasID {
		t.Fatalf("active task project id = %q, want %q", storedTask.ProjectID, canvasID)
	}
}

func TestRepositoryDeleteProjectRechecksActiveTasksInsideTransaction(t *testing.T) {
	service, db := newProjectDeleteTestService(t)
	project := model.Project{ID: "project-1", UserID: "user-1", Name: "短剧", Status: model.ProjectStatusActive}
	canvasID := "canvas-1"
	unit := model.ProjectUnit{ID: "unit-1", ProjectID: project.ID, Title: "第一集"}
	link := model.CanvasUnitLink{ID: "link-1", ProjectID: project.ID, CanvasID: canvasID, UnitID: unit.ID}
	activeTask := model.Task{ID: "task-1", UserID: "user-1", ProjectID: canvasID, Status: model.TaskStatusQueued, Prompt: "排队中"}
	for _, item := range []any{&project, &unit, &link, &activeTask} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}

	err := service.repo.DeleteProject("user-1", project.ID)
	if !errors.Is(err, repository.ErrProjectHasActiveTasks) {
		t.Fatalf("DeleteProject() error = %v, want active-task conflict", err)
	}
	var storedProject model.Project
	if err := db.First(&storedProject, "id = ?", project.ID).Error; err != nil {
		t.Fatalf("project should remain after repository conflict: %v", err)
	}
}
