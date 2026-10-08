package skills

import (
	"fmt"
	"strings"
	"testing"
)

func TestSkillMetadataSupportsFoldedAndLiteralDescriptions(t *testing.T) {
	for _, marker := range []string{">", "|", ">-", "|-"} {
		t.Run(marker, func(t *testing.T) {
			entry := fmt.Sprintf("---\nname: higgsfield\ndescription: %s\n  Plan a film and maintain character consistency.\n  Read only relevant references.\nmetadata:\n  version: 3.40.0\n---\n# Body\n", marker)
			metadata := parseSkillPackageMetadata([]byte(entry))
			if metadata.Name != "higgsfield" || metadata.Version != "3.40.0" || !strings.Contains(metadata.Description, "character consistency") || !strings.Contains(metadata.Description, "relevant references") {
				t.Fatalf("metadata = %#v", metadata)
			}
		})
	}
}

func TestSkillMetadataReadsRootVersionAndQuotedScalars(t *testing.T) {
	entry := "---\nname: remotion-best-practices\ndescription: 'Director''s film: subtitles and editing'\nversion: 4.0.531\n---\n"
	metadata := parseSkillPackageMetadata([]byte(entry))
	if metadata.Version != "4.0.531" || metadata.Description != "Director's film: subtitles and editing" {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestSkillZipLimitsApplyToSelectedSubdirectory(t *testing.T) {
	files := map[string]string{
		"repo-main/skills/ffmpeg-ops/SKILL.md":            "---\nname: ffmpeg-ops\ndescription: Media processing\n---\n",
		"repo-main/skills/ffmpeg-ops/references/audio.md": "# Mix",
	}
	for index := 0; index < maxSkillPackageFiles+100; index++ {
		files[fmt.Sprintf("repo-main/other-skill/file-%d.md", index)] = "not selected"
	}
	data := skillZip(t, files)
	archive, err := archiveFromZip(data, "skills/ffmpeg-ops")
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.Files) != 2 || archive.Metadata.Name != "ffmpeg-ops" || string(archive.Files["references/audio.md"]) != "# Mix" {
		t.Fatalf("selected archive = %#v", archive)
	}
	for index := 0; index < maxSkillPackageFiles; index++ {
		files[fmt.Sprintf("repo-main/skills/ffmpeg-ops/references/file-%d.md", index)] = "selected"
	}
	if _, err := archiveFromZip(skillZip(t, files), "skills/ffmpeg-ops"); err == nil {
		t.Fatal("an oversized selected package must remain rejected")
	}
}
