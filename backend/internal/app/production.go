package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type ProductionRunRequest struct {
	ClientKey          string                     `json:"clientKey"`
	DomainProjectID    string                     `json:"domainProjectId"`
	CanvasID           string                     `json:"canvasId"`
	CreationRunID      string                     `json:"creationRunId"`
	WorkflowInstanceID string                     `json:"workflowInstanceId"`
	Brief              map[string]any             `json:"brief"`
	DeliveryContract   ProductionDeliveryContract `json:"deliveryContract"`
	Plan               map[string]any             `json:"plan"`
	Policy             map[string]any             `json:"policy"`
	Quality            map[string]any             `json:"quality"`
	AudioMode          string                     `json:"audioMode"`
	TargetDurationMs   int64                      `json:"targetDurationMs"`
	TargetFPSNumerator int                        `json:"targetFpsNumerator"`
	TargetFPSDenom     int                        `json:"targetFpsDenominator"`
	BudgetLimit        int64                      `json:"budgetLimit"`
	Steps              []ProductionStepInput      `json:"steps"`
}

type ProductionStepInput struct {
	StepKey             string   `json:"stepKey"`
	Kind                string   `json:"kind"`
	SceneID             string   `json:"sceneId"`
	ShotID              string   `json:"shotId"`
	StoryboardRowID     string   `json:"storyboardRowId"`
	SegmentID           string   `json:"segmentId"`
	SegmentOrder        int      `json:"segmentOrder"`
	TrackID             string   `json:"trackId"`
	DependsOn           []string `json:"dependsOn"`
	InputFingerprint    string   `json:"inputFingerprint"`
	SelectedStrategyID  string   `json:"selectedStrategyId"`
	EstimatedCostMicros int64    `json:"estimatedCostMicros"`
}

type ProductionPlanRequest struct {
	ExpectedRevision int64                 `json:"expectedRevision"`
	Plan             map[string]any        `json:"plan"`
	Steps            []ProductionStepInput `json:"steps"`
}

type ProductionAuthorizeRequest struct {
	ExpectedRevision int64          `json:"expectedRevision"`
	Policy           map[string]any `json:"policy"`
}

type ProductionActionRequest struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	Action           string `json:"action"`
	Reason           string `json:"reason"`
}

type ProductionRenderSubmitRequest struct {
	ExpectedRevision int64                       `json:"expectedRevision"`
	StepID           string                      `json:"stepId"`
	IdempotencyKey   string                      `json:"idempotencyKey"`
	RetryOf          string                      `json:"retryOf"`
	Timeline         TimelineRenderCreateRequest `json:"timeline"`
}
type ProductionCompleteRequest struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	ResourceID       string `json:"resourceId"`
}
type ProductionSubmitRequest struct {
	ExpectedRevision   int64             `json:"expectedRevision"`
	StepID             string            `json:"stepId"`
	IdempotencyKey     string            `json:"idempotencyKey"`
	CapabilityRevision string            `json:"capabilityRevision"`
	Task               CreateTaskRequest `json:"task"`
	// EstimatedCostMicros 是本次付费步骤的预估上限；付费步骤必须有正数预估或显式无上限授权。
	EstimatedCostMicros int64 `json:"estimatedCostMicros"`
	// RetryOf 指向被重做的旧 attempt，用于区分“传输重试”与“新的生成尝试”。
	RetryOf string `json:"retryOf"`
}

type ProductionStepOutput struct {
	model.ProductionStep
	DependsOn         []string `json:"dependsOn"`
	OutputArtifactIDs []string `json:"outputArtifactIds"`
}

type ProductionRunOutput struct {
	model.ProductionRun
	Brief            map[string]any             `json:"brief"`
	DeliveryContract ProductionDeliveryContract `json:"deliveryContract"`
	Plan             map[string]any             `json:"plan"`
	Policy           map[string]any             `json:"policy"`
	Quality          map[string]any             `json:"quality"`
	Steps            []ProductionStepOutput     `json:"steps"`
	Attempts         []model.ProductionAttempt  `json:"attempts"`
	Events           []model.ProductionRunEvent `json:"events,omitempty"`
}

