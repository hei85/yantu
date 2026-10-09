package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// 31：ProductionAttempt 增加 ReservedCostMicros 预留金额列（增量迁移，不重建表）。
// 32：ProductionRun 持久化不可被调用方缩短的交付合同。
// 33：制作步骤、生成任务保存稳定分镜行与分段追踪身份。
// 34：制作步骤保存重做成本估算，并为计划替换步骤保留 superseded 历史。
// 35：制作步骤和生成任务持久保存分镜音轨 ID。
const CurrentSchemaVersion int64 = 37
const productionRuntimeChecksum = "sha256:production-runtime-v29-20260923"
const taskClientOperationChecksum = "sha256:task-client-operation-v30-20260923"
const productionBudgetChecksum = "sha256:production-budget-v31-20260923"
const productionDeliveryContractChecksum = "sha256:production-delivery-contract-v32-20260923"
const productionStoryboardTraceChecksum = "sha256:production-row-segment-capability-trace-v33-20260923"
const productionPlanInvalidationChecksum = "sha256:production-plan-cost-invalidation-v34-20260923"
const productionAudioTrackTraceChecksum = "sha256:production-audio-track-trace-v35-20260923"
const productionAudioModeVoiceVersionChecksum = "sha256:production-audio-mode-voice-version-v36-20260925"

const baselineSchemaChecksum = "sha256:open-ai-canvas-schema-v1-20260830"
const schemaMigrationAppliedAtIndexChecksum = "sha256:schema-migrations-applied-at-index-v2-20260830"
const assetTaxonomyCandidateIdentityChecksum = "sha256:asset-taxonomy-candidate-identity-v3-20260831-r1"
const resourceUploadKeyChecksum = "sha256:resource-upload-key-v4-20260901"
const paymentTopupChecksum = "sha256:payment-topup-v5-20260902"
const resourcePlaybackChecksum = "sha256:resource-playback-v6-20260902"
const assetLibraryFoldersChecksum = "sha256:asset-library-folders-v6-20260902"
const logicalModelActiveCodeChecksum = "sha256:logical-model-active-code-v8-20260905"
const creationRuntimeChecksum = "sha256:creation-runtime-v10-20260909"
const creationConfirmationStatusChecksum = "sha256:creation-confirmation-status-v28-20260922"

const postgresSchemaMigrationLockID int64 = 73123910420260830

type SchemaStatus struct {
	Current  int64 `json:"current"`
	Expected int64 `json:"expected"`
	Ready    bool  `json:"ready"`
}

type schemaMigration struct {
	Version   int64     `gorm:"primaryKey"`
	Name      string    `gorm:"size:160;not null"`
	Checksum  string    `gorm:"size:96;not null"`
	AppliedAt time.Time `gorm:"not null"`
}

func (schemaMigration) TableName() string { return "schema_migrations" }

type migration struct {
	version  int64
	name     string
	checksum string
	apply    func(*gorm.DB) error
}

