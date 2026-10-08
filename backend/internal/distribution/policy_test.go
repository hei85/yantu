// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
package distribution

import (
	"errors"
	"net/http"
	"net/url"
	"testing"
)

func TestAxonBaseURL(t *testing.T) {
	for _, raw := range []string{AxonBaseURL, AxonBaseURL + "/", "https://zh.heihan.dpdns.org", "https://zh.heihan.dpdns.org:443/v1"} {
		t.Run(raw, func(t *testing.T) {
			if err := ValidateBaseURL(raw); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAxonRejectsOtherOriginsAndOverrides(t *testing.T) {
	for _, raw := range []string{
		"https://api.openai.com/v1", "https://axon.example/v1", "http://zh.heihan.dpdns.org/v1",
		"https://zh.heihan.dpdns.org.evil.example/v1", "https://evil.example@zh.heihan.dpdns.org/v1",
		"https://zh.heihan.dpdns.org:8443/v1", "https://zh.heihan.dpdns.org/v1?upstream=evil",
		"https://zh.heihan.dpdns.org/proxy/evil", "https://zh.heihan.dpdns.org/v1#evil",
		"/api/ai/custom", "https://127.0.0.1/v1", "https://zh.heihan.dpdns.org/v1%2f..%2fproxy",
	} {
		t.Run(raw, func(t *testing.T) {
			if ValidateBaseURL(raw) == nil {
				t.Fatal("unexpectedly accepted")
			}
		})
	}
}

func TestAxonRedirectsStayOnRelayAndKeepExistingChecks(t *testing.T) {
	called := false
	client := RestrictModelClient(&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { called = true; return errors.New("existing check") }})
	u, _ := url.Parse("https://evil.example/v1/videos")
	if err := client.CheckRedirect(&http.Request{URL: u}, nil); !errors.Is(err, ErrAxonOnly) || called {
		t.Fatal("foreign redirect was not rejected first")
	}
	u, _ = url.Parse(AxonBaseURL + "/videos")
	if err := client.CheckRedirect(&http.Request{URL: u}, nil); err == nil || !called {
		t.Fatal("existing policy was lost")
	}
}