func (s *Service) CreateProductionRun(userID string, req ProductionRunRequest) (*ProductionRunOutput, error) {
	req.ClientKey = strings.TrimSpace(req.ClientKey)
	if userID == "" || req.ClientKey == "" || len(req.ClientKey) > 120 {
		return nil, BadAuthRequest("缺少稳定的制作会话键")
	}
	if req.DomainProjectID != "" {
		if _, err := s.repo.ProjectForUser(userID, strings.TrimSpace(req.DomainProjectID)); err != nil {
			return nil, creationError(err)
		}
		if req.CanvasID != "" {
			project, err := s.repo.ProjectForCanvas(userID, strings.TrimSpace(req.CanvasID))
			if err != nil || project.ID != strings.TrimSpace(req.DomainProjectID) {
				return nil, BadAuthRequest("画布未关联到指定项目")
			}
		}
	}
	brief := normalizedMap(req.Brief)
	audioMode, err := normalizeProductionAudioMode(req.AudioMode)
	if err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	if err := normalizeProductionPlanAudioMode(req.Plan, audioMode); err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	deliveryContract, err := normalizeProductionDeliveryContract(req.DeliveryContract, brief, req.TargetDurationMs)
	if err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	req.TargetDurationMs = deliveryContract.TargetDurationMs
	plan := normalizedMap(req.Plan)
	policy := normalizedMap(req.Policy)
	quality := normalizedMap(req.Quality)
	policy["authorizationStatus"] = "planning"
	delete(policy, "authorizedAt")
	hash := productionJSONHash([]any{req.CanvasID, req.DomainProjectID, req.CreationRunID, req.WorkflowInstanceID, brief, deliveryContract, plan, policy, quality, audioMode, req.TargetDurationMs, req.BudgetLimit, req.Steps})
	if old, err := s.repo.ProductionRunByClientKey(userID, req.ClientKey); err == nil {
		if old.CreateHash != hash {
			return nil, productionConflict("同一制作键对应了不同内容")
		}
		return s.GetProductionRun(userID, old.ID, 0)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if req.TargetFPSNumerator == 0 {
		req.TargetFPSNumerator = 30
	}
	if req.TargetFPSDenom == 0 {
		req.TargetFPSDenom = 1
	}
	if req.TargetFPSNumerator <= 0 || req.TargetFPSDenom <= 0 {
		return nil, BadAuthRequest("目标帧率无效")
	}
	if err := validateProductionWorkflowPlan(plan, req.Steps, req.TargetDurationMs, req.TargetFPSNumerator, req.TargetFPSDenom); err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	run := &model.ProductionRun{
		ID: newID(), UserID: userID, ClientKey: req.ClientKey, CreateHash: hash,
		DomainProjectID: req.DomainProjectID, CanvasID: req.CanvasID,
		CreationRunID: req.CreationRunID, WorkflowInstanceID: req.WorkflowInstanceID,
		Status: "planning", CurrentStage: "planning", Revision: 1,
		BriefJSON: mapJSON(brief), DeliveryContractJSON: mapJSON(deliveryContract), PlanJSON: mapJSON(plan), PolicyJSON: mapJSON(policy), QualityJSON: mapJSON(quality),
		AudioMode:        audioMode,
		TargetDurationMs: req.TargetDurationMs, TargetFPSNumerator: req.TargetFPSNumerator, TargetFPSDenom: req.TargetFPSDenom,
		BudgetLimit: req.BudgetLimit,
	}
	if err := s.repo.CreateProductionRun(run); err != nil {
		return nil, productionError(err)
	}
	if len(req.Steps) > 0 {
		if _, err := s.replaceProductionSteps(userID, run.ID, run.Revision, req.Steps); err != nil {
			return nil, err
		}
	}
	return s.GetProductionRun(userID, run.ID, 0)
}

func (s *Service) GetProductionRun(userID, id string, afterSequence int64) (*ProductionRunOutput, error) {
	run, err := s.repo.ProductionRunForUser(userID, id)
	if err != nil {
		return nil, productionError(err)
	}
	steps, err := s.repo.ProductionSteps(id)
	if err != nil {
		return nil, err
	}
	attempts, err := s.repo.ProductionAttempts(id, "")
	if err != nil {
		return nil, err
	}
	events, err := s.repo.ProductionEventsAfter(id, afterSequence, 500)
	if err != nil {
		return nil, err
	}
	out := &ProductionRunOutput{
		ProductionRun: *run,
		Brief:         decodeMap(run.BriefJSON), DeliveryContract: productionDeliveryContractForRun(*run), Plan: decodeMap(run.PlanJSON), Policy: decodeMap(run.PolicyJSON), Quality: decodeMap(run.QualityJSON),
		Steps: []ProductionStepOutput{}, Attempts: attempts, Events: events,
	}
	for _, step := range steps {
		out.Steps = append(out.Steps, productionStepOutput(step))
	}
	return out, nil
}

func (s *Service) ListProductionRuns(userID string) (map[string]any, error) {
	items, err := s.repo.ProductionRunsForUser(userID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"runs": items}, nil
}

func (s *Service) UpdateProductionPlan(userID, id string, req ProductionPlanRequest) (*ProductionRunOutput, error) {
	var result *ProductionRunOutput
	updateSummary := productionPlanUpdateSummary{}
	err := s.repo.MutateProductionRun(userID, id, func(run *model.ProductionRun, repo *repository.Repository) error {
		if run.Revision != req.ExpectedRevision {
			return repository.ErrProductionConflict
		}
		if run.Status == "completed" || run.Status == "cancelled" {
			return productionConflict("已结束的制作不能修改计划")
		}
		currentPlan := decodeMap(run.PlanJSON)
		candidatePlan := currentPlan
		if req.Plan != nil {
			candidatePlan = normalizedMap(req.Plan)
		}
		currentSpecVersion, currentManifestVersion := productionWorkflowVersion(currentPlan)
		candidateSpecVersion, candidateManifestVersion := productionWorkflowVersion(candidatePlan)
		if currentSpecVersion == 2 || currentManifestVersion == 2 || candidateSpecVersion == 2 || candidateManifestVersion == 2 {
			if currentSpecVersion == 2 && (candidateSpecVersion != 2 || candidateManifestVersion != 2) {
				return BadAuthRequest("workflowVersion 2 制作计划不能通过更新移除正式阶段门")
			}
			if req.Plan != nil && len(req.Steps) == 0 {
				return BadAuthRequest("更新 workflowVersion 2 ProductionSpec 时必须同时提交完整阶段步骤")
			}
			steps := req.Steps
			if len(steps) == 0 {
				existing, err := repo.ProductionSteps(run.ID)
				if err != nil {
					return err
				}
				steps = productionStepInputs(existing)
			}
			if err := validateProductionWorkflowPlan(candidatePlan, steps, run.TargetDurationMs, run.TargetFPSNumerator, run.TargetFPSDenom); err != nil {
				return BadAuthRequest(err.Error())
			}
		}
		if req.Plan != nil {
			if err := normalizeProductionPlanAudioMode(req.Plan, run.AudioMode); err != nil {
				return BadAuthRequest(err.Error())
			}
			run.PlanJSON = mapJSON(req.Plan)
		}
		policy := decodeMap(run.PolicyJSON)
		policy["authorizationStatus"] = "planning"
		delete(policy, "authorizedAt")
		run.PolicyJSON = mapJSON(policy)
		run.Status = "planning"
		if len(req.Steps) > 0 {
			var err error
			updateSummary, err = replaceProductionStepsRepository(repo, run, req.Steps)
			if err != nil {
				return err
			}
		}
		run.Revision++
		run.CurrentStage = "planning"
		return repo.AppendProductionEvent(run, "plan_updated", run.ID, run.Revision, mapJSON(updateSummary))
	})
	if err != nil {
		return nil, productionError(err)
	}
	result, err = s.GetProductionRun(userID, id, 0)
	return result, err
}

func (s *Service) AuthorizeProductionRun(userID, id string, req ProductionAuthorizeRequest) (*ProductionRunOutput, error) {
	if req.Policy == nil {
		return nil, BadAuthRequest("缺少制作授权内容")
	}
	err := s.repo.MutateProductionRun(userID, id, func(run *model.ProductionRun, repo *repository.Repository) error {
		if run.Revision != req.ExpectedRevision {
			return repository.ErrProductionConflict
		}
		policy := normalizedMap(req.Policy)
		policy["authorizationStatus"] = "authorized"
		policy["authorizedAt"] = time.Now().UTC().Format(time.RFC3339)
		run.PolicyJSON = mapJSON(policy)
		run.Status = "running"
		run.CurrentStage = "ready"
		run.Revision++
		return repo.AppendProductionEvent(run, "authorized", run.ID, run.Revision, mapJSON(map[string]any{"authorizationStatus": "authorized"}))
	})
	if err != nil {
		return nil, productionError(err)
	}
	return s.GetProductionRun(userID, id, 0)
}

func (s *Service) ChangeProductionRunStatus(userID, id string, req ProductionActionRequest) (*ProductionRunOutput, error) {
	action := strings.ToLower(strings.TrimSpace(req.Action))
	if action != "pause" && action != "resume" && action != "cancel" {
		return nil, BadAuthRequest("未知制作操作")
	}
	err := s.repo.MutateProductionRun(userID, id, func(run *model.ProductionRun, repo *repository.Repository) error {
		if run.Revision != req.ExpectedRevision {
			return repository.ErrProductionConflict
		}
		switch action {
		case "pause":
			if run.Status == "completed" || run.Status == "cancelled" {
				return productionConflict("已结束的制作不能暂停")
			}
			run.Status = "paused"
			run.CurrentStage = "paused"
		case "resume":
			if run.Status != "paused" && run.Status != "needs_input" && run.Status != "waiting_agent" {
				return productionConflict("当前状态不能恢复")
			}
			if policyAuthorized(run.PolicyJSON) {
				run.Status = "running"
			} else {
				run.Status = "planning"
			}
			run.CurrentStage = "resume"
		case "cancel":
			run.Status = "cancelled"
			run.CurrentStage = "cancelled"
		}
		run.Revision++
		return repo.AppendProductionEvent(run, "status_"+action, run.ID, run.Revision, mapJSON(map[string]any{"reason": strings.TrimSpace(req.Reason)}))
	})
	if err != nil {
		return nil, productionError(err)
	}
	return s.GetProductionRun(userID, id, 0)
}

func (s *Service) SubmitProductionStep(userID, id string, req ProductionSubmitRequest) (map[string]any, error) {
	req.IdempotencyKey = strings.TrimSpace(req.IdempotencyKey)
	if req.StepID == "" || req.IdempotencyKey == "" || len(req.IdempotencyKey) > 120 {
		return nil, BadAuthRequest("缺少步骤或稳定幂等键")
	}
	run, err := s.repo.ProductionRunForUser(userID, id)
	if err != nil {
		return nil, productionError(err)
	}
	requestHash := productionJSONHash([]any{req.StepID, req.Task, req.CapabilityRevision, req.EstimatedCostMicros, strings.TrimSpace(req.RetryOf)})
	if existing, lookupErr := s.repo.ProductionAttemptByIdempotencyKey(id, req.IdempotencyKey); lookupErr == nil {
		if existing.RequestHash != requestHash {
			return nil, productionConflict("同一幂等键对应了不同请求")
		}
		if existing.GenerationTaskID != "" {
			task, taskErr := s.repo.TaskForUser(userID, existing.GenerationTaskID)
			if taskErr != nil {
				return nil, taskErr
			}
			return map[string]any{"attempt": existing, "task": taskForOutput(*task), "idempotent": true}, nil
		}
		return map[string]any{"attempt": existing, "idempotent": true, "status": existing.State, "nextActionHint": "先查询或对账该 attempt，不要直接重发付费请求"}, nil
	} else if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
		return nil, lookupErr
	}
	if run.Status == "paused" || run.Status == "cancelled" || run.Status == "completed" || run.Status == "planning" {
		return nil, productionConflict("制作尚未授权或当前不允许提交新步骤")
	}
	if !policyAuthorized(run.PolicyJSON) {
		return nil, productionConflict("制作策略尚未由用户授权")
	}
	if !s.ProductionFeatures().AutoProduction {
		return nil, productionConflict("自动制作已关闭（CANVAS_PRODUCTION_AUTO=0）：请启用后再提交付费步骤")
	}
	if req.EstimatedCostMicros < 0 {
		return nil, BadAuthRequest("费用预估不能为负数")
	}
	plannedStep, err := s.repo.ProductionStep(id, req.StepID)
	if err != nil {
		return nil, productionError(err)
	}
	if plannedStep.Kind == "reuse_media" {
		return nil, productionConflict("reuse_media 步骤不得提交生成任务；请通过 steps/result 写入 resourceId，由服务器探测后绑定")
	}
	if err := s.prepareProductionAudioTask(userID, run, plannedStep, &req); err != nil {
		return nil, err
	}

	taskRequest := req.Task
	taskRequest.creationPrepare = &creationTaskPreparation{}
	task, _, err := s.prepareCreationTask(userID, taskRequest)
	if err != nil {
		return nil, err
	}
	if err := validateProductionCapabilityRevision(req.CapabilityRevision, task.CapabilityRevision); err != nil {
		return nil, err
	}
	if err := validatePreparedProductionAudioTask(run, plannedStep, task); err != nil {
		return nil, err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	attempt := model.ProductionAttempt{
		ID: newID(), RunID: id, StepID: req.StepID, AttemptNumber: 1,
		IdempotencyKey: req.IdempotencyKey, RequestHash: requestHash, CapabilityRevision: task.CapabilityRevision,
		State: "submitting",
	}
	idempotent := false
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		lockedRun, e := repo.LockProductionRun(userID, id)
		if e != nil {
			return e
		}
		if lockedRun.Revision != req.ExpectedRevision {
			return repository.ErrProductionConflict
		}
		step, e := repo.ProductionStep(id, req.StepID)
		if e != nil {
			return e
		}
		if e := validateProductionStepAttempt(repo, step, req.RetryOf); e != nil {
			return e
		}
		if req.EstimatedCostMicros < step.EstimatedCostMicros {
			return productionConflict("本次费用预估低于计划锁定的成本估算；请更新计划并重新授权")
		}
		bindProductionTaskTrace(task, id, step, &attempt)
		if e := ensureProductionDependenciesReady(repo, id, step); e != nil {
			return e
		}
		if existing, e := repo.ProductionAttemptByIdempotencyKey(id, req.IdempotencyKey); e == nil {
			if existing.RequestHash != requestHash {
				return repository.ErrProductionConflict
			}
			attempt = *existing
			idempotent = true
			if existing.GenerationTaskID != "" {
				task, e = repo.TaskForUser(userID, existing.GenerationTaskID)
			}
			return e
		} else if !errors.Is(e, gorm.ErrRecordNotFound) {
			return e
		}
		attempt.AttemptNumber = step.AttemptCount + 1
		if e := reserveProductionBudget(lockedRun, step, req.EstimatedCostMicros); e != nil {
			return e
		}
		if e := ensureProductionParallelism(repo, lockedRun, step); e != nil {
			return e
		}
		attempt.RetryOf = strings.TrimSpace(req.RetryOf)
		if productionStepRequiresBudget(step.Kind) && req.EstimatedCostMicros > 0 {
			attempt.ReservedCostMicros = req.EstimatedCostMicros
			attempt.CostReservationID = "resv-" + attempt.ID
		}
		if e := createTaskWithStorageQuotaRepository(repo, task, policy); e != nil {
			return e
		}
		attempt.GenerationTaskID = task.ID
		attempt.State = "running"
		if e := repo.CreateProductionAttempt(&attempt); e != nil {
			return e
		}
		step.AttemptCount = attempt.AttemptNumber
		step.Status = "running"
		step.Revision++
		if e := repo.SaveProductionStep(step); e != nil {
			return e
		}
		lockedRun.Revision++
		lockedRun.CurrentStage = step.Kind
		if e := repo.AppendProductionEvent(lockedRun, "step_submitted", step.ID, step.Revision, mapJSON(map[string]any{"attemptId": attempt.ID, "taskId": task.ID, "idempotencyKey": req.IdempotencyKey})); e != nil {
			return e
		}
		return repo.SaveProductionRun(lockedRun)
	})
	if err != nil {
		return nil, productionError(err)
	}
	return map[string]any{"runRevision": req.ExpectedRevision + 1, "stepId": req.StepID, "attempt": attempt, "task": taskForOutput(*task), "idempotent": idempotent}, nil
}

