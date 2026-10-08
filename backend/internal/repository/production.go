package repository

import (
	"errors"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"infinite-canvas/backend/internal/model"
)

var ErrProductionConflict = errors.New("production state changed; reload before continuing")

func (r *Repository) ProductionRunForUser(userID string, id string) (*model.ProductionRun, error) {
	var run model.ProductionRun
	err := r.db.First(&run, "id = ? AND user_id = ?", id, userID).Error
	return &run, err
}

func (r *Repository) ProductionRunByClientKey(userID string, clientKey string) (*model.ProductionRun, error) {
	var run model.ProductionRun
	err := r.db.First(&run, "user_id = ? AND client_key = ?", userID, clientKey).Error
	return &run, err
}

func (r *Repository) ProductionRunByID(id string) (*model.ProductionRun, error) {
	var run model.ProductionRun
	err := r.db.First(&run, "id = ?", id).Error
	return &run, err
}

func (r *Repository) ActiveProductionAttempts(limit int) ([]model.ProductionAttempt, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	items := []model.ProductionAttempt{}
	err := r.db.Where("state IN ?", []string{"submitting", "running", "materializing"}).Order("updated_at").Limit(limit).Find(&items).Error
	return items, err
}
func (r *Repository) ProductionRunsForUser(userID string) ([]model.ProductionRun, error) {
	items := []model.ProductionRun{}
	err := r.db.Where("user_id = ?", userID).Order("updated_at DESC").Limit(100).Find(&items).Error
	return items, err
}

func (r *Repository) CreateProductionRun(run *model.ProductionRun) error {
	var old model.ProductionRun
	if err := r.db.First(&old, "user_id = ? AND client_key = ?", run.UserID, run.ClientKey).Error; err == nil {
		if old.CreateHash != run.CreateHash {
			return ErrProductionConflict
		}
		*run = old
		return nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	if err := r.db.Create(run).Error; err != nil {
		if e := r.db.First(&old, "user_id = ? AND client_key = ?", run.UserID, run.ClientKey).Error; e == nil && old.CreateHash == run.CreateHash {
			*run = old
			return nil
		}
		return err
	}
	return nil
}

func (r *Repository) MutateProductionRun(userID string, id string, fn func(*model.ProductionRun, *Repository) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.ProductionRun{}).Where("id = ? AND user_id = ?", id, userID).UpdateColumn("revision", gorm.Expr("revision"))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		scoped := New(tx)
		run, err := scoped.ProductionRunForUser(userID, id)
		if err != nil {
			return err
		}
		if err := fn(run, scoped); err != nil {
			return err
		}
		return tx.Save(run).Error
	})
}

func (r *Repository) CreateProductionStep(step *model.ProductionStep) error {
	return r.db.Create(step).Error
}

func (r *Repository) SaveProductionStep(step *model.ProductionStep) error {
	return r.db.Save(step).Error
}

func (r *Repository) SaveProductionRun(run *model.ProductionRun) error {
	return r.db.Save(run).Error
}

func (r *Repository) ProductionSteps(runID string) ([]model.ProductionStep, error) {
	items := []model.ProductionStep{}
	err := r.db.Where("run_id = ?", runID).Order("created_at").Find(&items).Error
	return items, err
}

func (r *Repository) ProductionStep(runID string, stepID string) (*model.ProductionStep, error) {
	var step model.ProductionStep
	err := r.db.First(&step, "id = ? AND run_id = ?", stepID, runID).Error
	return &step, err
}

func (r *Repository) ProductionStepByKey(runID string, stepKey string) (*model.ProductionStep, error) {
	var step model.ProductionStep
	err := r.db.First(&step, "run_id = ? AND step_key = ?", runID, stepKey).Error
	return &step, err
}

func (r *Repository) MutateProductionStep(runID string, stepID string, fn func(*model.ProductionStep, *Repository) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.ProductionStep{}).Where("id = ? AND run_id = ?", stepID, runID).UpdateColumn("revision", gorm.Expr("revision"))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		scoped := New(tx)
		step, err := scoped.ProductionStep(runID, stepID)
		if err != nil {
			return err
		}
		if err := fn(step, scoped); err != nil {
			return err
		}
		return tx.Save(step).Error
	})
}

func (r *Repository) ProductionAttempts(runID string, stepID string) ([]model.ProductionAttempt, error) {
	items := []model.ProductionAttempt{}
	query := r.db.Where("run_id = ?", runID)
	if stepID != "" {
		query = query.Where("step_id = ?", stepID)
	}
	err := query.Order("created_at").Find(&items).Error
	return items, err
}

func (r *Repository) ProductionAttemptByID(runID string, id string) (*model.ProductionAttempt, error) {
	var item model.ProductionAttempt
	err := r.db.First(&item, "id = ? AND run_id = ?", id, runID).Error
	return &item, err
}

func (r *Repository) ProductionAttemptByIdempotencyKey(runID string, key string) (*model.ProductionAttempt, error) {
	var item model.ProductionAttempt
	err := r.db.First(&item, "run_id = ? AND idempotency_key = ?", runID, key).Error
	return &item, err
}

func (r *Repository) SaveProductionAttempt(attempt *model.ProductionAttempt) error {
	return r.db.Save(attempt).Error
}

func (r *Repository) CreateProductionAttempt(attempt *model.ProductionAttempt) error {
	return r.db.Create(attempt).Error
}

func (r *Repository) ProductionEventsAfter(runID string, after int64, limit int) ([]model.ProductionRunEvent, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	items := []model.ProductionRunEvent{}
	err := r.db.Where("run_id = ? AND sequence > ?", runID, after).Order("sequence").Limit(limit).Find(&items).Error
	return items, err
}

func (r *Repository) AppendProductionEvent(run *model.ProductionRun, eventType string, objectID string, objectRevision int64, payloadJSON string) error {
	run.LastEventSequence++
	event := model.ProductionRunEvent{
		ID:             newRepositoryID(),
		RunID:          run.ID,
		Sequence:       run.LastEventSequence,
		Type:           eventType,
		ObjectID:       objectID,
		ObjectRevision: objectRevision,
		PayloadJSON:    payloadJSON,
	}
	return r.db.Create(&event).Error
}

func (r *Repository) LockProductionRun(userID string, id string) (*model.ProductionRun, error) {
	var run model.ProductionRun
	err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).First(&run, "id = ? AND user_id = ?", id, userID).Error
	return &run, err
}
