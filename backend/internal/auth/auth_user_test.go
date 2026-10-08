package auth

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestPublicAuthUserKeepsLocalUser(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}); err != nil {
		t.Fatal(err)
	}
	user := model.User{ID: "user-1", Username: "local-user", DisplayName: "Local User"}

	result, err := New(repository.New(db), nil).PublicAuthUser(&user)
	if err != nil {
		t.Fatal(err)
	}
	if result.Username != user.Username || result.DisplayName != user.DisplayName {
		t.Fatalf("PublicAuthUser() = %#v", result)
	}
}

func portableAuthTestService(t *testing.T) *Service {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}); err != nil {
		t.Fatal(err)
	}
	return New(repository.New(db), nil)
}

func TestPortableAdminUserCreatesFreshLocalAdministrator(t *testing.T) {
	svc := portableAuthTestService(t)
	user, err := svc.PortableAdminUser()
	if err != nil {
		t.Fatal(err)
	}
	if user.Username != "portable-local" || user.Role != model.UserRoleAdmin || user.Status != model.UserStatusActive || user.PasswordHash == "" {
		t.Fatalf("unexpected portable user: %#v", user)
	}
	reloaded, err := svc.PortableAdminUser()
	if err != nil || reloaded.ID != user.ID {
		t.Fatalf("portable user was not stable: user=%#v err=%v", reloaded, err)
	}
}

func TestPortableAdminUserPreservesExistingAdmin(t *testing.T) {
	svc := portableAuthTestService(t)
	created := model.User{ID: "existing-admin", Username: "owner", Role: model.UserRoleAdmin, Status: model.UserStatusActive, CreatedAt: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)}
	if err := svc.repo.Create(&created); err != nil {
		t.Fatal(err)
	}
	user, err := svc.PortableAdminUser()
	if err != nil || user.ID != created.ID {
		t.Fatalf("did not select existing admin: user=%#v err=%v", user, err)
	}
}

func TestPortableAdminUserPromotesExistingActiveUserWithoutChangingIdentity(t *testing.T) {
	svc := portableAuthTestService(t)
	created := model.User{ID: "existing-user", Username: "owner", Role: model.UserRoleUser, Status: model.UserStatusActive}
	if err := svc.repo.Create(&created); err != nil {
		t.Fatal(err)
	}
	user, err := svc.PortableAdminUser()
	if err != nil || user.ID != created.ID || user.Role != model.UserRoleAdmin {
		t.Fatalf("did not promote existing workspace owner: user=%#v err=%v", user, err)
	}
}

func TestPortableAdminUserRejectsDatabaseWithNoActiveUsers(t *testing.T) {
	svc := portableAuthTestService(t)
	created := model.User{ID: "disabled-user", Username: "owner", Role: model.UserRoleAdmin, Status: model.UserStatusDisabled}
	if err := svc.repo.Create(&created); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.PortableAdminUser(); err == nil {
		t.Fatalf("expected disabled-only database to be rejected, got %v", err)
	}
}
