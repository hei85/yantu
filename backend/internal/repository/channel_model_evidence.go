package repository

import (
	"time"

	"infinite-canvas/backend/internal/model"
)

// A probe may add evidence only if no administrator edited the contract since
// it was read. Never save an old copy of the model over a concurrent edit.
func (r *Repository) SaveChannelModelObservedEvidence(id string, version int64, previous, updated string) (bool, error) {
	result := r.db.Model(&model.ChannelModel{}).
		Where("id = ? AND capability_version = ? AND capability_config_json = ?", id, version, previous).
		Updates(map[string]any{"capability_config_json": updated, "updated_at": time.Now()})
	return result.RowsAffected > 0, result.Error
}
