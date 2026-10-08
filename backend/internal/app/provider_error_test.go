package app

import (
	"strings"
	"testing"
)

func TestProviderFailureDetailsReadsTopLevelModerationError(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"code":    contentModerationErrorCode,
		"message": "prompt rejected",
	})
	if code != contentModerationErrorCode {
		t.Fatalf("unexpected code: %q", code)
	}
	if message != "prompt rejected" {
		t.Fatalf("unexpected message: %q", message)
	}
}

func TestProviderFailureDetailsReadsNestedError(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"error": map[string]any{"code": "invalid_request", "message": "invalid size"},
	})
	if code != "invalid_request" || message != "invalid size" {
		t.Fatalf("unexpected failure details: code=%q message=%q", code, message)
	}
}

func TestProviderFailureDetailsPrefersNestedBusinessCode(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"code": float64(400),
		"data": map[string]any{"code": contentModerationErrorCode, "message": "prompt rejected"},
	})
	if code != contentModerationErrorCode || message != "prompt rejected" {
		t.Fatalf("unexpected wrapped failure details: code=%q message=%q", code, message)
	}
}

func TestContentModerationFailureRequiresExactProviderCode(t *testing.T) {
	if !isContentModerationFailure(`{"code":"sensitive_words_detected"}`) {
		t.Fatal("expected moderation error to be detected")
	}
	if isContentModerationFailure("上游 HTTP 400") {
		t.Fatal("generic HTTP 400 must remain retryable")
	}
}

func TestProviderHTTPErrorUsesModerationCategoryForStableCode(t *testing.T) {
	err := providerHTTPError{
		StatusCode: 400,
		Body:       `{"error":{"code":"sensitive_words_detected","message":"restricted by safety guidelines, request id: secret"}}`,
	}
	message := err.Error()
	if message != "请求内容未通过模型服务安全审核，请调整后重试" {
		t.Fatalf("providerHTTPError.Error() = %q, want safe moderation category", message)
	}
	if strings.Contains(message, "secret") {
		t.Fatalf("provider response detail leaked: %q", message)
	}
}

func TestProviderPayloadBusinessFailureRecognizesStringErrorCode(t *testing.T) {
	code, message, failed := providerPayloadBusinessFailure(map[string]any{
		"code": "RequestParameterIsWrong",
		"data": nil,
		"msg":  "参数: prompt 的长度: 23142 大于最大长度 10000",
	})
	if !failed || code != "RequestParameterIsWrong" || message != "参数: prompt 的长度: 23142 大于最大长度 10000" {
		t.Fatalf("business failure = (%q, %q, %v)", code, message, failed)
	}
}

func TestProviderPayloadBusinessFailureAcceptsStringSuccessCode(t *testing.T) {
	if code, message, failed := providerPayloadBusinessFailure(map[string]any{"code": "Success", "data": map[string]any{"task_id": "task-1"}}); failed {
		t.Fatalf("success payload was marked failed: (%q, %q)", code, message)
	}
}
