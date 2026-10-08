package app

import "testing"

func TestAxonH3DisplayAliasesKeepRatioAndResolution(t *testing.T) {
	for _, name := range []string{"MiniMax H3-1", "MiniMax-H3", "minimax_h3_z0902"} {
		if !isHeihanAxonH3Video("https://zh.heihan.dpdns.org/v1", name) {
			t.Fatalf("display alias %q did not select the relay adapter", name)
		}
		if isHeihanAxonH3Video("https://other-relay.example/v1", name) {
			t.Fatalf("relay adapter escaped its provider scope for %q", name)
		}
		for _, resolution := range []string{"768P", "2K"} {
			body, err := axonH3VideoBody(canvasGenerationInput{
				Prompt:          "test",
				Config:          providerConfig{BaseURL: "https://zh.heihan.dpdns.org/v1", Model: name, Size: "16:9", VQuality: resolution, VideoSeconds: "5"},
				VideoCapability: &VideoCapabilityConfig{Resolutions: []string{"768P", "2K"}},
			})
			if err != nil || body["aspect_ratio"] != "16:9" || body["resolution_name"] != resolution {
				t.Fatalf("alias %q resolution %q: body=%#v err=%v", name, resolution, body, err)
			}
		}
	}
}
