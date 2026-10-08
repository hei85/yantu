package platform

import "testing"

func TestPortableNoLoginRequiresLoopbackBind(t *testing.T) {
	t.Setenv(PortableNoLoginEnv, "1")
	for _, addr := range []string{"127.0.0.1:8080", "[::1]:8080"} {
		if err := ValidatePortableNoLoginBindAddress(addr); err != nil {
			t.Errorf("loopback address %q rejected: %v", addr, err)
		}
	}
	for _, addr := range []string{":8080", "0.0.0.0:8080", "192.168.1.10:8080"} {
		if err := ValidatePortableNoLoginBindAddress(addr); err == nil {
			t.Errorf("non-loopback address %q accepted", addr)
		}
	}
}

func TestPortableNoLoginRequiresExplicitEnablement(t *testing.T) {
	t.Setenv(PortableNoLoginEnv, "")
	if err := ValidatePortableNoLoginBindAddress(":8080"); err != nil {
		t.Fatalf("regular listener rejected when portable no-login is disabled: %v", err)
	}
}

func TestIsLoopbackRemoteAddr(t *testing.T) {
	for _, remote := range []string{"127.0.0.1:3000", "[::1]:3000"} {
		if !IsLoopbackRemoteAddr(remote) {
			t.Errorf("loopback remote %q rejected", remote)
		}
	}
	for _, remote := range []string{"192.168.1.5:3000", "bad-address"} {
		if IsLoopbackRemoteAddr(remote) {
			t.Errorf("non-loopback remote %q accepted", remote)
		}
	}
}