var schemaMigrations = []migration{
	{version: 1, name: "baseline_gorm_schema", checksum: baselineSchemaChecksum, apply: migrateSchemaV1},
	{version: 2, name: "schema_migrations_applied_at_index", checksum: schemaMigrationAppliedAtIndexChecksum, apply: migrateSchemaV2},
	{version: 3, name: "asset_taxonomy_candidate_identity", checksum: assetTaxonomyCandidateIdentityChecksum, apply: migrateSchemaV3},
	{version: 4, name: "resource_upload_key", checksum: resourceUploadKeyChecksum, apply: migrateSchemaV4},
	{version: 5, name: "payment_topup", checksum: paymentTopupChecksum, apply: migrationNoop},
	{version: 6, name: "resource_playback_variant", checksum: resourcePlaybackChecksum, apply: migrateSchemaV6},
	{version: 7, name: "asset_library_folders", checksum: assetLibraryFoldersChecksum, apply: migrateSchemaV7},
	{version: 8, name: "logical_model_active_code", checksum: logicalModelActiveCodeChecksum, apply: migrateSchemaV8},
	{version: 9, name: "channel_presentation", checksum: "sha256:channel-presentation-v9-20260908", apply: migrateChannelPresentation},
	{version: 10, name: "creation_runtime", checksum: creationRuntimeChecksum, apply: migrateSchemaV10},
	{version: 11, name: "cloud_agent_runtime", checksum: "sha256:cloud-agent-runtime-v11-20260912", apply: migrationNoop},
	{version: 12, name: "agent_token_charge_limit", checksum: "sha256:agent-token-charge-limit-v12-20260913", apply: migrationNoop},
	{version: 13, name: "cloud_agent_canvas_mutation", checksum: "sha256:cloud-agent-canvas-mutation-v13-20260913", apply: migrationNoop},
	{version: 14, name: "cloud_agent_recovery_control", checksum: "sha256:cloud-agent-recovery-control-v14", apply: migrationNoop},
	{version: 15, name: "agent_profiles", checksum: "sha256:agent-profiles-v15-20260914", apply: migrationNoop},
	{version: 16, name: "agent_lessons", checksum: "sha256:agent-lessons-v16-20260917", apply: migrationNoop},
	{version: 17, name: "agent_lessons_owner_index", checksum: "sha256:agent-lessons-owner-index-v17-20260917", apply: migrationNoop},
	{version: 18, name: "agent_memory_settings", checksum: "sha256:agent-memory-settings-v18-20260917", apply: migrationNoop},
	{version: 19, name: "payment_plugin_version", checksum: "sha256:payment-plugin-version-v19-20260917", apply: migrationNoop},
	{version: 20, name: "banner_announcements", checksum: "sha256:banner-announcements-v20-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.BannerAnnouncement{})
	}},
	{version: 21, name: "banner_announcement_title_runs", checksum: "sha256:banner-announcement-title-runs-v21-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.BannerAnnouncement{})
	}},
	{version: 22, name: "banner_announcement_notice_type", checksum: "sha256:banner-announcement-notice-type-v22-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.BannerAnnouncement{})
	}},
	{version: 23, name: "canvas_revision_history", checksum: "sha256:canvas-revision-history-v23-20260918", apply: migrationNoop},
	{version: 24, name: "channel_model_label", checksum: "sha256:channel-model-label-v24", apply: migrateChannelModelLabel},
	{version: 25, name: "video_token_formula_snapshot", checksum: "sha256:video-token-formula-snapshot-v25", apply: migrationNoop},
	{version: 26, name: "channel_model_description", checksum: "sha256:channel-model-description-v26", apply: migrateChannelModelDescription},
	{version: 27, name: "channel_credit_cost", checksum: "sha256:channel-credit-cost-v27", apply: migrationNoop},
	{version: 28, name: "creation_confirmation_status", checksum: creationConfirmationStatusChecksum, apply: migrateCreationConfirmationStatus},
	{version: 29, name: "production_runtime", checksum: productionRuntimeChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.ProductionRun{}, &model.ProductionStep{}, &model.ProductionAttempt{}, &model.ProductionRunEvent{})
	}},
	{version: 30, name: "task_client_operation", checksum: taskClientOperationChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.Task{})
	}},
	{version: 31, name: "production_budget_reservation", checksum: productionBudgetChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.ProductionAttempt{})
	}},
	{version: 32, name: "production_delivery_contract", checksum: productionDeliveryContractChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.ProductionRun{})
	}},
	{version: 33, name: "production_storyboard_trace", checksum: productionStoryboardTraceChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.ProductionStep{}, &model.Task{})
	}},
	{version: 34, name: "production_plan_invalidation", checksum: productionPlanInvalidationChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.ProductionStep{})
	}},
	{version: 35, name: "production_audio_track_trace", checksum: productionAudioTrackTraceChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.ProductionStep{}, &model.Task{})
	}},
	{version: 36, name: "production_audio_mode_voice_version", checksum: productionAudioModeVoiceVersionChecksum, apply: migrateProductionAudioModeVoiceVersion},
	{version: 37, name: "shared_browser_workspace", checksum: "sha256:shared-browser-workspace-v37-20261009", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.WorkspaceDocument{}, &model.WorkspaceDocumentRevision{})
	}},
}

