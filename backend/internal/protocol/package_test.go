package protocol

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestParsePluginPackageRejectsBareManifest(t *testing.T) {
	if _, err := ParsePluginPackage([]byte(`{"apiVersion":"yingce.plugin/v1"}`)); err == nil {
		t.Fatal("bare JSON manifest was accepted as a plugin package")
	}
}

func TestParsePluginPackageValidatesWebEntry(t *testing.T) {
	manifest := []byte(`{
        "apiVersion":"yingce.plugin/v1",
        "id":"ui-extension",
        "name":"UI Extension",
        "version":"1.0.0",
        "entry":"web/entry.js",
        "surfaces":["fullscreen"],
        "runtime":{"web":"sandbox"},
        "contributes":{"commands":[{"id":"ui-extension/open","label":"Open UI"}]}
    }`)
	pkg, err := ParsePluginPackage(zipPluginPackage(t, map[string][]byte{"manifest.json": manifest, "web/entry.js": []byte("self.postMessage({type:'ready'})")}))
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Manifest.Entry != "web/entry.js" || len(pkg.Files["web/entry.js"]) == 0 {
		t.Fatalf("package = %#v", pkg)
	}

	missingEntry := zipPluginPackage(t, map[string][]byte{"manifest.json": manifest})
	if _, err := ParsePluginPackage(missingEntry); err == nil {
		t.Fatal("missing web entry was accepted")
	}

	forbidden := zipPluginPackage(t, map[string][]byte{"manifest.json": manifest, "web/entry.js": []byte("ready"), "server/entry.js": []byte("unsafe")})
	if _, err := ParsePluginPackage(forbidden); err == nil {
		t.Fatal("forbidden package path was accepted")
	}
}

func TestParsePluginPackageRequiresCanonicalRPCBackend(t *testing.T) {
	manifest := []byte(`{
        "apiVersion":"yingce.plugin/v1",
        "id":"tagged-plugin",
        "name":"Tagged Plugin",
        "version":"1.0.0",
        "author":"Test",
        "enabled":true,
        "runtime":{"backend":"rpc","backendEntry":"backend/provider"},
        "contributes":{"aiCapabilities":["text"]}
    }`)
	if _, err := ParsePluginPackage(zipPluginPackage(t, map[string][]byte{
		"manifest.json":                 manifest,
		"backend/provider-darwin-arm64": []byte("darwin-provider"),
	})); err == nil {
		t.Fatal("rpc package without the canonical backend/provider entry was accepted")
	}

	pkg, err := ParsePluginPackage(zipPluginPackage(t, map[string][]byte{
		"manifest.json":    manifest,
		"backend/provider": []byte("provider"),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(pkg.Files["backend/provider"]) == 0 {
		t.Fatalf("package = %#v", pkg)
	}

	if _, err := ParsePluginPackage(zipPluginPackage(t, map[string][]byte{"manifest.json": manifest})); err == nil {
		t.Fatal("rpc package without any backend artifact was accepted")
	}
}

func zipPluginPackage(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, data := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
