package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestVideoOutputObservationUsesActualDimensions(t *testing.T) {
	for _, tc := range []struct {
		ratio, tier   string
		width, height int
		match         bool
	}{
		{"16:9", "768P", 1344, 768, true}, {"16:9", "768P", 768, 1344, false},
		{"16:9", "2K", 768, 1344, false}, {"16:9", "2K", 2688, 1536, true},
	} {
		got := videoOutputObservation("task", "MODEL:2", tc.ratio, tc.tier, "resource", tc.width, tc.height)
		if got == nil || (got.Verdict == "observed_mismatch") == tc.match || got.Details["fullDecodePassed"] != false {
			t.Fatalf("incorrect actual evidence: %#v", got)
		}
	}
	if videoOutputObservation("task", "rev", "16:9", "768P", "", 1344, 768) != nil {
		t.Fatal("missing resource is not evidence")
	}
	unknown := videoOutputObservation("task", "rev", "adaptive", "auto", "res", 1344, 768)
	if _, ok := unknown.Details["resolutionMatched"]; ok {
		t.Fatal("channel default cannot be called a measured tier")
	}
	if _, ok := unknown.Details["aspectRatioMatched"]; ok {
		t.Fatal("adaptive ratio cannot be called a measured requested ratio")
	}
}

func TestVideoOutputEvidenceDoesNotChangeContractOrRetry(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	channel := &model.ModelChannel{ID: "OUTPUT_CHANNEL", UserID: "user-1", Scope: model.ChannelScopeSystem, Enabled: true}
	if err := db.Create(channel).Error; err != nil {
		t.Fatal(err)
	}
	config := DefaultModelCapabilityConfigForModel("newapi", "future-video")
	config.Video.Resolutions = []string{"768P", "2K"}
	config.Video.DefaultResolution = "768P"
	config.Observed = []CapabilityObservation{{Feature: "image_input", Verdict: "unsupported", Source: "upstream"}}
	encoded, _ := json.Marshal(config)
	item := &model.ChannelModel{ID: "OUTPUT_MODEL", ChannelID: channel.ID, ModelKey: "future-video", ProviderModelKey: "future-video", Capability: "video", Enabled: true, CapabilityVersion: 3, CapabilityConfigJSON: string(encoded)}
	if err := db.Create(item).Error; err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"config": providerConfig{ChannelID: channel.ID, Model: "future-video", Size: "16:9", VQuality: "2K"}})
	task := model.Task{ID: "OUTPUT_TASK", Type: "canvas_video", InputJSON: string(input), CapabilityRevision: "OUTPUT_MODEL:3"}
	result := map[string]interface{}{"video": map[string]interface{}{"resourceId": "OUTPUT_RES", "width": 768, "height": 1344}}
	svc.recordVideoOutputObservation(task, result)
	svc.recordVideoOutputObservation(task, result)
	stored, err := svc.repo.ChannelModelByID(channel.ID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	updated, _ := DecodeModelCapabilityConfig(stored.CapabilityConfigJSON)
	if len(updated.Observed) != 2 || updated.Observed[0].Verdict != "unsupported" || updated.Observed[1].Verdict != "observed_mismatch" || stored.CapabilityVersion != 3 || len(updated.Video.Resolutions) != 2 || !stored.Enabled {
		t.Fatalf("evidence modified the contract: %#v %#v", stored, updated)
	}
	if changed, err := svc.repo.SaveChannelModelObservedEvidence(item.ID, 3, string(encoded), "{}"); err != nil || changed {
		t.Fatal("stale evidence overwrote a newer contract")
	}
	svc.recordVideoOutputObservation(task, result, true)
	stored, _ = svc.repo.ChannelModelByID(channel.ID, item.ID)
	decoded, _ := DecodeModelCapabilityConfig(stored.CapabilityConfigJSON)
	if len(decoded.Observed) != 2 || decoded.Observed[1].Details["fullDecodePassed"] != true || decoded.Observed[1].Verdict != "observed_mismatch" {
		t.Fatal("full decode must enrich real evidence without promoting a mismatch to support")
	}
	newer := task
	newer.ID = "OUTPUT_TASK_NEW"
	svc.recordVideoOutputObservation(newer, result)
	svc.recordVideoOutputObservation(task, result, true)
	stored, _ = svc.repo.ChannelModelByID(channel.ID, item.ID)
	latest, _ := DecodeModelCapabilityConfig(stored.CapabilityConfigJSON)
	if latest.Observed[1].Details["taskId"] != newer.ID {
		t.Fatal("an old probe replaced the latest test")
	}
}

