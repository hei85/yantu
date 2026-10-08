package database

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func legacyFolderMigrationDatabase(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := Open(Config{Driver: "sqlite", DSN: "file:" + t.Name() + "?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&schemaMigration{}); err != nil {
		t.Fatal(err)
	}
	for _, item := range schemaMigrations[:5] {
		if err := item.apply(db); err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Now().UTC()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec("CREATE TABLE asset_folders (id text primary key, user_id text, name text)").Error; err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"playback_status", "playback_object_key", "playback_error"} {
		if db.Migrator().HasColumn(&model.Resource{}, column) {
			if err := db.Migrator().DropColumn(&model.Resource{}, column); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := db.Create(&schemaMigration{Version: 6, Name: "asset_library_folders", Checksum: assetLibraryFoldersChecksum, AppliedAt: time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC)}).Error; err != nil {
		t.Fatal(err)
	}
	return db
}

func TestMigrateSchemaPreservesLegacyFolderMigration(t *testing.T) {
	db := legacyFolderMigrationDatabase(t)
	var before schemaMigration
	if err := db.First(&before, "version = 6").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO asset_folders (id, user_id, name) VALUES ('kept-folder', 'owner', 'Keep me')").Error; err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		if err := RequireSchemaVersion(db); err != nil {
			t.Fatal(err)
		}
	}
	var after schemaMigration
	if err := db.First(&after, "version = 6").Error; err != nil {
		t.Fatal(err)
	}
	if before.Name != after.Name || before.Checksum != after.Checksum || !before.AppliedAt.Equal(after.AppliedAt) {
		t.Fatalf("historical record changed: before=%+v after=%+v", before, after)
	}
	var playback schemaMigration
	if err := db.First(&playback, "version = 7").Error; err != nil {
		t.Fatal(err)
	}
	if playback.Name != "resource_playback_variant" || playback.Checksum != resourcePlaybackChecksum {
		t.Fatalf("unexpected playback migration: %+v", playback)
	}
	for _, column := range []string{"playback_status", "playback_object_key", "playback_error"} {
		if !db.Migrator().HasColumn(&model.Resource{}, column) {
			t.Fatalf("missing playback column %s", column)
		}
	}
	var name string
	if err := db.Raw("SELECT name FROM asset_folders WHERE id = 'kept-folder'").Scan(&name).Error; err != nil || name != "Keep me" {
		t.Fatalf("folder data changed: %q %v", name, err)
	}
}

