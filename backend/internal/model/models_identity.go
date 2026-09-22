package model

import "time"

type User struct {
	ID           string     `json:"id" gorm:"primaryKey;size:36"`
	Username     string     `json:"username" gorm:"uniqueIndex;size:80"`
	DisplayName  string     `json:"displayName" gorm:"size:80"`
	Role         UserRole   `json:"role" gorm:"index;size:24"`
	Status       UserStatus `json:"status" gorm:"index;size:24"`
	PasswordHash string     `json:"-"`
	LastLoginAt  *time.Time `json:"lastLoginAt"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

type AuthSession struct {
	ID        string    `json:"id" gorm:"primaryKey;size:36"`
	UserID    string    `json:"userId" gorm:"index;size:36"`
	TokenHash string    `json:"-"`
	ExpiresAt time.Time `json:"expiresAt" gorm:"index"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
