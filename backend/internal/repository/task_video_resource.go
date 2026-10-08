package repository

import (
	"encoding/json"

	"infinite-canvas/backend/internal/model"
)

func (r *Repository) SucceededVideoTaskForResource(userID, resourceID string) (*model.Task, error) {
	encoded, err := json.Marshal(resourceID)
	if err != nil {
		return nil, err
	}
	var task model.Task
	err = r.db.Where("user_id = ? AND type = ? AND status = ? AND result_json LIKE ?", userID, "canvas_video", model.TaskStatusSucceeded, "%\"resourceId\":"+string(encoded)+"%").
		Order("completed_at DESC").Take(&task).Error
	return &task, err
}
