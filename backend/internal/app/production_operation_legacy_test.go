package app

import (
	"infinite-canvas/backend/internal/model"
	"testing"
)

func TestPersistInferredMediaOperation(t *testing.T) {
	for _, tt := range []struct {
		mode string
		refs bool
		want string
	}{
		{"video", true, "image_to_video"}, {"video", false, "text_to_video"},
		{"image", true, "image_to_image"}, {"image", false, "text_to_image"},
	} {
		in := map[string]any{"mode": tt.mode}
		if tt.refs {
			in["referenceImages"] = []any{map[string]any{"storageKey": "resource:fixture"}}
		}
		if got := inferredTaskOperation(in, "canvas_"+tt.mode); got != tt.want {
			t.Fatalf("got %s want %s", got, tt.want)
		}
	}
}

func TestLegacyProductionOperationPreservesStrictExplicitMismatch(t *testing.T) {
	task := model.Task{Type: "canvas_video", Status: model.TaskStatusSucceeded, ProductionRunID: "run", StoryboardRowID: "row", SegmentID: "seg", InputJSON: `{"mode":"video","metadata":{"productionRunId":"run","storyboardRowId":"row","segmentId":"seg"}}`}
	if !productionTaskOperationMatches(task, "image_to_video") {
		t.Fatal("legacy compacted task rejected")
	}
	task.Operation = "text_to_video"
	if productionTaskOperationMatches(task, "image_to_video") {
		t.Fatal("explicit mismatch accepted")
	}
	task.Operation = ""
	task.SegmentID = "other"
	if productionTaskOperationMatches(task, "image_to_video") {
		t.Fatal("unbound legacy task accepted")
	}
	task.SegmentID = "seg"
	task.InputJSON = `{"mode":"video","referenceImages":[]}`
	if productionTaskOperationMatches(task, "image_to_video") {
		t.Fatal("non-compacted task accepted")
	}
}
