package app

import "testing"

func selfCheckFixture() (map[string]any, map[string]int64, map[string]any) {
	contract := map[string]any{"requiredChecks": []any{"identity_anatomy", "space_props"}, "minSamples": 3, "requiresListening": true}
	review := func(id string) map[string]any {
		return map[string]any{
			"resourceId":  id,
			"checks":      []any{map[string]any{"name": "identity_anatomy", "status": "passed", "observation": "同一角色与服装，手部可见且无复制"}, map[string]any{"name": "space_props", "status": "passed", "observation": "门洞、桌椅和收音机与参考一致"}},
			"samples":     []any{map[string]any{"timeMs": 0, "observation": "首态"}, map[string]any{"timeMs": 500, "observation": "中间动作"}, map[string]any{"timeMs": 999, "observation": "末态"}},
			"audioReview": map[string]any{"listeningStatus": "performed", "voiceQuality": "passed", "evaluator": "audio-capable-reviewer", "summary": "实际原音轨全段核对说话人、噪声、词尾"},
		}
	}
	evidence := map[string]any{"inputFingerprint": "input-v1", "reviewedMedia": []any{review("video-a"), review("video-b")}}
	return contract, map[string]int64{"video-a": 1000, "video-b": 1000}, evidence
}

func TestProductionSelfCheckCoverage(t *testing.T) {
	cases := []struct {
		name, want string
		edit       func(map[string]any)
	}{
		{"complete", "passed", func(e map[string]any) {}},
		{"missing second segment", "uncertain", func(e map[string]any) { e["reviewedMedia"] = e["reviewedMedia"].([]any)[:1] }},
		{"ASR is not listening", "uncertain", func(e map[string]any) {
			r := e["reviewedMedia"].([]any)[0].(map[string]any)
			r["audioReview"].(map[string]any)["listeningStatus"] = "not_performed"
		}},
		{"missing observation", "uncertain", func(e map[string]any) {
			r := e["reviewedMedia"].([]any)[0].(map[string]any)
			r["checks"].([]any)[0].(map[string]any)["observation"] = ""
		}},
		{"same sample repeated", "uncertain", func(e map[string]any) {
			r := e["reviewedMedia"].([]any)[0].(map[string]any)
			r["samples"].([]any)[1].(map[string]any)["timeMs"] = 0
		}},
		{"missing ending", "uncertain", func(e map[string]any) {
			r := e["reviewedMedia"].([]any)[0].(map[string]any)
			r["samples"].([]any)[2].(map[string]any)["timeMs"] = 600
		}},
		{"failure beats missing check", "failed", func(e map[string]any) {
			r := e["reviewedMedia"].([]any)[0].(map[string]any)
			r["checks"].([]any)[0].(map[string]any)["status"] = "failed"
			r["audioReview"] = map[string]any{}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			contract, durations, e := selfCheckFixture()
			c.edit(e)
			got, err := evaluateProductionSelfCheckCoverage(contract, "input-v1", durations, e)
			if err != nil || got != c.want {
				t.Fatalf("got %s, %v; want %s", got, err, c.want)
			}
		})
	}
}
func TestProductionSelfCheckRejectsWrongBinding(t *testing.T) {
	for _, kind := range []string{"fingerprint", "resource", "duplicate", "sample_range", "sample_type", "sample_fraction"} {
		t.Run(kind, func(t *testing.T) {
			contract, durations, e := selfCheckFixture()
			r := e["reviewedMedia"].([]any)[0].(map[string]any)
			switch kind {
			case "fingerprint":
				e["inputFingerprint"] = "old-v0"
			case "resource":
				r["resourceId"] = "different-video"
			case "duplicate":
				e["reviewedMedia"] = []any{r, r}
			case "sample_range":
				r["samples"].([]any)[2].(map[string]any)["timeMs"] = 9000
			case "sample_type":
				r["samples"].([]any)[0].(map[string]any)["timeMs"] = "0"
			case "sample_fraction":
				r["samples"].([]any)[0].(map[string]any)["timeMs"] = 0.5
			}
			if _, err := evaluateProductionSelfCheckCoverage(contract, "input-v1", durations, e); err == nil {
				t.Fatal("invalid evidence accepted")
			}
		})
	}
}
func TestProductionFailedCheckCannotBecomeUncertain(t *testing.T) {
	for _, status := range []string{"", "unavailable", "uncertain", "passed"} {
		evidence := map[string]any{"semanticQuality": map[string]any{"status": status}}
		semantic, err := productionSemanticReviewOutcome(evidence)
		if err != nil || stricterProductionStepOutcome("failed", semantic) != "failed" {
			t.Fatalf("failed was downgraded for %s", status)
		}
	}
}
