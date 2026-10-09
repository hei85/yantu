package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func validWorkspaceKey(key string) bool {
	if len(key) > 240 || strings.ContainsAny(key, "\x00\r\n") {
		return false
	}
	switch key {
	case "infinite-canvas:canvas_store", "infinite-canvas:asset_store", "infinite-canvas:asset-folders", "infinite-canvas:deleted_history_store", "infinite-canvas:plugin-store":
		return true
	}
	return strings.HasPrefix(key, "drawing:") && len(key) > len("drawing:")
}

func (s *Service) ReadWorkspaceDocument(ctx context.Context, userID, key string) (*model.WorkspaceDocument, error) {
	if !validWorkspaceKey(key) {
		return nil, NewAppError(http.StatusBadRequest, "不支持的工作区文档类型")
	}
	document, err := s.repo.WithContext(ctx).WorkspaceDocument(userID, key)
	if err != nil {
		return nil, WrapAppError(http.StatusInternalServerError, "读取本机工作区失败，已有数据未清空", err)
	}
	return document, nil
}

func (s *Service) ReadWorkspaceRevisions(ctx context.Context, userID string) ([]model.WorkspaceDocument, error) {
	documents, err := s.repo.WithContext(ctx).WorkspaceRevisions(userID)
	if err != nil {
		return nil, WrapAppError(http.StatusInternalServerError, "读取工作区版本失败", err)
	}
	return documents, nil
}

func (s *Service) SaveWorkspaceDocument(ctx context.Context, userID, key string, value *string, baseRevision int64) (*model.WorkspaceDocument, error) {
	if !validWorkspaceKey(key) || baseRevision < 0 {
		return nil, NewAppError(http.StatusBadRequest, "工作区文档或版本无效")
	}
	if value != nil && (len(*value) > 64<<20 || !json.Valid([]byte(*value))) {
		return nil, NewAppError(http.StatusBadRequest, "工作区文档必须为有效 JSON，且不超过 64 MB")
	}
	document, err := s.repo.WithContext(ctx).CommitWorkspaceDocument(userID, key, value, baseRevision)
	if errors.Is(err, repository.ErrWorkspaceRevisionConflict) {
		conflict := NewAppError(http.StatusConflict, "工作区已有更新，请合并最新版本后保存")
		conflict.Reason = ErrorReason("workspace_revision_conflict")
		return nil, conflict
	}
	if err != nil {
		return nil, WrapAppError(http.StatusInternalServerError, "工作区尚未保存到本机服务，请保留当前页面并重试", err)
	}
	return document, nil
}