func migrateProductionAudioModeVoiceVersion(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.ProductionRun{}, &model.VoiceProfile{}, &model.VoiceProfileVersion{}, &model.CharacterVoiceBinding{}); err != nil {
		return err
	}
	if err := backfillLegacyCharacterVoiceVersions(tx); err != nil {
		return err
	}
	var runs []model.ProductionRun
	if err := tx.Where("audio_mode = '' OR audio_mode IS NULL").Find(&runs).Error; err != nil {
		return err
	}
	for _, run := range runs {
		var plan map[string]any
		if strings.TrimSpace(run.PlanJSON) != "" {
			if err := json.Unmarshal([]byte(run.PlanJSON), &plan); err != nil {
				return fmt.Errorf("parse production run %s plan during audio migration: %w", run.ID, err)
			}
		}
		manifest, _ := plan["executionManifest"].(map[string]any)
		mode := model.ProductionAudioModeNative
		if manifest != nil {
			policy := strings.ToLower(strings.TrimSpace(fmt.Sprint(manifest["audioPolicy"])))
			declaredMode := strings.ToUpper(strings.TrimSpace(fmt.Sprint(manifest["audioMode"])))
			keys, _ := manifest["audioStepKeys"].([]any)
			bindings, _ := manifest["audioTrackBindings"].([]any)
			if policy == "independent" || declaredMode == model.ProductionAudioModeRebuild || len(keys) > 0 || len(bindings) > 0 {
				mode = model.ProductionAudioModeRebuild
				manifest["audioPolicy"] = "independent"
			} else {
				manifest["audioPolicy"] = "native"
			}
			manifest["audioMode"] = mode
			plan["executionManifest"] = manifest
		}
		encoded := run.PlanJSON
		if plan != nil {
			data, err := json.Marshal(plan)
			if err != nil {
				return err
			}
			encoded = string(data)
		}
		if err := tx.Model(&model.ProductionRun{}).Where("id = ?", run.ID).Updates(map[string]any{"audio_mode": mode, "plan_json": encoded}).Error; err != nil {
			return err
		}
	}
	return nil
}

func backfillLegacyCharacterVoiceVersions(tx *gorm.DB) error {
	var bindings []model.CharacterVoiceBinding
	if err := tx.Where("(voice_version_id = '' OR voice_version_id IS NULL) AND voice_profile_id <> ''").Find(&bindings).Error; err != nil {
		return err
	}
	for _, binding := range bindings {
		var profile model.VoiceProfile
		if err := tx.First(&profile, "id = ?", binding.VoiceProfileID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			return err
		}
		var assetVersion model.AssetVersion
		if err := tx.First(&assetVersion, "id = ?", binding.AssetVersionID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			return err
		}
		if strings.TrimSpace(assetVersion.AssetID) == "" {
			continue
		}

		var voiceVersion model.VoiceProfileVersion
		err := tx.Where("voice_profile_id = ? AND character_asset_id = ?", profile.ID, assetVersion.AssetID).
			Order("version desc").First(&voiceVersion).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			var latestVersion int
			if err := tx.Model(&model.VoiceProfileVersion{}).Where("voice_profile_id = ?", profile.ID).
				Select("COALESCE(MAX(version), 0)").Scan(&latestVersion).Error; err != nil {
				return err
			}
			strategy := "standard_tts"
			voiceID := strings.TrimSpace(profile.VoiceKey)
			referenceAudioID := ""
			referenceAuthorized := false
			status := "ready"
			voiceModel := ""
			if profile.Provider == "user_upload" {
				strategy = "voice_reference"
				voiceID = ""
				referenceAudioID = strings.TrimSpace(profile.SampleResourceID)
				status = "requires_authorization"
			} else if profile.Provider == "voice_design" {
				strategy = "voice_design"
				if raw := strings.TrimSpace(profile.CompatibleModelsJSON); raw != "" {
					var compatibleModels []string
					if err := json.Unmarshal([]byte(raw), &compatibleModels); err != nil {
						return fmt.Errorf("parse compatible models for legacy voice profile %s: %w", profile.ID, err)
					}
					if len(compatibleModels) == 1 {
						voiceModel = strings.TrimSpace(compatibleModels[0])
					}
				}
			}
			if profile.Status != "active" {
				status = "unavailable"
			}
			voiceVersion = model.VoiceProfileVersion{
				ID: uuid.NewString(), VoiceProfileID: profile.ID, CharacterAssetID: assetVersion.AssetID,
				Version: latestVersion + 1, VoiceStrategy: strategy, VoiceModel: voiceModel, VoiceID: voiceID,
				ReferenceAudioResourceID: referenceAudioID, ReferenceAudioAuthorized: referenceAuthorized,
				Tone: profile.Timbre, Language: profile.Language, SpeakingRate: 1, Status: status, CreatedAt: time.Now(),
			}
			if err := tx.Create(&voiceVersion).Error; err != nil {
				return err
			}
		}
		if err := tx.Model(&model.CharacterVoiceBinding{}).Where("id = ?", binding.ID).Update("voice_version_id", voiceVersion.ID).Error; err != nil {
			return err
		}
	}
	return nil
}

