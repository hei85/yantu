package model

import "time"

const (
	ProductionAudioModeNative  = "NATIVE_AUDIO"
	ProductionAudioModeRebuild = "REBUILD_AUDIO"
)

// ProductionRun 是整片制作状态的所有权根。它只保存确定性计划、授权边界和版本，
// 不替代 CreationRun、Task、WorkflowInstance 或时间线本身。
type ProductionRun struct {
	ID                   string     `json:"id" gorm:"primaryKey;size:36"`
	UserID               string     `json:"-" gorm:"size:36;index;uniqueIndex:idx_production_run_client,priority:1"`
	ClientKey            string     `json:"-" gorm:"size:120;uniqueIndex:idx_production_run_client,priority:2"`
	CreateHash           string     `json:"-" gorm:"size:64"`
	DomainProjectID      string     `json:"domainProjectId,omitempty" gorm:"size:36;index"`
	CanvasID             string     `json:"canvasId,omitempty" gorm:"size:80;index"`
	CreationRunID        string     `json:"creationRunId,omitempty" gorm:"size:36;index"`
	WorkflowInstanceID   string     `json:"workflowInstanceId,omitempty" gorm:"size:36;index"`
	Status               string     `json:"status" gorm:"size:32;index"`
	CurrentStage         string     `json:"currentStage" gorm:"size:64"`
	Revision             int64      `json:"revision"`
	BriefJSON            string     `json:"briefJson" gorm:"type:text"`
	DeliveryContractJSON string     `json:"-" gorm:"type:text"`
	PlanJSON             string     `json:"planJson" gorm:"type:text"`
	PolicyJSON           string     `json:"policyJson" gorm:"type:text"`
	QualityJSON          string     `json:"qualityJson" gorm:"type:text"`
	AudioMode            string     `json:"audioMode" gorm:"size:24;index"`
	TargetDurationMs     int64      `json:"targetDurationMs"`
	TargetFPSNumerator   int        `json:"targetFpsNumerator"`
	TargetFPSDenom       int        `json:"targetFpsDenominator"`
	BudgetLimit          int64      `json:"budgetLimit"`
	Spent                int64      `json:"spent"`
	Reserved             int64      `json:"reserved"`
	FinalResourceID      string     `json:"finalResourceId,omitempty" gorm:"size:36"`
	LastEventSequence    int64      `json:"lastEventSequence"`
	ExecutionOwner       string     `json:"-" gorm:"size:120"`
	LeaseExpiresAt       *time.Time `json:"-" gorm:"index"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt" gorm:"index"`
}

// ProductionStep 是依赖图中的一个逻辑步骤。叙事镜头可以拆成多个 attempt，
// 但同一 step 的输入指纹和输出版本必须稳定可追踪。
type ProductionStep struct {
	ID                  string     `json:"id" gorm:"primaryKey;size:36"`
	RunID               string     `json:"runId" gorm:"size:36;index;uniqueIndex:idx_production_step_key,priority:1"`
	StepKey             string     `json:"stepKey" gorm:"size:120;uniqueIndex:idx_production_step_key,priority:2"`
	Kind                string     `json:"kind" gorm:"size:48;index"`
	SceneID             string     `json:"sceneId,omitempty" gorm:"size:36;index"`
	ShotID              string     `json:"shotId,omitempty" gorm:"size:36;index"`
	StoryboardRowID     string     `json:"storyboardRowId,omitempty" gorm:"size:120;index"`
	SegmentID           string     `json:"segmentId,omitempty" gorm:"size:120;index"`
	SegmentOrder        int        `json:"segmentOrder"`
	TrackID             string     `json:"trackId,omitempty" gorm:"size:120;index"`
	DependsOnJSON       string     `json:"dependsOnJson" gorm:"type:text"`
	InputFingerprint    string     `json:"inputFingerprint" gorm:"size:64"`
	Status              string     `json:"status" gorm:"size:32;index"`
	SelectedStrategyID  string     `json:"selectedStrategyId" gorm:"size:120"`
	AttemptCount        int        `json:"attemptCount"`
	LeaseOwner          string     `json:"-" gorm:"size:120"`
	LeaseFence          int64      `json:"leaseFence"`
	LeaseExpiresAt      *time.Time `json:"-" gorm:"index"`
	NextRunAt           *time.Time `json:"nextRunAt,omitempty" gorm:"index"`
	BlockingReason      string     `json:"blockingReason" gorm:"type:text"`
	OutputArtifactJSON  string     `json:"outputArtifactIdsJson" gorm:"type:text"`
	EstimatedCostMicros int64      `json:"estimatedCostMicros"`
	Superseded          bool       `json:"superseded" gorm:"index"`
	Revision            int64      `json:"revision"`
	CreatedAt           time.Time  `json:"createdAt"`
	UpdatedAt           time.Time  `json:"updatedAt"`
}

// ProductionAttempt 是一次不可变付费副作用。相同 idempotencyKey + requestHash
// 只能对应同一 Task；新内容或显式重做必须创建新的 attempt。
type ProductionAttempt struct {
	ID                 string    `json:"id" gorm:"primaryKey;size:36"`
	RunID              string    `json:"runId" gorm:"size:36;index;uniqueIndex:idx_production_attempt_key,priority:1"`
	StepID             string    `json:"stepId" gorm:"size:36;index;uniqueIndex:idx_production_attempt_number,priority:1"`
	SubmissionID       string    `json:"creationSubmissionId,omitempty" gorm:"size:36;index"`
	AttemptNumber      int       `json:"attemptNumber" gorm:"uniqueIndex:idx_production_attempt_number,priority:2"`
	IdempotencyKey     string    `json:"idempotencyKey" gorm:"size:120;uniqueIndex:idx_production_attempt_key,priority:2"`
	RequestHash        string    `json:"requestHash" gorm:"size:64"`
	RetryOf            string    `json:"retryOf,omitempty" gorm:"size:36"`
	CapabilityRevision string    `json:"capabilityRevision" gorm:"size:120"`
	ProviderTaskID     string    `json:"providerTaskId,omitempty" gorm:"index;size:160"`
	GenerationTaskID   string    `json:"generationTaskId,omitempty" gorm:"index;size:36;uniqueIndex"`
	State              string    `json:"state" gorm:"size:32;index"`
	CostReservationID  string    `json:"costReservationId,omitempty" gorm:"size:120"`
	ReservedCostMicros int64     `json:"reservedCostMicros"`
	ErrorCode          string    `json:"errorCode,omitempty" gorm:"size:120"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

// ProductionRunEvent 使用 run 内单调 sequence 支持增量恢复；不保存媒体原文或密钥。
type ProductionRunEvent struct {
	ID             string    `json:"id" gorm:"primaryKey;size:36"`
	RunID          string    `json:"runId" gorm:"size:36;index;uniqueIndex:idx_production_event_sequence,priority:1"`
	Sequence       int64     `json:"sequence" gorm:"uniqueIndex:idx_production_event_sequence,priority:2"`
	Type           string    `json:"type" gorm:"size:80;index"`
	ObjectID       string    `json:"objectId,omitempty" gorm:"size:80"`
	ObjectRevision int64     `json:"objectRevision"`
	PayloadJSON    string    `json:"payloadJson" gorm:"type:text"`
	CreatedAt      time.Time `json:"createdAt" gorm:"index"`
}
