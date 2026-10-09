package model

import "time"

// WorkspaceDocument is the durable source for free canvases and personal asset
// metadata. Browser IndexedDB is only a cache, never a separate workspace.
type WorkspaceDocument struct {
	UserID    string    `gorm:"primaryKey;size:80" json:"userId"`
	Key       string    `gorm:"primaryKey;size:240" json:"key"`
	Value     *string   `gorm:"type:text" json:"value"`
	Revision  int64     `gorm:"not null" json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Keep the first imported version and recent revisions for recovery.
type WorkspaceDocumentRevision struct {
	UserID    string  `gorm:"primaryKey;size:80"`
	Key       string  `gorm:"primaryKey;size:240"`
	Revision  int64   `gorm:"primaryKey"`
	Value     *string `gorm:"type:text"`
	CreatedAt time.Time
}
