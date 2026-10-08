// SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
package app

import (
	"strings"

	"infinite-canvas/backend/internal/distribution"
	"infinite-canvas/backend/internal/model"
)

func requireAxonBaseURL(raw string) error {
	if distribution.ValidateBaseURL(raw) != nil {
		return Forbidden(distribution.ErrAxonOnly.Error())
	}
	return nil
}

func requireAxonChannel(channel *model.ModelChannel) error {
	if channel == nil {
		return Forbidden(distribution.ErrAxonOnly.Error())
	}
	return requireAxonBaseURL(channel.BaseURL)
}

func (s *Service) validateAxonModelEdit(channelID, id string, req ChannelModelRequest) error {
	if strings.TrimSpace(id) == "" {
		return Forbidden("请从 Axon 模型目录拉取并导入模型，不能手动添加目录外模型")
	}
	current, err := s.repo.ChannelModelByID(channelID, id)
	if err != nil {
		return err
	}
	providerKey := firstNonEmpty(req.ProviderModelKey, req.ModelKey)
	if req.ModelKey != current.ModelKey || providerKey != firstNonEmpty(current.ProviderModelKey, current.ModelKey) {
		return Forbidden("Axon 模型 ID 不可替换；新模型请从 Axon 目录导入")
	}
	known, err := s.repo.ChannelModels(channelID, true)
	if err != nil {
		return err
	}
	allowed := map[string]bool{}
	for _, item := range known {
		allowed[firstNonEmpty(item.ProviderModelKey, item.ModelKey)] = true
	}
	for _, item := range req.Variants {
		if key := strings.TrimSpace(item.ProviderModelKey); key != "" && !allowed[key] {
			return Forbidden("规格档只能关联已从 Axon 目录导入的模型")
		}
	}
	return nil
}
