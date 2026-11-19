package controller

import (
	"net/http"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type piknoRHConnection struct {
	ID     int    `json:"id"`
	Kind   string `json:"kind,omitempty"`
	Name   string `json:"name"`
	Status int    `json:"status"`
}

// Classify only the fixed internal tools. Similar names, other plugins and
// mixed/unknown model sets stay in the normal channel management view.
func piknoRHConnectionKind(channel *model.Channel) string {
	var setting struct {
		TaskPluginKey string `json:"task_plugin_key"`
	}
	if channel.Type != constant.ChannelTypeTaskPlugin || channel.Setting == nil ||
		common.UnmarshalJsonStr(*channel.Setting, &setting) != nil || setting.TaskPluginKey != "pikno-tools" {
		return ""
	}
	models := strings.Split(channel.Models, ",")
	for i := range models {
		models[i] = strings.TrimSpace(models[i])
	}
	if channel.Group == "tool-standard" {
		for _, tool := range []struct{ raw, public, kind string }{
			{"digital", "pikno-tool-digital", "digital-human"},
			{"depth", "pikno-tool-depth", "depth"},
		} {
			if slices.ContainsFunc(models, func(value string) bool { return value != tool.raw && value != tool.public }) {
				continue
			}
			return tool.kind
		}
	}
	if channel.Group == "video-standard" && slices.Contains(models, "digital") && slices.Contains(models, "depth") &&
		!slices.ContainsFunc(models, func(value string) bool {
			return value != "digital" && value != "depth" && value != "pikno-tool-digital" && value != "pikno-tool-depth"
		}) {
		return "legacy"
	}
	return ""
}

func piknoRHConnections() ([]piknoRHConnection, []piknoRHConnection, error) {
	channels := make([]*model.Channel, 0)
	// Never load Keys, addresses, OtherSettings or payloads. Parse only the
	// plugin identifier from Setting in memory; never include Setting in output.
	if err := model.DB.Model(&model.Channel{}).Select("id", "type", "name", "status", "models", "group", "setting").
		Where("type = ?", constant.ChannelTypeTaskPlugin).Order("id").Find(&channels).Error; err != nil {
		return nil, nil, err
	}
	tools, legacy := make([]piknoRHConnection, 0), make([]piknoRHConnection, 0)
	for _, channel := range channels {
		kind := piknoRHConnectionKind(channel)
		if kind == "" {
			continue
		}
		connection := piknoRHConnection{ID: channel.Id, Name: channel.Name, Status: channel.Status}
		if kind == "legacy" {
			legacy = append(legacy, connection)
		} else {
			connection.Kind = kind
			tools = append(tools, connection)
		}
	}
	return tools, legacy, nil
}

func PiknoRHConnections(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	tools, legacy, err := piknoRHConnections()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "工具连接状态暂不可用"})
		return
	}
	common.ApiSuccess(c, gin.H{"tools": tools, "legacy": legacy})
}

func piknoPrepareChannelView(c *gin.Context) bool {
	view := c.Query("pikno_view")
	if view == "" {
		return true
	}
	if view != "general" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "连接视图无效"})
		return false
	}
	tools, legacy, err := piknoRHConnections()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "工具连接状态暂不可用"})
		return false
	}
	ids := make([]int, 0, len(tools)+len(legacy))
	for _, item := range tools {
		ids = append(ids, item.ID)
	}
	for _, item := range legacy {
		ids = append(ids, item.ID)
	}
	c.Set("piknoManagedRHChannelIDs", ids)
	return true
}

func piknoChannelListQuery(c *gin.Context, group string, status, channelType int) *gorm.DB {
	query := buildChannelListQuery(group, status, channelType)
	if ids := piknoRHChannelIDs(c); len(ids) != 0 {
		query = query.Where("id NOT IN ?", ids)
	}
	return query
}

func piknoRHChannelIDs(c *gin.Context) []int {
	value, _ := c.Get("piknoManagedRHChannelIDs")
	ids, _ := value.([]int)
	return ids
}

// A tag action affects every channel carrying the tag, including channels
// intentionally absent from the general view. Refuse rather than modify hidden
// RH connections through an apparently unrelated general connection.
func piknoAllowRHTagMutation(c *gin.Context, tag string) bool {
	channels := make([]*model.Channel, 0)
	if err := model.DB.Model(&model.Channel{}).Select("id", "type", "models", "group", "setting").
		Where("tag = ? AND type = ?", tag, constant.ChannelTypeTaskPlugin).Find(&channels).Error; err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "工具连接状态暂不可用"})
		return false
	}
	for _, channel := range channels {
		if piknoRHConnectionKind(channel) != "" {
			c.JSON(http.StatusConflict, gin.H{"success": false, "message": "此标签包含受管 RH 工具连接；请在 RH 详情与线路管理中操作，未修改任何连接"})
			return false
		}
	}
	return true
}
