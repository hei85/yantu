package app

import (
	"infinite-canvas/backend/internal/canvas/capability"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Canvas documents stay in browser-local storage. Creation runs persist only
// their approved operations and execution metadata.
var creationCanvasCapabilityRegistry = capability.BuiltinRegistry()

type CreationCanvasOp struct {
	Type         string         `json:"type"`
	ID           string         `json:"id,omitempty"`
	NodeType     string         `json:"nodeType,omitempty"`
	Title        string         `json:"title,omitempty"`
	Position     map[string]any `json:"position,omitempty"`
	X            *float64       `json:"x,omitempty"`
	Y            *float64       `json:"y,omitempty"`
	Width        *float64       `json:"width,omitempty"`
	Height       *float64       `json:"height,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	Patch        map[string]any `json:"patch,omitempty"`
	FromNodeID   string         `json:"fromNodeId,omitempty"`
	ToNodeID     string         `json:"toNodeId,omitempty"`
	FromHandleID string         `json:"fromHandleId,omitempty"`
	ToHandleID   string         `json:"toHandleId,omitempty"`
	IDs          []string       `json:"ids,omitempty"`
}

func validateCreationOps(ops []CreationCanvasOp) error {
	if len(ops) == 0 || len(ops) > 100 {
		return BadAuthRequest("方案必须包含 1 到 100 项明确画布操作")
	}
	if err := validateCreationJSON(ops); err != nil {
		return err
	}
	ids := map[string]bool{}
	for _, op := range ops {
		switch op.Type {
		case "add_node":
			if op.ID == "" || ids[op.ID] {
				return BadAuthRequest("新增节点必须使用不重复的稳定 ID")
			}
			ids[op.ID] = true
			if _, ok := creationCanvasCapabilityRegistry.Resolve(op.NodeType); !ok {
				return BadAuthRequest("该节点类型不在本期创作范围")
			}
		case "update_node":
			if op.ID == "" {
				return BadAuthRequest("更新节点缺少 ID")
			}
			for key := range op.Patch {
				switch key {
				case "title", "position", "width", "height", "metadata":
				default:
					return BadAuthRequest("方案包含不支持的节点更新字段")
				}
			}
		case "connect_nodes":
			if op.ID == "" || op.FromNodeID == "" || op.ToNodeID == "" {
				return BadAuthRequest("连线必须有稳定 ID 和两个端点")
			}
		case "select_nodes":
		default:
			return BadAuthRequest("创作方案仅允许新增、连线、更新和选择节点")
		}
	}
	return nil
}

func mergeCreationMaps(left, right map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range left {
		out[key] = value
	}
	for key, value := range right {
		out[key] = value
	}
	return out
}

func (s *Service) CreateRunCanvas(userID, id string, req CreationRequest) (map[string]any, error) {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	var out map[string]any
	err := s.repo.MutateCreationRun(userID, id, func(run *model.CreationRun, _ *repository.Repository) error {
		if err := validateCreationGuard(run, req.CreationGuard); err != nil {
			return err
		}
		if run.Status == "paused" || run.Status == "cancelled" {
			return creationConflict("请先恢复创作任务")
		}
		if run.ApprovedAt == nil {
			return creationConflict("请先确认方案")
		}
		if run.CanvasID == "" {
			run.CanvasID = newID()
			run.Status = "waiting_canvas"
			run.Revision++
		}
		out = map[string]any{"run": creationRunOutput(*run), "canvasId": run.CanvasID}
		return nil
	})
	return out, creationError(err)
}