// migrateCreationConfirmationStatus 把历史创作状态 waiting_payment 迁移为 waiting_confirmation。
func migrateCreationConfirmationStatus(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.CreationRun{}) {
		return nil
	}
	return tx.Model(&model.CreationRun{}).Where("status = ?", "waiting_payment").Update("status", "waiting_confirmation").Error
}

// migrationNoop 保留历史版本号，让已升级过的数据库继续通过校验；全新的数据库不再创建已下线的付费表。
func migrationNoop(*gorm.DB) error { return nil }

func migrateChannelModelDescription(tx *gorm.DB) error {
	if tx.Migrator().HasColumn(&model.ChannelModel{}, "Description") {
		return nil
	}
	return tx.Migrator().AddColumn(&model.ChannelModel{}, "Description")
}

func migrateChannelModelLabel(tx *gorm.DB) error {
	if tx.Migrator().HasColumn(&model.ChannelModel{}, "ChannelLabel") {
		return nil
	}
	return tx.Migrator().AddColumn(&model.ChannelModel{}, "ChannelLabel")
}

func migrateChannelPresentation(tx *gorm.DB) error {
	for _, column := range []struct {
		model any
		field string
	}{{&model.ModelChannel{}, "PublicAlias"}, {&model.ModelChannel{}, "SortOrder"}, {&model.ChannelModel{}, "SortOrder"}} {
		if !tx.Migrator().HasColumn(column.model, column.field) {
			if err := tx.Migrator().AddColumn(column.model, column.field); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrationsForDatabase(db *gorm.DB) ([]migration, error) {
	var applied schemaMigration
	err := db.First(&applied, "version = ?", 6).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return schemaMigrations, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取数据库迁移 6：%w", err)
	}
	if applied.Name != "asset_library_folders" {
		return schemaMigrations, nil
	}
	legacy := migration{version: 6, name: "asset_library_folders", checksum: assetLibraryFoldersChecksum, apply: migrateSchemaV7}
	if err := validateMigrationRecord(applied, legacy); err != nil {
		return nil, err
	}
	plan := append([]migration(nil), schemaMigrations...)
	for index, item := range plan {
		switch item.version {
		case 6:
			plan[index] = legacy
		case 7:
			plan[index] = migration{version: 7, name: "resource_playback_variant", checksum: resourcePlaybackChecksum, apply: migrateSchemaV6}
		}
	}
	return plan, nil
}

func migrateSchemaV2(tx *gorm.DB) error {
	return tx.Exec("CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations (applied_at)").Error
}

func migrateSchemaV3(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.ProjectAssetCandidate{}); err != nil {
		return fmt.Errorf("扩展资产候选身份字段：%w", err)
	}
	if err := tx.Exec("UPDATE assets SET category = 'prop' WHERE category IN ('wardrobe', 'weapon', 'accessory')").Error; err != nil {
		return fmt.Errorf("合并资产道具分类：%w", err)
	}
	if err := tx.Exec("UPDATE assets SET category = 'material' WHERE category = 'style' OR (category = 'other' AND kind IN ('image', 'video', 'audio', 'model'))").Error; err != nil {
		return fmt.Errorf("迁移资产素材分类：%w", err)
	}
	if err := tx.Exec("UPDATE project_asset_candidates SET category = 'prop' WHERE category IN ('wardrobe', 'weapon', 'accessory')").Error; err != nil {
		return fmt.Errorf("合并候选道具分类：%w", err)
	}
	if err := tx.Exec("UPDATE project_asset_candidates SET category = 'material' WHERE category = 'style'").Error; err != nil {
		return fmt.Errorf("迁移候选素材分类：%w", err)
	}
	var candidates []model.ProjectAssetCandidate
	if err := tx.Order("created_at asc, id asc").Find(&candidates).Error; err != nil {
		return fmt.Errorf("读取资产候选身份：%w", err)
	}
	seenPending := make(map[string]string, len(candidates))
	for _, candidate := range candidates {
		nameKey := model.AssetCandidateNameKey(candidate.Name)
		updates := map[string]any{"name_key": nameKey}
		identity := candidate.ProjectID + ":" + string(candidate.Category) + ":" + nameKey
		if candidate.Status == "pending_confirmation" && nameKey != "" {
			if _, exists := seenPending[identity]; exists {
				updates["status"] = "ignored"
			} else {
				seenPending[identity] = candidate.ID
			}
		}
		if err := tx.Model(&model.ProjectAssetCandidate{}).Where("id = ?", candidate.ID).Updates(updates).Error; err != nil {
			return fmt.Errorf("回填资产候选身份 %s：%w", candidate.ID, err)
		}
	}
	return tx.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_asset_candidates_pending_identity ON project_asset_candidates(project_id, category, name_key) WHERE status = 'pending_confirmation' AND name_key <> ''").Error
}

func migrateSchemaV4(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.Resource{}) {
		return fmt.Errorf("资源表不存在")
	}
	if !tx.Migrator().HasColumn(&model.Resource{}, "upload_key") {
		if err := tx.Migrator().AddColumn(&model.Resource{}, "UploadKey"); err != nil {
			return fmt.Errorf("增加资源上传幂等列：%w", err)
		}
	}
	if err := tx.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_user_upload_key ON resources (user_id, upload_key)").Error; err != nil {
		return fmt.Errorf("创建资源上传幂等索引：%w", err)
	}
	return nil
}
func migrateSchemaV6(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.Resource{}) {
		return fmt.Errorf("资源表不存在")
	}
	if !tx.Migrator().HasColumn(&model.Resource{}, "playback_status") {
		if err := tx.Migrator().AddColumn(&model.Resource{}, "PlaybackStatus"); err != nil {
			return fmt.Errorf("增加播放副本状态列：%w", err)
		}
	}
	if !tx.Migrator().HasColumn(&model.Resource{}, "playback_object_key") {
		if err := tx.Migrator().AddColumn(&model.Resource{}, "PlaybackObjectKey"); err != nil {
			return fmt.Errorf("增加播放副本对象键列：%w", err)
		}
	}
	if !tx.Migrator().HasColumn(&model.Resource{}, "playback_error") {
		if err := tx.Migrator().AddColumn(&model.Resource{}, "PlaybackError"); err != nil {
			return fmt.Errorf("增加播放副本错误列：%w", err)
		}
	}
	return nil
}

