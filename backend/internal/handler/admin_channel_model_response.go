package handler

import "infinite-canvas/backend/internal/model"

// adminChannelModelResponse 直接复用渠道模型读模型；规格档已不含任何成本字段。
type adminChannelModelResponse = model.ChannelModel

func adminChannelModel(item model.ChannelModel) adminChannelModelResponse {
	return item
}