func validateProductionStepAttempt(repo *repository.Repository, step *model.ProductionStep, retryOf string) error {
	if step.Status != "pending" && step.Status != "ready" && step.Status != "failed" {
		return productionConflict("步骤当前状态不允许创建新付费 attempt；先查询原 attempt/task")
	}
	retryOf = strings.TrimSpace(retryOf)
	if step.AttemptCount == 0 && retryOf == "" {
		return nil
	}
	if step.AttemptCount > 0 && retryOf == "" {
		return productionConflict("该步骤已有历史 attempt；新生成必须用 retryOf 关联最近一次已结清 attempt")
	}
	prior, err := repo.ProductionAttemptByID(step.RunID, retryOf)
	if err != nil {
		return productionConflict("retryOf 必须指向当前制作运行中的真实历史 attempt")
	}
	if prior.StepID != step.ID || prior.AttemptNumber != step.AttemptCount {
		return productionConflict("retryOf 必须指向该分镜步骤最近一次 attempt")
	}
	settledFailure := prior.State == "failed" || prior.State == "quality_failed"
	if !settledFailure && prior.State != "succeeded" {
		return productionConflict("原 attempt 尚未确认失败或成功结清；不确定/取消状态不能创建新付费请求")
	}
	if step.Status == "failed" && !settledFailure {
		return productionConflict("失败步骤只能基于最近一次已确认失败的 attempt 重试")
	}
	return nil
}

