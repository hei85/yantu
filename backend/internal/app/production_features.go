package app

import (
	"os"
	"strings"
)

// ProductionFeatures 是自动制作链路的运行时开关，默认全部开启。
// 关闭某一项时，执行端必须给出结构化原因并停止对应动作，不能伪造完成。
//
//	CANVAS_PRODUCTION_AUTO                  自动制作（付费步骤提交）
//	CANVAS_PRODUCTION_AUTO_SKILL            技能自动选择
//	CANVAS_PRODUCTION_CROSS_MODEL_ROUTING   跨模型/跨路由换模
//	CANVAS_PRODUCTION_AUTO_REPAIR           失败后的自动修复推进
//	CANVAS_PRODUCTION_SEMANTIC_QA           语义质量检查
type ProductionFeatures struct {
	AutoProduction    bool `json:"autoProduction"`
	AutoSkill         bool `json:"autoSkill"`
	CrossModelRouting bool `json:"crossModelRouting"`
	AutoRepair        bool `json:"autoRepair"`
	SemanticQA        bool `json:"semanticQA"`
}

func ProductionFeaturesFromEnv() ProductionFeatures {
	return ProductionFeatures{
		AutoProduction:    envFlagDefaultOn("CANVAS_PRODUCTION_AUTO"),
		AutoSkill:         envFlagDefaultOn("CANVAS_PRODUCTION_AUTO_SKILL"),
		CrossModelRouting: envFlagDefaultOn("CANVAS_PRODUCTION_CROSS_MODEL_ROUTING"),
		AutoRepair:        envFlagDefaultOn("CANVAS_PRODUCTION_AUTO_REPAIR"),
		SemanticQA:        envFlagDefaultOn("CANVAS_PRODUCTION_SEMANTIC_QA"),
	}
}

// ProductionFeatures 返回当前进程实际生效的开关，供健康检查与 MCP 诊断读取。
func (s *Service) ProductionFeatures() ProductionFeatures { return ProductionFeaturesFromEnv() }

func envFlagDefaultOn(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "0", "false", "off", "no", "disabled":
		return false
	default:
		return true
	}
}