func migrateSchemaV7(tx *gorm.DB) error {
	// Personal cloud asset folders are no longer part of the application schema.
	return nil
}

func migrateSchemaV8(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.LogicalModel{}) {
		return nil
	}
	if err := tx.Exec("DROP INDEX IF EXISTS idx_logical_models_code").Error; err != nil {
		return fmt.Errorf("移除前台模型旧 code 唯一索引：%w", err)
	}
	if err := tx.Exec("CREATE UNIQUE INDEX idx_logical_models_code ON logical_models(code) WHERE archived_at IS NULL").Error; err != nil {
		return fmt.Errorf("创建前台模型活动 code 唯一索引：%w", err)
	}
	return nil
}

// migrateSchemaV10 只增加创作运行时表和任务幂等关联；旧任务的空 submission ID 必须继续合法。
func migrateSchemaV10(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.CreationRun{}, &model.CreationSubmission{}, &model.Task{}); err != nil {
		return fmt.Errorf("创建创作运行时结构：%w", err)
	}
	return nil
}

func MigrateSchema(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if tx.Dialector.Name() == "postgres" {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", postgresSchemaMigrationLockID).Error; err != nil {
				return fmt.Errorf("获取数据库迁移锁：%w", err)
			}
		}
		if err := tx.AutoMigrate(&schemaMigration{}); err != nil {
			return fmt.Errorf("初始化数据库迁移记录：%w", err)
		}
		plan, err := migrationsForDatabase(tx)
		if err != nil {
			return err
		}
		for _, item := range plan {
			var applied schemaMigration
			err := tx.First(&applied, "version = ?", item.version).Error
			if err == nil {
				if err := validateMigrationRecord(applied, item); err != nil {
					return err
				}
				continue
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("读取数据库迁移 %d：%w", item.version, err)
			}
			if err := item.apply(tx); err != nil {
				return fmt.Errorf("执行数据库迁移 %d（%s）：%w", item.version, item.name, err)
			}
			record := schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Now().UTC()}
			if err := tx.Create(&record).Error; err != nil {
				return fmt.Errorf("记录数据库迁移 %d：%w", item.version, err)
			}
		}
		return RequireSchemaVersion(tx)
	})
}

