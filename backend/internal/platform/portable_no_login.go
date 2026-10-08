package platform

import (
	"errors"
	"net"
	"os"
	"strings"
)

const PortableNoLoginEnv = "CANVAS_PORTABLE_NO_LOGIN"

func PortableNoLoginEnabled() bool {
	return strings.TrimSpace(os.Getenv(PortableNoLoginEnv)) == "1"
}

func IsLoopbackRemoteAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func ValidatePortableNoLoginBindAddress(addr string) error {
	if !PortableNoLoginEnabled() {
		return nil
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return errors.New("CANVAS_PORTABLE_NO_LOGIN requires an explicit loopback listener address")
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("CANVAS_PORTABLE_NO_LOGIN can only run on a loopback listener")
	}
	return nil
}