func ensureProductionDependenciesReady(repo *repository.Repository, runID string, step *model.ProductionStep) error {
	for _, dependencyKey := range decodeStringList(step.DependsOnJSON) {
		dependency, err := repo.ProductionStepByKey(runID, dependencyKey)
		if err != nil || dependency.Status != "succeeded" {
			return productionConflict("步骤依赖尚未完成：" + dependencyKey)
		}
	}
	return nil
}

func (s *Service) CompleteProductionRun(userID, id string, req ProductionCompleteRequest) (*ProductionRunOutput, error) {
	verification, err := s.VerifyProductionDelivery(userID, id, ProductionDeliveryVerificationRequest{ExpectedRevision: req.ExpectedRevision, ResourceID: req.ResourceID})
	if err != nil {
		return nil, err
	}
	if !verification.Completed || verification.Run == nil {
		return nil, productionConflict("最终资源未通过已固化的 Brief 交付合同核验")
	}
	return verification.Run, nil
}
func (s *Service) SubmitProductionRenderStep(userID, id string, req ProductionRenderSubmitRequest) (map[string]any, error) {
	req.StepID = strings.TrimSpace(req.StepID)
	req.IdempotencyKey = strings.TrimSpace(req.IdempotencyKey)
	req.RetryOf = strings.TrimSpace(req.RetryOf)
	if req.StepID == "" || req.IdempotencyKey == "" || len(req.IdempotencyKey) > 120 {
		return nil, BadAuthRequest("缺少渲染步骤或幂等键")
	}
	run, err := s.repo.ProductionRunForUser(userID, id)
	if err != nil {
		return nil, productionError(err)
	}
	var audioHandling map[string]any
	req.Timeline.Timeline, audioHandling = applyProductionRenderAudioPolicy(*run, req.Timeline.Timeline)
	// The task and attempt IDs are server-owned. Clear them before hashing so a
	// replay has the same request identity even though it receives stored IDs.
	req.Timeline.ProductionRunID = ""
	req.Timeline.ProductionStepID = ""
	req.Timeline.ProductionAttemptID = ""
	requestHash := productionJSONHash([]any{req.StepID, req.RetryOf, req.Timeline.ProjectID, req.Timeline.Timeline, req.Timeline.Output})
	if existing, lookupErr := s.repo.ProductionAttemptByIdempotencyKey(id, req.IdempotencyKey); lookupErr == nil {
		if existing.RequestHash != requestHash {
			return nil, productionConflict("同一幂等键对应了不同渲染请求")
		}
		if existing.GenerationTaskID == "" {
			return map[string]any{"attempt": existing, "idempotent": true, "status": existing.State, "audioHandling": audioHandling, "nextActionHint": "先查询或对账该渲染 attempt，不要直接重发"}, nil
		}
		task, taskErr := s.repo.TaskForUser(userID, existing.GenerationTaskID)
		if taskErr != nil {
			return nil, taskErr
		}
		return map[string]any{"attempt": existing, "task": taskForOutput(*task), "idempotent": true, "audioHandling": audioHandling}, nil
	} else if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
		return nil, lookupErr
	}
	if !policyAuthorized(run.PolicyJSON) || run.Status == "planning" || run.Status == "paused" || run.Status == "cancelled" || run.Status == "completed" {
		return nil, productionConflict("制作尚未授权或当前不允许提交渲染")
	}
	if !s.ProductionFeatures().AutoProduction {
		return nil, productionConflict("自动制作已关闭（CANVAS_PRODUCTION_AUTO=0）：请启用后再提交渲染步骤")
	}
	if run.Revision != req.ExpectedRevision {
		return nil, productionConflict("制作版本已变化，请读取最新 revision 后提交")
	}
	if strings.TrimSpace(req.Timeline.ProjectID) == "" {
		return nil, BadAuthRequest("渲染请求缺少 projectId")
	}
	if err := validateProductionRenderOutput(*run, req.Timeline.Output); err != nil {
		return nil, err
	}
	attemptID := newID()
	req.Timeline.ProductionRunID = id
	req.Timeline.ProductionStepID = req.StepID
	req.Timeline.ProductionAttemptID = attemptID
	task, runtimePolicy, err := s.prepareTimelineRenderTask(userID, req.Timeline)
	if err != nil {
		return nil, err
	}
	task.ProductionRunID = id
	attempt := model.ProductionAttempt{ID: attemptID, RunID: id, StepID: req.StepID, IdempotencyKey: req.IdempotencyKey, RequestHash: requestHash, RetryOf: req.RetryOf, State: "running", GenerationTaskID: task.ID}
	idempotent := false
	s.storageMu.Lock()
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		lockedRun, e := repo.LockProductionRun(userID, id)
		if e != nil {
			return e
		}
		if existing, lookupErr := repo.ProductionAttemptByIdempotencyKey(id, req.IdempotencyKey); lookupErr == nil {
			if existing.RequestHash != requestHash {
				return repository.ErrProductionConflict
			}
			attempt = *existing
			idempotent = true
			if existing.GenerationTaskID != "" {
				task, e = repo.TaskForUser(userID, existing.GenerationTaskID)
			}
			return e
		} else if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
			return lookupErr
		}
		if lockedRun.Revision != req.ExpectedRevision {
			return repository.ErrProductionConflict
		}
		if !policyAuthorized(lockedRun.PolicyJSON) || lockedRun.Status == "planning" || lockedRun.Status == "paused" || lockedRun.Status == "cancelled" || lockedRun.Status == "completed" {
			return productionConflict("制作尚未授权或当前不允许提交渲染")
		}
		step, e := repo.ProductionStep(id, req.StepID)
		if e != nil {
			return e
		}
		if step.Kind != "render" || step.Superseded {
			return productionConflict("渲染请求必须绑定当前有效的 render ProductionStep")
		}
		if e := validateProductionStepAttempt(repo, step, req.RetryOf); e != nil {
			return e
		}
		if e := ensureProductionDependenciesReady(repo, id, step); e != nil {
			return e
		}
		steps, e := repo.ProductionSteps(id)
		if e != nil {
			return e
		}
		attempts, e := repo.ProductionAttempts(id, "")
		if e != nil {
			return e
		}
		taskLookup := func(taskID string) (*model.Task, error) { return repo.TaskForUser(userID, taskID) }
		resourceLookup := func(resourceID string) (*model.Resource, error) { return repo.ResourceForUser(userID, resourceID) }
		manifestAudit := inspectProductionManifest(lockedRun.PlanJSON, productionDeliveryContractForRun(*lockedRun), steps, attempts, lockedRun.QualityJSON)
		manifestIssues := productionRenderManifestIssues(manifestAudit.Issues, steps)
		if len(manifestIssues) > 0 {
			return productionConflict("ProductionPlan 尚未形成可渲染的完整分镜/模型/技能/质检清单：" + strings.Join(manifestIssues, ","))
		}
		if taskIssues := productionManifestTaskIssues(id, userID, manifestAudit, taskLookup); len(taskIssues) > 0 {
			return productionConflict("ProductionPlan 绑定的生成任务证据不完整：" + strings.Join(taskIssues, ","))
		}
		if e := validateProductionRenderTimeline(*lockedRun, steps, attempts, req.Timeline.Timeline, taskLookup, resourceLookup, func(resourceID string) (*ResourceProbeResult, error) {
			return s.ProbeResource(userID, resourceID, true)
		}); e != nil {
			return e
		}
		attempt.AttemptNumber = step.AttemptCount + 1
		attempt.RetryOf = req.RetryOf
		if e := ensureProductionParallelism(repo, lockedRun, step); e != nil {
			return e
		}
		task.ProductionStepID = step.ID
		task.ProductionAttemptID = attempt.ID
		e = createTaskWithStorageQuotaRepository(repo, task, runtimePolicy)
		if e != nil {
			if errors.Is(e, repository.ErrActiveTaskLimit) {
				return BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", runtimePolicy.Task.ActiveTaskLimit))
			}
			return e
		}
		if e := repo.CreateProductionAttempt(&attempt); e != nil {
			return e
		}
		step.AttemptCount = attempt.AttemptNumber
		step.Status = "running"
		step.Revision++
		if e := repo.SaveProductionStep(step); e != nil {
			return e
		}
		lockedRun.Revision++
		lockedRun.CurrentStage = "rendering"
		if e := repo.AppendProductionEvent(lockedRun, "render_submitted", step.ID, step.Revision, mapJSON(map[string]any{"attemptId": attempt.ID, "taskId": task.ID, "audioHandling": audioHandling})); e != nil {
			return e
		}
		return repo.SaveProductionRun(lockedRun)
	})
	s.storageMu.Unlock()
	if err != nil {
		return nil, productionError(err)
	}
	if idempotent {
		if task == nil || attempt.GenerationTaskID == "" {
			return map[string]any{"attempt": attempt, "idempotent": true, "status": attempt.State, "audioHandling": audioHandling, "nextActionHint": "先查询或对账该渲染 attempt，不要直接重发"}, nil
		}
		return map[string]any{"attempt": attempt, "task": taskForOutput(*task), "idempotent": true, "audioHandling": audioHandling}, nil
	}
	s.recordActivity(userID, "task", 1)
	_ = s.log(userID, task.ID, "info", "制作主时间线渲染任务已进入队列", "")
	return map[string]any{"runRevision": req.ExpectedRevision + 1, "stepId": req.StepID, "attempt": attempt, "task": taskForOutput(*task), "audioHandling": audioHandling, "idempotent": false}, nil
}
func (s *Service) GetProductionTasks(userID, runID string) (map[string]any, error) {
	if _, err := s.repo.ProductionRunForUser(userID, runID); err != nil {
		return nil, productionError(err)
	}
	attempts, err := s.repo.ProductionAttempts(runID, "")
	if err != nil {
		return nil, err
	}
	tasks := make([]model.Task, 0, len(attempts))
	for _, attempt := range attempts {
		if attempt.GenerationTaskID == "" {
			continue
		}
		task, err := s.repo.TaskForUser(userID, attempt.GenerationTaskID)
		if err == nil {
			tasks = append(tasks, *task)
		}
	}
	return map[string]any{"attempts": attempts, "tasks": taskOutputs(tasks)}, nil
}