func ReadSchemaStatus(db *gorm.DB) (SchemaStatus, error) {
	status := SchemaStatus{Expected: CurrentSchemaVersion}
	if !db.Migrator().HasTable(&schemaMigration{}) {
		return status, nil
	}
	if err := db.Model(&schemaMigration{}).Select("COALESCE(MAX(version), 0)").Scan(&status.Current).Error; err != nil {
		return status, fmt.Errorf("读取数据库结构版本：%w", err)
	}
	if status.Current != status.Expected {
		return status, nil
	}
	if err := validateMigrationRecords(db); err != nil {
		return status, err
	}
	status.Ready = true
	return status, nil
}

func validateMigrationRecords(db *gorm.DB) error {
	plan, err := migrationsForDatabase(db)
	if err != nil {
		return err
	}
	for _, item := range plan {
		var applied schemaMigration
		if err := db.First(&applied, "version = ?", item.version).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("数据库缺少迁移记录 %d（%s）", item.version, item.name)
			}
			return fmt.Errorf("读取数据库迁移 %d：%w", item.version, err)
		}
		if err := validateMigrationRecord(applied, item); err != nil {
			return err
		}
	}
	return nil
}

func validateMigrationRecord(applied schemaMigration, expected migration) error {
	if applied.Name != expected.name {
		return fmt.Errorf("数据库迁移 %d 名称不一致：记录为 %s，程序期望 %s", expected.version, applied.Name, expected.name)
	}
	if applied.Checksum != expected.checksum {
		return fmt.Errorf("数据库迁移 %d 校验和不一致：记录为 %s，程序期望 %s", expected.version, applied.Checksum, expected.checksum)
	}
	return nil
}

func RequireSchemaVersion(db *gorm.DB) error {
	status, err := ReadSchemaStatus(db)
	if err != nil {
		return err
	}
	if status.Current < status.Expected {
		return fmt.Errorf("数据库结构版本过旧：当前 %d，程序要求 %d，请先执行 migrate-schema up", status.Current, status.Expected)
	}
	if status.Current > status.Expected {
		return fmt.Errorf("数据库结构版本 %d 高于程序支持的 %d，拒绝使用旧程序连接新数据库", status.Current, status.Expected)
	}
	return nil
}
