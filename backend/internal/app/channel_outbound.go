package app

import (
	"infinite-canvas/backend/internal/distribution"
	"net/http"
	"net/url"
	"time"
)

// ValidateChannelOutboundURL keeps all provider channels on the server-side
// outbound policy. Local desktop endpoints are intentionally unsupported.
func (s *Service) ValidateChannelOutboundURL(rawURL string) (*url.URL, error) {
	if err := distribution.ValidateModelURL(rawURL); err != nil {
		return nil, Forbidden(err.Error())
	}
	return ValidateOutboundURL(rawURL)
}

func (s *Service) OutboundHTTPClientForChannel(timeout time.Duration, _ *url.URL) *http.Client {
	return distribution.RestrictModelClient(OutboundHTTPClient(timeout))
}