func (s *Service) replaceProductionSteps(userID, runID string, expectedRevision int64, steps []ProductionStepInput) (*ProductionRunOutput, error) {
	if _, err := s.UpdateProductionPlan(userID, runID, ProductionPlanRequest{ExpectedRevision: expectedRevision, Steps: steps}); err != nil {
		return nil, err
	}
	return s.GetProductionRun(userID, runID, 0)
}

type productionPlanUpdateSummary struct {
	InvalidatedStepKeys       []string `json:"invalidatedStepKeys"`
	SupersededStepKeys        []string `json:"supersededStepKeys"`
	EstimatedReworkCostMicros int64    `json:"estimatedReworkCostMicros"`
}

func replaceProductionStepsRepository(repo *repository.Repository, run *model.ProductionRun, steps []ProductionStepInput) (productionPlanUpdateSummary, error) {
	var summary productionPlanUpdateSummary
	if err := validateProductionSteps(steps); err != nil {
		return summary, err
	}
	existingSteps, err := repo.ProductionSteps(run.ID)
	if err != nil {
		return summary, err
	}
	existingByKey := make(map[string]*model.ProductionStep, len(existingSteps))
	for index := range existingSteps {
		existingByKey[existingSteps[index].StepKey] = &existingSteps[index]
	}
	newByKey := make(map[string]ProductionStepInput, len(steps))
	for index := range steps {
		steps[index].StepKey = strings.TrimSpace(steps[index].StepKey)
	}
	for _, input := range steps {
		newByKey[strings.TrimSpace(input.StepKey)] = input
	}
	changed := map[string]bool{}
	for key, existing := range existingByKey {
		input, exists := newByKey[key]
		if !exists || existing.Superseded || productionStepDefinitionChanged(existing, input) {
			changed[key] = true
		}
	}
	// A changed upstream invalidates every downstream output that consumed it.
	for changedAny := true; changedAny; {
		changedAny = false
		for key := range newByKey {
			if changed[key] {
				continue
			}
			input := newByKey[key]
			for _, dependencyKey := range input.DependsOn {
				if changed[dependencyKey] {
					changed[key] = true
					changedAny = true
					break
				}
			}
		}
	}
	for key := range changed {
		if existing := existingByKey[key]; existing != nil && (existing.Status == "running" || existing.Status == "submitting" || existing.Status == "uncertain") {
			return summary, productionConflict("步骤 " + key + " 仍有未结清任务，先查询原 attempt 后才能改计划")
		}
	}
	for i := range steps {
		input := steps[i]
		existing, err := repo.ProductionStepByKey(run.ID, input.StepKey)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			step := model.ProductionStep{
				ID: newID(), RunID: run.ID, StepKey: input.StepKey, Kind: input.Kind,
				SceneID: input.SceneID, ShotID: input.ShotID, StoryboardRowID: input.StoryboardRowID,
				SegmentID: input.SegmentID, SegmentOrder: input.SegmentOrder, TrackID: input.TrackID, DependsOnJSON: mapJSON(input.DependsOn),
				InputFingerprint: input.InputFingerprint, Status: "pending", SelectedStrategyID: input.SelectedStrategyID,
				OutputArtifactJSON: "[]", EstimatedCostMicros: input.EstimatedCostMicros, Revision: 1,
			}
			if err := repo.CreateProductionStep(&step); err != nil {
				return summary, err
			}
			continue
		}
		if err != nil {
			return summary, err
		}
		if changed[input.StepKey] {
			if existing.AttemptCount > 0 && productionStepRequiresBudget(input.Kind) {
				summary.EstimatedReworkCostMicros += input.EstimatedCostMicros
			}
			summary.InvalidatedStepKeys = append(summary.InvalidatedStepKeys, input.StepKey)
			existing.Status = "pending"
			existing.BlockingReason = ""
			existing.OutputArtifactJSON = "[]"
			existing.LeaseOwner = ""
			existing.LeaseExpiresAt = nil
			existing.NextRunAt = nil
		}
		existing.Kind = input.Kind
		existing.SceneID = input.SceneID
		existing.ShotID = input.ShotID
		existing.StoryboardRowID = input.StoryboardRowID
		existing.SegmentID = input.SegmentID
		existing.SegmentOrder = input.SegmentOrder
		existing.TrackID = input.TrackID
		existing.DependsOnJSON = mapJSON(input.DependsOn)
		existing.InputFingerprint = input.InputFingerprint
		existing.SelectedStrategyID = input.SelectedStrategyID
		existing.EstimatedCostMicros = input.EstimatedCostMicros
		existing.Superseded = false
		existing.Revision++
		if err := repo.SaveProductionStep(existing); err != nil {
			return summary, err
		}
	}
	for key, existing := range existingByKey {
		if _, stillPresent := newByKey[key]; stillPresent || existing.Superseded {
			continue
		}
		existing.Status = "superseded"
		existing.Superseded = true
		existing.BlockingReason = "已从当前制作计划移除；历史 attempt 和产物保留"
		existing.LeaseOwner = ""
		existing.LeaseExpiresAt = nil
		existing.Revision++
		if err := repo.SaveProductionStep(existing); err != nil {
			return summary, err
		}
		summary.SupersededStepKeys = append(summary.SupersededStepKeys, key)
	}
	sort.Strings(summary.InvalidatedStepKeys)
	sort.Strings(summary.SupersededStepKeys)
	return summary, nil
}

