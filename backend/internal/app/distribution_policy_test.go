// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
package app

import (
	"context"
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/distribution"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func TestDistributionRejectsForeignChannelBeforePersistence(t *testing.T) {
	svc, _ := newFeatureAvailabilityTestService(t)
	actor := &model.User{ID: "release-test", Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	if _, err := svc.CreateSystemChannel(actor, ChannelRequest{Name: "other", BaseURL: "https://api.openai.com/v1"}); err == nil {
		t.Fatal("foreign channel accepted")
	}
	if _, err := svc.CreateSystemChannel(actor, ChannelRequest{Name: "Axon", BaseURL: distribution.AxonBaseURL, Models: []string{"manual-model"}}); err == nil {
		t.Fatal("manual models accepted")
	}
}

func TestDistributionDisablesFrontendAndCustomEvenWithSavedFlags(t *testing.T) {
	svc, _ := newFeatureAvailabilityTestService(t)
	actor := &model.User{ID: "release-test", Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	if _, err := svc.UpdateFeatureAvailability(actor, FeatureAvailability{CustomChannelsEnabled: true, FrontendModelsEnabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, flag := range []string{FeatureCustomChannels, FeatureFrontendModels} {
		if enabled, err := svc.FeatureEnabled(flag); err != nil || enabled {
			t.Fatalf("flag %s enabled=%v err=%v", flag, enabled, err)
		}
	}
	public, err := svc.FeatureAvailability()
	if err != nil || public.CustomChannelsEnabled || public.FrontendModelsEnabled {
		t.Fatal("public flags can enable custom providers")
	}
}

func TestDistributionRejectsCustomProviderAndManualModel(t *testing.T) {
	svc, _ := newFeatureAvailabilityTestService(t)
	if _, err := svc.resolveProviderConfig(providerConfig{BaseURL: distribution.AxonBaseURL, Model: "test", APIKey: "not-a-secret"}); err == nil {
		t.Fatal("unregistered provider accepted")
	}
	actor := &model.User{ID: "release-test", Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	if _, err := svc.SaveAdminChannelModel(actor, "axon", "", ChannelModelRequest{ModelKey: "outside-catalog"}); err == nil {
		t.Fatal("manual import accepted")
	}
	if _, err := svc.FetchChannelModelCatalog(context.Background(), actor, ChannelModelsRequest{BaseURL: "https://other.example/v1", APIKey: "not-a-secret"}); err == nil {
		t.Fatal("foreign catalog accepted")
	}
}

func TestDistributionRejectsProtocolAbsoluteEndpoint(t *testing.T) {
	_, _, err := executeProtocolBinaryRequest(context.Background(), providerConfig{BaseURL: distribution.AxonBaseURL}, protocol.RequestSpec{Method: http.MethodPost, Path: "https://other.example/v1/images/generations", ContentType: "application/json"})
	if err == nil {
		t.Fatal("absolute endpoint escaped Axon")
	}
}