func TestMigrateSchemaRejectsUnknownLegacyLineage(t *testing.T) {
	for _, scenario := range []string{"checksum", "name", "version-seven"} {
		t.Run(scenario, func(t *testing.T) {
			db := legacyFolderMigrationDatabase(t)
			switch scenario {
			case "checksum":
				if err := db.Model(&schemaMigration{}).Where("version = 6").Update("checksum", "unknown").Error; err != nil {
					t.Fatal(err)
				}
			case "name":
				if err := db.Model(&schemaMigration{}).Where("version = 6").Update("name", "unknown").Error; err != nil {
					t.Fatal(err)
				}
			case "version-seven":
				if err := db.Create(&schemaMigration{Version: 7, Name: "asset_library_folders", Checksum: assetLibraryFoldersChecksum, AppliedAt: time.Now().UTC()}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := MigrateSchema(db); err == nil || !strings.Contains(err.Error(), "不一致") {
				t.Fatalf("expected lineage rejection, got %v", err)
			}
			if db.Migrator().HasColumn(&model.Resource{}, "playback_status") {
				t.Fatal("rejected migration changed resource schema")
			}
		})
	}
}

func TestMigrateSchemaAddsProductionTraceColumnsWithoutChangingExistingRows(t *testing.T) {
	db := legacyFolderMigrationDatabase(t)
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	run := model.ProductionRun{ID: "run-existing", UserID: "owner", ClientKey: "client", BriefJSON: `{"targetDurationMs":180000}`, TargetDurationMs: 180000}
	if err := db.Create(&run).Error; err != nil {
		t.Fatal(err)
	}
	step := model.ProductionStep{ID: "step-existing", RunID: run.ID, StepKey: "shot-1-video", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "segment-1", SegmentOrder: 0, Status: "pending"}
	if err := db.Create(&step).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "task-existing", UserID: "owner", ProductionRunID: run.ID, ProductionStepID: step.ID, ProductionAttemptID: "attempt-existing", StoryboardRowID: "shot-01", SegmentID: "segment-1", SegmentOrder: 0, Type: "canvas_video"}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.ProductionRun{}, "DeliveryContractJSON"); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"StoryboardRowID", "SegmentID", "SegmentOrder", "TrackID"} {
		if err := db.Migrator().DropColumn(&model.ProductionStep{}, column); err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range []string{"EstimatedCostMicros", "Superseded"} {
		if err := db.Migrator().DropColumn(&model.ProductionStep{}, column); err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range []string{"ProductionRunID", "ProductionStepID", "ProductionAttemptID", "CapabilityRevision", "StoryboardRowID", "SegmentID", "SegmentOrder", "TrackID"} {
		if err := db.Migrator().DropColumn(&model.Task{}, column); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Where("version >= ?", 32).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasColumn(&model.ProductionRun{}, "DeliveryContractJSON") {
		t.Fatal("production_runs is missing the delivery contract column")
	}
	for _, modelAndColumn := range []struct {
		model  any
		column string
	}{
		{&model.ProductionStep{}, "StoryboardRowID"}, {&model.ProductionStep{}, "SegmentID"}, {&model.ProductionStep{}, "SegmentOrder"},
		{&model.ProductionStep{}, "EstimatedCostMicros"}, {&model.ProductionStep{}, "Superseded"},
		{&model.ProductionStep{}, "TrackID"},
		{&model.Task{}, "ProductionRunID"}, {&model.Task{}, "ProductionStepID"}, {&model.Task{}, "ProductionAttemptID"},
		{&model.Task{}, "CapabilityRevision"},
		{&model.Task{}, "StoryboardRowID"}, {&model.Task{}, "SegmentID"}, {&model.Task{}, "SegmentOrder"},
		{&model.Task{}, "TrackID"},
	} {
		if !db.Migrator().HasColumn(modelAndColumn.model, modelAndColumn.column) {
			t.Fatalf("%T is missing trace column %s", modelAndColumn.model, modelAndColumn.column)
		}
	}
	var persisted model.ProductionRun
	if err := db.First(&persisted, "id = ?", run.ID).Error; err != nil {
		t.Fatal(err)
	}
	if persisted.BriefJSON != run.BriefJSON || persisted.TargetDurationMs != run.TargetDurationMs || persisted.DeliveryContractJSON != "" {
		t.Fatalf("existing production run changed during additive migration: %+v", persisted)
	}
	var persistedStep model.ProductionStep
	if err := db.First(&persistedStep, "id = ?", step.ID).Error; err != nil {
		t.Fatal(err)
	}
	if persistedStep.RunID != run.ID || persistedStep.StepKey != step.StepKey || persistedStep.Status != step.Status || persistedStep.StoryboardRowID != "" || persistedStep.SegmentID != "" || persistedStep.EstimatedCostMicros != 0 || persistedStep.Superseded {
		t.Fatalf("existing production step changed unexpectedly: %+v", persistedStep)
	}
	var persistedTask model.Task
	if err := db.First(&persistedTask, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if persistedTask.ID != task.ID || persistedTask.UserID != task.UserID || persistedTask.Type != task.Type || persistedTask.StoryboardRowID != "" {
		t.Fatalf("existing task changed unexpectedly: %+v", persistedTask)
	}
}

func TestProductionAudioModeVoiceVersionMigrationBackfillsAndDefaultsSafely(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:" + t.Name() + "?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.ProductionRun{}, &model.VoiceProfile{}, &model.CharacterVoiceBinding{}, &model.AssetVersion{}); err != nil {
		t.Fatal(err)
	}
	profiles := []model.VoiceProfile{
		{ID: "profile-standard", UserID: "owner", Name: "普通声音", Provider: "custom", VoiceKey: "voice-standard", Language: "zh-CN", Timbre: "warm", CompatibleModelsJSON: `[]`, Status: "active"},
		{ID: "profile-upload", UserID: "owner", Name: "参考样音", Provider: "user_upload", VoiceKey: "sample:resource-voice", SampleResourceID: "resource-voice", CompatibleModelsJSON: `[]`, Status: "active"},
	}
	for _, profile := range profiles {
		if err := db.Create(&profile).Error; err != nil {
			t.Fatal(err)
		}
	}
	assetVersions := []model.AssetVersion{
		{ID: "character-standard-v1", AssetID: "character-standard", Version: 1, Status: model.AssetVersionStatusConfirmed},
		{ID: "character-upload-v1", AssetID: "character-upload", Version: 1, Status: model.AssetVersionStatusConfirmed},
	}
	for _, version := range assetVersions {
		if err := db.Create(&version).Error; err != nil {
			t.Fatal(err)
		}
	}
	bindings := []model.CharacterVoiceBinding{
		{ID: "binding-standard", AssetVersionID: "character-standard-v1", VoiceProfileID: "profile-standard"},
		{ID: "binding-upload", AssetVersionID: "character-upload-v1", VoiceProfileID: "profile-upload"},
	}
	for _, binding := range bindings {
		if err := db.Create(&binding).Error; err != nil {
			t.Fatal(err)
		}
	}
	runs := []model.ProductionRun{
		{ID: "run-native", UserID: "owner", ClientKey: "native", PlanJSON: `{"executionManifest":{"audioPolicy":"mixed"}}`},
		{ID: "run-rebuild", UserID: "owner", ClientKey: "rebuild", PlanJSON: `{"executionManifest":{"audioPolicy":"independent","audioStepKeys":["audio:dialogue"],"audioTrackBindings":[{"trackId":"dialogue"}]}}`},
		{ID: "run-rebuild-pending", UserID: "owner", ClientKey: "rebuild-pending", PlanJSON: `{"executionManifest":{"audioPolicy":"independent"}}`},
	}
	for _, run := range runs {
		if err := db.Create(&run).Error; err != nil {
			t.Fatal(err)
		}
	}

	if err := migrateProductionAudioModeVoiceVersion(db); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []struct {
		bindingID   string
		strategy    string
		voiceID     string
		referenceID string
		status      string
		authorized  bool
	}{
		{bindingID: "binding-standard", strategy: "standard_tts", voiceID: "voice-standard", status: "ready"},
		{bindingID: "binding-upload", strategy: "voice_reference", referenceID: "resource-voice", status: "requires_authorization"},
	} {
		var binding model.CharacterVoiceBinding
		if err := db.First(&binding, "id = ?", expected.bindingID).Error; err != nil {
			t.Fatal(err)
		}
		if binding.VoiceVersionID == "" {
			t.Fatalf("legacy binding %s was not linked to a VoiceVersion", binding.ID)
		}
		var version model.VoiceProfileVersion
		if err := db.First(&version, "id = ?", binding.VoiceVersionID).Error; err != nil {
			t.Fatal(err)
		}
		if version.VoiceStrategy != expected.strategy || version.VoiceID != expected.voiceID || version.ReferenceAudioResourceID != expected.referenceID || version.Status != expected.status || version.ReferenceAudioAuthorized != expected.authorized {
			t.Fatalf("backfilled VoiceVersion = %+v, want %+v", version, expected)
		}
	}
	for _, expected := range []struct {
		id          string
		audioMode   string
		audioPolicy string
	}{
		{id: "run-native", audioMode: model.ProductionAudioModeNative, audioPolicy: "native"},
		{id: "run-rebuild", audioMode: model.ProductionAudioModeRebuild, audioPolicy: "independent"},
		{id: "run-rebuild-pending", audioMode: model.ProductionAudioModeRebuild, audioPolicy: "independent"},
	} {
		var run model.ProductionRun
		if err := db.First(&run, "id = ?", expected.id).Error; err != nil {
			t.Fatal(err)
		}
		var plan map[string]any
		if err := json.Unmarshal([]byte(run.PlanJSON), &plan); err != nil {
			t.Fatal(err)
		}
		manifest, _ := plan["executionManifest"].(map[string]any)
		if run.AudioMode != expected.audioMode || manifest["audioMode"] != expected.audioMode || manifest["audioPolicy"] != expected.audioPolicy {
			t.Fatalf("migrated run = mode %q manifest %#v; want mode %q policy %q", run.AudioMode, manifest, expected.audioMode, expected.audioPolicy)
		}
	}
}