func productionStepDefinitionChanged(existing *model.ProductionStep, input ProductionStepInput) bool {
	return existing.Kind != input.Kind || existing.SceneID != input.SceneID || existing.ShotID != input.ShotID ||
		existing.StoryboardRowID != input.StoryboardRowID || existing.SegmentID != input.SegmentID || existing.SegmentOrder != input.SegmentOrder || existing.TrackID != input.TrackID ||
		existing.DependsOnJSON != mapJSON(input.DependsOn) || existing.InputFingerprint != input.InputFingerprint ||
		existing.SelectedStrategyID != input.SelectedStrategyID
}

func validateProductionSteps(steps []ProductionStepInput) error {
	keys := map[string]bool{}
	type segmentPosition struct {
		rowID string
		order int
	}
	segments := map[string]segmentPosition{}
	positions := map[string]string{}
	tracks := map[string]bool{}
	for _, step := range steps {
		step.StepKey = strings.TrimSpace(step.StepKey)
		if step.StepKey == "" || len(step.StepKey) > 120 || step.Kind == "" {
			return BadAuthRequest("每个制作步骤必须有 stepKey 和 kind")
		}
		if step.EstimatedCostMicros < 0 {
			return BadAuthRequest("制作步骤费用预估不能为负数：" + step.StepKey)
		}
		if keys[step.StepKey] {
			return BadAuthRequest("制作步骤 stepKey 重复：" + step.StepKey)
		}
		keys[step.StepKey] = true
		rowID := strings.TrimSpace(step.StoryboardRowID)
		trackID := strings.TrimSpace(step.TrackID)
		if strings.EqualFold(strings.TrimSpace(step.Kind), "audio") {
			if rowID == "" || trackID == "" || len(trackID) > 120 {
				return BadAuthRequest("分镜音频步骤必须绑定稳定 storyboardRowId 和 trackId：" + step.StepKey)
			}
			trackKey := rowID + "\x00" + trackID
			if tracks[trackKey] {
				return BadAuthRequest("同一分镜行的 audio trackId 不能重复：" + trackID)
			}
			tracks[trackKey] = true
		} else if trackID != "" {
			return BadAuthRequest("只有音频制作步骤可以绑定 trackId：" + step.StepKey)
		}
		segmentID := strings.TrimSpace(step.SegmentID)
		if step.SegmentOrder < 0 {
			return BadAuthRequest("片段顺序不能为负数：" + step.StepKey)
		}
		if segmentID != "" {
			if rowID == "" {
				return BadAuthRequest("片段必须绑定稳定的分镜行 ID：" + step.StepKey)
			}
			if position, exists := segments[segmentID]; exists && (position.rowID != rowID || position.order != step.SegmentOrder) {
				return BadAuthRequest("同一片段不能绑定到不同分镜行或顺序：" + segmentID)
			}
			segments[segmentID] = segmentPosition{rowID: rowID, order: step.SegmentOrder}
			positionKey := rowID + "\x00" + strconv.Itoa(step.SegmentOrder)
			if previous, exists := positions[positionKey]; exists && previous != segmentID {
				return BadAuthRequest("同一分镜行的片段顺序重复：" + rowID)
			}
			positions[positionKey] = segmentID
		}
	}
	for _, step := range steps {
		for _, dependency := range step.DependsOn {
			if !keys[dependency] {
				return BadAuthRequest("步骤依赖不存在：" + step.StepKey + " -> " + dependency)
			}
			if dependency == step.StepKey {
				return BadAuthRequest("步骤不能依赖自身：" + step.StepKey)
			}
		}
	}
	dependencies := make(map[string][]string, len(steps))
	for _, step := range steps {
		dependencies[step.StepKey] = append([]string{}, step.DependsOn...)
	}
	// 依赖图必须无环：环会让步骤永远无法就绪，也会让恢复逻辑无法判定先后。
	visiting := map[string]bool{}
	visited := map[string]bool{}
	var visit func(string) error
	visit = func(key string) error {
		if visiting[key] {
			return BadAuthRequest("制作步骤依赖存在环：" + key)
		}
		if visited[key] {
			return nil
		}
		visiting[key] = true
		for _, dependency := range dependencies[key] {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		visiting[key] = false
		visited[key] = true
		return nil
	}
	for _, step := range steps {
		if err := visit(step.StepKey); err != nil {
			return err
		}
	}
	return nil
}

func productionStepOutput(step model.ProductionStep) ProductionStepOutput {
	return ProductionStepOutput{
		ProductionStep:    step,
		DependsOn:         decodeStringList(step.DependsOnJSON),
		OutputArtifactIDs: decodeStringList(step.OutputArtifactJSON),
	}
}

func bindProductionTaskTrace(task *model.Task, runID string, step *model.ProductionStep, attempt *model.ProductionAttempt) {
	if task == nil || step == nil || attempt == nil {
		return
	}
	task.ProductionRunID = runID
	task.ProductionStepID = step.ID
	task.ProductionAttemptID = attempt.ID
	task.StoryboardRowID = step.StoryboardRowID
	task.SegmentID = step.SegmentID
	task.SegmentOrder = step.SegmentOrder
	task.TrackID = step.TrackID
}

func validateProductionCapabilityRevision(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return BadAuthRequest("缺少模型能力版本；请重新读取 film_list_models 后提交")
	}
	if actual == "" {
		return productionConflict("服务端没有为当前模型提供能力版本，不能提交制作步骤")
	}
	if expected != actual {
		return productionConflict("模型能力版本已更新，请重新验证策略并规划该步骤")
	}
	return nil
}

