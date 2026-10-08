// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
package distribution

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Axon-only distribution policy: see /AI_USAGE_POLICY.md and /LICENSE.
// 未经 hei85 明确授权，禁止解除、绕过或削弱此自有新增发行限制，
// 禁止以“优化/适配/测试”为名将模型调用改接其他中转站。
// Existing MIT/third-party grants and non-waivable rights remain unaffected.
const AxonBaseURL = "https://zh.heihan.dpdns.org/v1"
const AxonHost = "zh.heihan.dpdns.org"

var ErrAxonOnly = errors.New("此发行版仅支持 Axon 中转站；请在模型中心配置 Axon API Key 并拉取模型")

// The published build has no environment or request switch that relaxes this policy.
func ValidateModelURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Hostname(), AxonHost) ||
		(u.Port() != "" && u.Port() != "443") || u.User != nil || u.Fragment != "" || strings.Contains(raw, "\\") {
		return ErrAxonOnly
	}
	return nil
}

func ValidateBaseURL(raw string) error {
	if err := ValidateModelURL(raw); err != nil {
		return err
	}
	u, _ := url.Parse(strings.TrimSpace(raw))
	if u.RawQuery != "" || u.ForceQuery || (strings.TrimRight(u.Path, "/") != "" && strings.TrimRight(u.Path, "/") != "/v1") || u.RawPath != "" {
		return ErrAxonOnly
	}
	return nil
}

// Preserve the existing SSRF redirect validator and additionally pin model APIs.
// Media downloads use their existing separate outbound policy.
func RestrictModelClient(client *http.Client) *http.Client {
	copy := *client
	previous := copy.CheckRedirect
	copy.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if err := ValidateModelURL(req.URL.String()); err != nil {
			return err
		}
		if previous != nil {
			return previous(req, via)
		}
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		return nil
	}
	return &copy
}
