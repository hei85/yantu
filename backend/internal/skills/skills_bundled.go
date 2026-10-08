package skills

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

const bundledSkillOwner = "yingce-bundled"

// EnsureBundledSkills registers shipped packages for the recipient's own user.
// Package identity is independent of the installation path and user database.
func (s *Service) EnsureBundledSkills(userID, root string) (int, error) {
	if strings.TrimSpace(userID) == "" || !filepath.IsAbs(root) {
		return 0, errors.New("随包技能需要有效用户和绝对技能目录")
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("随包技能目录不存在或不是普通目录")
	}
	var entries []string
	err = filepath.WalkDir(root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("随包技能不能包含软链接")
		}
		if entry.IsDir() && ignoredBundledSkillDirectory(entry.Name()) {
			return filepath.SkipDir
		}
		if !entry.IsDir() && entry.Name() == "SKILL.md" {
			entries = append(entries, filePath)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	if len(entries) == 0 {
		return 0, errors.New("随包技能目录中没有 SKILL.md")
	}
	for _, entry := range entries {
		relative, err := filepath.Rel(root, filepath.Dir(entry))
		if err != nil {
			return 0, err
		}
		subdir := filepath.ToSlash(relative)
		archive, err := readBundledSkillDirectory(filepath.Dir(entry))
		if err != nil {
			return 0, fmt.Errorf("读取随包技能 %s: %w", subdir, err)
		}
		if err := s.ensureBundledSkill(userID, subdir, archive); err != nil {
			return 0, fmt.Errorf("安装随包技能 %s: %w", subdir, err)
		}
	}
	return len(entries), nil
}

func ignoredBundledSkillDirectory(name string) bool {
	return name == ".git" || name == "__pycache__" || name == "node_modules" || name == ".cache"
}

func readBundledSkillDirectory(root string) (skillPackageArchive, error) {
	files := make(map[string][]byte)
	var total int64
	err := filepath.WalkDir(root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("随包技能不能包含软链接")
		}
		if entry.IsDir() {
			if ignoredBundledSkillDirectory(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(entry.Name(), ".download") || strings.HasSuffix(entry.Name(), ".pyc") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > maxSkillFileBytes {
			return errors.New("随包技能文件不是普通文件或超过 8MB")
		}
		total += info.Size()
		if total > maxSkillPackageBytes || len(files) >= maxSkillPackageFiles {
			return errors.New("随包技能超过 20MB 或 512 个文件")
		}
		relative, err := filepath.Rel(root, filePath)
		if err != nil {
			return err
		}
		name, err := normalizeSkillPath(filepath.ToSlash(relative))
		if err != nil {
			return err
		}
		content, err := os.ReadFile(filePath)
		if err != nil {
			return err
		}
		if len(content) > maxSkillFileBytes {
			return errors.New("随包技能文件超过 8MB")
		}
		files[name] = content
		return nil
	})
	if err != nil {
		return skillPackageArchive{}, err
	}
	metadata := parseSkillPackageMetadata(files["SKILL.md"])
	archive, err := finalizeSkillArchive(files, metadata)
	if err == nil && archive.TotalBytes > maxSkillPackageBytes {
		return skillPackageArchive{}, errors.New("随包技能超过 20MB")
	}
	return archive, err
}

func (s *Service) ensureBundledSkill(userID, subdir string, archive skillPackageArchive) error {
	digest := sha256.Sum256([]byte("yingce:bundled:" + subdir))
	id := hex.EncodeToString(digest[:16])
	skill, err := s.repo.Skill(id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		now := time.Now()
		versionID := kernel.NewID()
		packageKey, version, files, err := s.persistSkillArchive(id, versionID, archive, "")
		if err != nil {
			return err
		}
		label := archive.Metadata.Version
		if label == "" {
			label = archive.ContentHash[:12]
		}
		version.VersionLabel = label
		skill = &model.Skill{
			ID: id, OwnerID: bundledSkillOwner, AuthorName: "衍图随包技能",
			Name: archive.Metadata.Name, Description: archive.Metadata.Description, Instruction: string(archive.Files["SKILL.md"]),
			CurrentVersionID: versionID, VersionLabel: label, ContentHash: archive.ContentHash, FileCount: len(files), TotalBytes: archive.TotalBytes,
			SourceType: "bundled", SourceSubdir: subdir, Source: skillSourceUser, Status: skillStatusEnabled,
			Tag: "drama", IsPrivate: false, ShowcaseMediaJSON: "[]", SyncStatus: "synced", LastCheckedAt: &now, LastSyncedAt: &now,
		}
		state := &model.UserSkillState{ID: kernel.NewID(), UserID: userID, SkillID: id, Added: true, InstalledVersionID: versionID}
		if err := s.repo.CreateSkillWithPackage(skill, version, files, state); err != nil {
			_ = os.Remove(filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(packageKey)))
			return err
		}
		return nil
	}
	if err != nil {
		return err
	}
	if skill.OwnerID != bundledSkillOwner || skill.SourceType != "bundled" || skill.SourceSubdir != subdir {
		return errors.New("随包技能 ID 与已有用户技能冲突")
	}
	previousVersion := skill.CurrentVersionID
	if skill.ContentHash != archive.ContentHash || previousVersion == "" {
		skill.Name = archive.Metadata.Name
		skill.Description = archive.Metadata.Description
		skill.Instruction = string(archive.Files["SKILL.md"])
		if err := s.addSkillArchiveVersion(skill, archive, "bundled", "", "", subdir, "", false); err != nil {
			return err
		}
	}
	state, err := s.repo.UserSkillState(userID, id)
	if err != nil {
		return err
	}
	if state == nil {
		return s.repo.SetUserSkillAdded(&model.UserSkillState{ID: kernel.NewID(), UserID: userID, SkillID: id, Added: true, InstalledVersionID: skill.CurrentVersionID})
	}
	// Keep explicit removals, likes and separately pinned versions on restart.
	if state.InstalledVersionID == "" || state.InstalledVersionID == previousVersion {
		state.InstalledVersionID = skill.CurrentVersionID
		return s.repo.SetUserSkillAdded(state)
	}
	return nil
}