func policyAuthorized(raw string) bool {
	policy := decodeMap(raw)
	return strings.EqualFold(strings.TrimSpace(stringValue(policy["authorizationStatus"])), "authorized")
}

const productionDefaultMaxParallelSteps = 4

// productionStepRequiresBudget 区分付费生成步骤与本地确定性步骤（渲染、检查、探测）。
func productionStepRequiresBudget(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "", "render", "timeline_render", "assemble", "merge", "check", "verify", "delivery_check", "probe":
		return false
	default:
		return true
	}
}

// reserveProductionBudget 在提交前做原子预算检查并预留金额。
// 缺少有效上限且未显式授权无上限时不提交付费步骤，绝不把未知价格当成零元。
func reserveProductionBudget(run *model.ProductionRun, step *model.ProductionStep, estimate int64) error {
	if estimate < 0 {
		return BadAuthRequest("费用预估不能为负数")
	}
	if !productionStepRequiresBudget(step.Kind) {
		return nil
	}
	if estimate <= 0 && !strings.EqualFold(strings.TrimSpace(stringValue(decodeMap(run.PolicyJSON)["budgetPolicy"])), "unbounded") {
		return productionConflict("缺少费用预估：未验证价格不能按零成本提交")
	}
	// Zero means the provider price is unknown, not free. It is accepted only
	// under an explicitly authorized unbounded policy and creates no reservation.
	if estimate == 0 {
		return nil
	}
	if estimate < step.EstimatedCostMicros {
		return productionConflict("本次费用预估低于计划锁定的成本估算；请更新计划并重新授权")
	}
	policy := decodeMap(run.PolicyJSON)
	if run.BudgetLimit <= 0 {
		if strings.EqualFold(strings.TrimSpace(stringValue(policy["budgetPolicy"])), "unbounded") {
			return nil
		}
		return productionConflict("缺少有效预算上限：付费步骤必须先授权预算")
	}
	if run.Spent+run.Reserved+estimate > run.BudgetLimit {
		return productionConflict(fmt.Sprintf("预算不足：已花费 %d，已预留 %d，本次预估 %d，上限 %d", run.Spent, run.Reserved, estimate, run.BudgetLimit))
	}
	run.Reserved += estimate
	return nil
}

