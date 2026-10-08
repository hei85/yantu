package app

import (
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProbeResourceFullyDecodesStillImageWithoutVideoDuration(t *testing.T) {
	_ = requireCommand(t, "ffmpeg")
	_ = requireCommand(t, "ffprobe")
	for _, ext := range []string{"png", "jpg"} {
		t.Run(ext, func(t *testing.T) {
			svc, _ := newTimelineTaskTestService(t)
			svc.dataDir = t.TempDir()
			objectKey := "image/still." + ext
			target := filepath.Join(svc.dataDir, "resources", filepath.FromSlash(objectKey))
			if err := os.MkdirAll(filepath.Dir(target), 0750); err != nil {
				t.Fatal(err)
			}
			f, err := os.Create(target)
			if err != nil {
				t.Fatal(err)
			}
			img := image.NewRGBA(image.Rect(0, 0, 64, 36))
			img.Set(20, 20, color.RGBA{R: 240, A: 255})
			mime := "image/png"
			if ext == "png" {
				err = png.Encode(f, img)
			} else {
				mime = "image/jpeg"
				err = jpeg.Encode(f, img, nil)
			}
			closeErr := f.Close()
			if err != nil || closeErr != nil {
				t.Fatalf("encode: %v %v", err, closeErr)
			}
			resource := model.Resource{ID: "still-resource", UserID: "usr-production", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: objectKey, MimeType: mime}
			if err := svc.repo.CreateResource(&resource); err != nil {
				t.Fatal(err)
			}
			result, err := svc.ProbeResource("usr-production", resource.ID, true)
			if err != nil {
				t.Fatalf("still image wrongly rejected as duration-less video: %v", err)
			}
			if result.MediaType != "image" || !result.Probe.Decoded || result.Probe.Width != 64 || result.Probe.Height != 36 || len(result.Probe.VideoFrameSamples) != 0 {
				t.Fatalf("wrong still-image probe: %#v", result)
			}
		})
	}
}

func TestProbeResourceDoesNotAcceptCorruptStillImage(t *testing.T) {
	_ = requireCommand(t, "ffprobe")
	svc, _ := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	target := filepath.Join(svc.dataDir, "resources", "broken.png")
	if err := os.MkdirAll(filepath.Dir(target), 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("not-an-image"), 0600); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "broken", UserID: "usr-production", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "broken.png", MimeType: "image/png"}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ProbeResource("usr-production", resource.ID, true); err == nil {
		t.Fatal("corrupt image was accepted")
	}
}
