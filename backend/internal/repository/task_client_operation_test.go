package repository

import (
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

func TestTaskClientOperationIdentityIsUniquePerUser(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:task-client-operation?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatalf("migrate task: %v", err)
	}
	repo := New(db)
	operationID := "shot-1-attempt-1"
	first := model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued, ClientOperationID: &operationID, ClientOperationHash: "hash-1"}
	if err := db.Create(&first).Error; err != nil {
		t.Fatalf("create first task: %v", err)
	}
	same := model.Task{ID: "task-2", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued, ClientOperationID: &operationID, ClientOperationHash: "hash-1"}
	if err := db.Create(&same).Error; err == nil {
		t.Fatal("duplicate client operation should violate the unique identity")
	}
	otherUser := model.Task{ID: "task-3", UserID: "user-2", Type: "canvas_image", Status: model.TaskStatusQueued, ClientOperationID: &operationID, ClientOperationHash: "hash-1"}
	if err := db.Create(&otherUser).Error; err != nil {
		t.Fatalf("same operation for another user must be isolated: %v", err)
	}
	found, err := repo.TaskForUserByClientOperation("user-1", operationID)
	if err != nil || found.ID != first.ID {
		t.Fatalf("lookup = %#v, err=%v", found, err)
	}
	nullOne := model.Task{ID: "task-4", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued}
	nullTwo := model.Task{ID: "task-5", UserID: "user-1", Type: "canvas_image", Status: model.TaskStatusQueued}
	if err := db.Create(&nullOne).Error; err != nil {
		t.Fatalf("create task without operation: %v", err)
	}
	if err := db.Create(&nullTwo).Error; err != nil {
		t.Fatalf("multiple NULL client operation ids must remain valid: %v", err)
	}
}
