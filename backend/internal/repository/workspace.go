package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

var ErrWorkspaceRevisionConflict = errors.New("workspace revision conflict")

func (r *Repository) WorkspaceDocument(userID, key string) (*model.WorkspaceDocument, error) {
	var document model.WorkspaceDocument
	err := r.db.Where("user_id = ? AND key = ?", userID, key).First(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &model.WorkspaceDocument{UserID: userID, Key: key}, nil
	}
	return &document, err
}

func (r *Repository) WorkspaceRevisions(userID string) ([]model.WorkspaceDocument, error) {
	var documents []model.WorkspaceDocument
	err := r.db.Select("user_id", "key", "revision", "updated_at").Where("user_id = ?", userID).Find(&documents).Error
	return documents, err
}

func (r *Repository) CommitWorkspaceDocument(userID, key string, value *string, baseRevision int64) (*model.WorkspaceDocument, error) {
	document := &model.WorkspaceDocument{UserID: userID, Key: key, Value: value, Revision: baseRevision + 1, UpdatedAt: time.Now().UTC()}
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var result *gorm.DB
		if baseRevision == 0 {
			result = tx.Clauses(clause.OnConflict{DoNothing: true}).Create(document)
		} else {
			result = tx.Model(&model.WorkspaceDocument{}).Where("user_id = ? AND key = ? AND revision = ?", userID, key, baseRevision).
				Updates(map[string]any{"value": value, "revision": document.Revision, "updated_at": document.UpdatedAt})
		}
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrWorkspaceRevisionConflict
		}
		revision := model.WorkspaceDocumentRevision{UserID: userID, Key: key, Revision: document.Revision, Value: value, CreatedAt: document.UpdatedAt}
		if err := tx.Create(&revision).Error; err != nil {
			return err
		}
		// Revision 1 is the original migration backup; never prune it.
		return tx.Where("user_id = ? AND key = ? AND revision > 1 AND revision < ?", userID, key, document.Revision-9).Delete(&model.WorkspaceDocumentRevision{}).Error
	})
	return document, err
}