func TestVideoProbeRecoversOwnedRequestEvidenceAfterCompletion(t *testing.T) {
	for _, tc := range []struct {
		name, logUser, revision string
		logStatus               model.ApiCallStatus
		want                    bool
	}{
		{"actual completed request", "user-1", "PROBE_MODEL:3", model.ApiCallStatusSucceeded, true},
		{"foreign request", "other-user", "PROBE_MODEL:3", model.ApiCallStatusSucceeded, false},
		{"failed request", "user-1", "PROBE_MODEL:3", model.ApiCallStatusFailed, false},
		{"old contract", "user-1", "PROBE_MODEL:2", model.ApiCallStatusSucceeded, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, db := newChannelModelTestService(t)
			if err := db.AutoMigrate(&model.ApiCallLog{}); err != nil {
				t.Fatal(err)
			}
			channel := model.ModelChannel{ID: "PROBE_CHANNEL", UserID: "user-1", Enabled: true}
			config := DefaultModelCapabilityConfigForModel("newapi", "future-video")
			config.Video.Resolutions = []string{"768P", "2K"}
			encoded, _ := json.Marshal(config)
			item := model.ChannelModel{ID: "PROBE_MODEL", ChannelID: channel.ID, ModelKey: "future-video", ProviderModelKey: "upstream-alias", Capability: "video", Enabled: true, CapabilityVersion: 3, CapabilityConfigJSON: string(encoded)}
			for _, value := range []any{&channel, &item} {
				if err := db.Create(value).Error; err != nil {
					t.Fatal(err)
				}
			}
			task := model.Task{ID: "PROBE_TASK", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusSucceeded,
				CapabilityRevision: tc.revision, InputJSON: `{"mode":"text","metadata":{}}`, ResultJSON: `{"video":{"resourceId":"PROBE_RES"}}`}
			root := model.ApiCallLog{ID: "PROBE_LOG", TaskID: task.ID, UserID: tc.logUser, ChannelID: channel.ID, Capability: "video", RequestKind: "create", Status: tc.logStatus, Model: "upstream-alias",
				RequestBody: `{"model":"upstream-alias","size":"2560x1440","aspect_ratio":"16:9","resolution_name":"2K","apiKey":"must-never-be-retained"}`}
			for _, value := range []any{&task, &root} {
				if err := db.Create(value).Error; err != nil {
					t.Fatal(err)
				}
			}
			svc.recordProbedVideoOutput(task.UserID, "PROBE_RES", mediaProbeReport{Decoded: true, Width: 768, Height: 1344})
			stored, err := svc.repo.ChannelModelByID(channel.ID, item.ID)
			if err != nil {
				t.Fatal(err)
			}
			updated, _ := DecodeModelCapabilityConfig(stored.CapabilityConfigJSON)
			if !tc.want {
				if len(updated.Observed) != 0 {
					t.Fatal("unrelated or stale request became evidence")
				}
				return
			}
			if len(updated.Observed) != 1 || updated.Observed[0].Verdict != "observed_mismatch" || updated.Observed[0].Details["fullDecodePassed"] != true || updated.Observed[0].Details["requestEvidenceSource"] != "provider_request_log" {
				t.Fatalf("missing actual completed request evidence: %#v", updated.Observed)
			}
			if stored.CapabilityVersion != 3 || len(updated.Video.Resolutions) != 2 || strings.Contains(stored.CapabilityConfigJSON, "must-never-be-retained") {
				t.Fatal("evidence retained credentials or changed the contract")
			}
			svc.recordProbedVideoOutput("other-user", "PROBE_RES", mediaProbeReport{Decoded: true, Width: 1920, Height: 1080})
			storedAgain, _ := svc.repo.ChannelModelByID(channel.ID, item.ID)
			if storedAgain.CapabilityConfigJSON != stored.CapabilityConfigJSON {
				t.Fatal("a different user's probe changed evidence")
			}
		})
	}
}