// ensureProductionParallelism 限制同一制作的并发步骤与单能力并发，避免无限并行提交。
func ensureProductionParallelism(repo *repository.Repository, run *model.ProductionRun, step *model.ProductionStep) error {
	policy := decodeMap(run.PolicyJSON)
	limit := intValue(policy["maxParallelSteps"])
	if limit <= 0 {
		limit = productionDefaultMaxParallelSteps
	}
	attempts, err := repo.ProductionAttempts(run.ID, "")
	if err != nil {
		return err
	}
	kind := strings.ToLower(strings.TrimSpace(step.Kind))
	active := 0
	activeByKind := map[string]int{}
	for index := range attempts {
		if attempts[index].State != "running" && attempts[index].State != "submitting" {
			continue
		}
		active++
		if owner, stepErr := repo.ProductionStep(run.ID, attempts[index].StepID); stepErr == nil {
			activeByKind[strings.ToLower(strings.TrimSpace(owner.Kind))]++
		}
	}
	if active >= limit {
		return productionConflict("该制作已达到并发步骤上限（" + strconv.Itoa(limit) + "）")
	}
	if rawLimits, ok := policy["maxParallelByCapability"].(map[string]any); ok {
		if value := intValue(rawLimits[kind]); value > 0 && activeByKind[kind] >= value {
			return productionConflict("该能力已达到并发上限（" + kind + "）")
		}
	}
	return nil
}

func normalizedMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func mapJSON(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func decodeMap(raw string) map[string]any {
	value := map[string]any{}
	_ = json.Unmarshal([]byte(raw), &value)
	return value
}

func decodeStringList(raw string) []string {
	values := []string{}
	if strings.TrimSpace(raw) == "" {
		return values
	}
	_ = json.Unmarshal([]byte(raw), &values)
	return values
}

func productionJSONHash(value any) string {
	encoded, _ := json.Marshal(value)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func productionConflict(message string) error {
	return &AppError{Status: 409, Code: 409, Message: message}
}

func productionError(err error) error {
	if errors.Is(err, repository.ErrProductionConflict) {
		return productionConflict("制作状态已变化，请重新读取后继续")
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &AppError{Status: 404, Code: 404, Message: "制作记录不存在或无权访问"}
	}
	return creationError(err)
}

func taskOutputs(tasks []model.Task) []model.Task {
	output := make([]model.Task, 0, len(tasks))
	for i := range tasks {
		output = append(output, *taskForOutput(tasks[i]))
	}
	return output
}
