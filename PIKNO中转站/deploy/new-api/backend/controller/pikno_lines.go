package controller

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/piknocatalog"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
)

type piknoPublicLine struct {
	Currency           string             `json:"currency"`
	Revision           int64              `json:"line_revision"`
	ImageBilling       string             `json:"image_billing,omitempty"`
	Prices             []piknoPublicPrice `json:"prices"`
	ReferenceSurcharge string             `json:"reference_surcharge_cny"`
	ID                 string             `json:"id"`
	Name               string             `json:"name"`
	Kind               string             `json:"kind"`
	Resolutions        []string           `json:"resolutions"`
	Ratios             []string           `json:"ratios"`
	Qualities          []string           `json:"qualities,omitempty"`
	Durations          []float64          `json:"durations"`
	MaxImages          int                `json:"max_images"`
	MaxVideos          int                `json:"max_videos"`
	MaxAudio           int                `json:"max_audio"`
	MaxMediaTotal      int                `json:"max_media_total"`
}

func publicPiknoLine(config model.PiknoLineConfig) piknoPublicLine {
	prices := make([]piknoPublicPrice, 0, len(config.Prices))
	for _, price := range config.Prices {
		if (price.Unit == "image" || price.Unit == "second" || price.Unit == "request") && price.RetailQuota >= 0 && (price.RetailQuota > 0 || model.PiknoLineAllowsZeroQuote(&config)) {
			prices = append(prices, piknoPublicPrice{Resolution: price.Resolution, Unit: price.Unit, RetailCNY: model.PiknoCNY(price.RetailQuota)})
		}
	}
	public := piknoPublicLine{
		Currency: "CNY", Revision: config.Revision, Prices: prices, ReferenceSurcharge: model.PiknoCNY(config.ReferenceSurchargeQuota),
		ID: config.PublicModel, Name: model.PiknoCustomerLineName(&config), Kind: config.Kind,
		Resolutions: config.Resolutions, Ratios: config.Ratios, Durations: config.Durations,
		Qualities: config.Qualities,
		MaxImages: config.MaxImages, MaxVideos: config.MaxVideos, MaxAudio: config.MaxAudio,
		MaxMediaTotal: config.MediaTotalLimit(),
	}
	if service.PiknoImageUsageAvailable(&config) {
		public.ImageBilling = service.PiknoImageUsageVersion
	}
	return public
}

func PiknoPublicLinesData() (map[string]any, error) {
	lines, err := model.ListPublishedPiknoLines()
	if err != nil {
		return nil, err
	}
	public := make([]piknoPublicLine, 0, len(lines))
	var revision int64
	var fetchedAt string
	for _, line := range lines {
		public = append(public, publicPiknoLine(line))
		if line.Revision > revision {
			revision = line.Revision
		}
		if line.FetchedAt > fetchedAt {
			fetchedAt = line.FetchedAt
		}
	}
	return map[string]any{"revision": fmt.Sprint(revision), "fetched_at": fetchedAt, "models": public}, nil
}

func PiknoLines(c *gin.Context) {
	data, err := PiknoPublicLinesData()
	if err != nil {
		piknoLineError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

func PiknoLinesAdmin(c *gin.Context) {
	lines, err := model.ListPiknoLineAdmin()
	if err != nil {
		piknoLineError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"lines": lines, "sync": model.PiknoSyncAdminStatus()}})
}

func stablePublicModel(entry piknocatalog.Entry) string {
	identifier := entry.ID
	prefix := "pikno-" + entry.Kind + "-"
	switch entry.Provider {
	case "packy":
		identifier = "flare"
	case "sanbao":
		identifier = "sb-" + strings.TrimPrefix(entry.ID, "sanbao/")
	case "canseedream":
		identifier = "cs-" + strings.TrimPrefix(entry.ID, "canseedream/video/")
	}
	identifier = strings.NewReplacer("/", "-", " ", "-").Replace(identifier)
	result := prefix + identifier
	if len(result) <= 120 {
		return result
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(entry.Provider+"\x00"+entry.ID)))[:16]
	return result[:103] + "-" + hash
}

func catalogEntrySeed(entry piknocatalog.Entry, fetchedAt string) (model.PiknoLineSeed, error) {
	if piknocatalog.IsRetiredEntry(entry) {
		return model.PiknoLineSeed{}, errors.New("catalog provider is retired")
	}
	pluginKey := ""
	switch entry.Provider {
	case "canseedream":
		pluginKey = "pikno-canseedream"
	case "packy":
	default:
		return model.PiknoLineSeed{}, errors.New("unsupported catalog provider")
	}
	prices := make([]model.PiknoLinePrice, 0, len(entry.Prices))
	for _, price := range entry.Prices {
		quota := 0
		if price.RetailCNY > 0 && !model.PiknoLineSyncEnabled() {
			converted, err := common.QuotaRoundStrict(price.RetailCNY * 1_000_000)
			if err != nil {
				return model.PiknoLineSeed{}, err
			}
			quota = converted
		}
		prices = append(prices, model.PiknoLinePrice{
			Resolution: price.Resolution, Unit: price.Unit, CostCNY: price.CostCNY,
			SuggestedCNY: price.RetailCNY, RetailQuota: quota,
		})
	}
	surcharge := 0
	if entry.ReferenceSurchargeCNY > 0 && !model.PiknoLineSyncEnabled() {
		converted, err := common.QuotaRoundStrict(entry.ReferenceSurchargeCNY * 1_000_000)
		if err != nil {
			return model.PiknoLineSeed{}, err
		}
		surcharge = converted
	}
	seed := model.PiknoLineSeed{
		PublicModel: stablePublicModel(entry), SourceID: entry.ID, DisplayName: entry.Name,
		Kind: entry.Kind, Provider: entry.Provider, UpstreamModel: entry.ID, PluginKey: pluginKey,
		UpstreamAvailable: entry.Available, Resolutions: entry.Resolutions, Ratios: entry.Ratios,
		Qualities: entry.Qualities,
		Durations: entry.Durations, MaxImages: entry.MaxImages, MaxVideos: entry.MaxVideos,
		MaxAudio: entry.MaxAudio, MaxMediaTotal: entry.MaxMediaTotal, Prices: prices, PriceIssue: entry.PriceIssue,
		BillingUnit: entry.BillingUnit, CostIssueCode: entry.CostIssueCode, BillingIssueCode: entry.BillingIssueCode,
		ReferenceSurchargeQuota: surcharge, FetchedAt: fetchedAt,
	}
	seed.ChannelID = model.RecommendPiknoChannel(seed)
	return seed, nil
}

func PiknoLinesSync(c *gin.Context) {
	if err := PiknoSyncCatalogOnce(c.Request.Context(), true); err != nil {
		piknoLineError(c, err)
		return
	}
	PiknoLinesAdmin(c)
}

func PiknoLineUpdate(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
	var request struct {
		PublicModel     string                  `json:"public_model"`
		ExpectedVersion int64                   `json:"expected_version"`
		Name            *string                 `json:"name"`
		Enabled         *bool                   `json:"enabled"`
		Prices          *[]model.PiknoLinePrice `json:"prices"`
	}
	if err := common.DecodeJson(c.Request.Body, &request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Invalid line update"})
		return
	}
	view, err := model.UpdatePiknoLineDraft(request.PublicModel, model.PiknoLinePatch{
		ExpectedVersion: request.ExpectedVersion, DisplayName: request.Name, Enabled: request.Enabled,
		Prices: request.Prices,
	}, c.GetInt("id"))
	if err != nil {
		piknoLineError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": view})
}

func PiknoLineValidate(c *gin.Context) {
	request, ok := decodePiknoLineAction(c)
	if !ok {
		return
	}
	view, err := model.GetPiknoLineAdmin(request.PublicModel, request.ExpectedVersion)
	if err != nil {
		piknoLineError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": view})
}

type piknoLineActionRequest struct {
	PublicModel     string `json:"public_model"`
	ExpectedVersion int64  `json:"expected_version"`
}

func decodePiknoLineAction(c *gin.Context) (piknoLineActionRequest, bool) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	var request piknoLineActionRequest
	if common.DecodeJson(c.Request.Body, &request) != nil || request.PublicModel == "" || request.ExpectedVersion < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "Line and expected version are required"})
		return request, false
	}
	return request, true
}

func PiknoLinePublish(c *gin.Context)  { piknoLineAction(c, model.PublishPiknoLine) }
func PiknoLineDisable(c *gin.Context)  { piknoLineAction(c, model.DisablePiknoLine) }
func PiknoLineRollback(c *gin.Context) { piknoLineAction(c, model.RollbackPiknoLine) }

func piknoLineAction(c *gin.Context, action func(string, int64, int) (*model.PiknoLineAdminView, error)) {
	request, ok := decodePiknoLineAction(c)
	if !ok {
		return
	}
	view, err := action(request.PublicModel, request.ExpectedVersion, c.GetInt("id"))
	if err != nil {
		piknoLineError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": view})
}

func piknoLineError(c *gin.Context, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, model.ErrPiknoLineConflict):
		status = http.StatusConflict
	case errors.Is(err, model.ErrPiknoLineNotFound):
		status = http.StatusNotFound
	case errors.Is(err, model.ErrPiknoLineNotReady):
		status = http.StatusUnprocessableEntity
	}
	c.JSON(status, gin.H{"success": false, "message": err.Error()})
}

func piknoTokenCanUseModel(c *gin.Context, modelName string) bool {
	if !common.GetContextKeyBool(c, constant.ContextKeyTokenModelLimitEnabled) {
		return true
	}
	raw, ok := common.GetContextKey(c, constant.ContextKeyTokenModelLimit)
	if !ok {
		return false
	}
	limits, _ := raw.(map[string]bool)
	matching := ratio_setting.RoutingMatchModelName(modelName)
	return limits[modelName] || limits[matching]
}

func callablePiknoModels(c *gin.Context) ([]dto.OpenAIModels, error) {
	groups, err := getModelListGroups(c)
	if err != nil {
		return nil, err
	}
	enabled, err := model.EnabledPiknoLineModelsForGroups(groups.ownerGroups)
	if err != nil {
		return nil, err
	}
	lines, err := model.ListPublishedPiknoLines()
	if err != nil {
		return nil, err
	}
	result := make([]dto.OpenAIModels, 0, len(lines))
	for _, line := range lines {
		if !enabled[line.PublicModel] || !piknoTokenCanUseModel(c, line.PublicModel) {
			continue
		}
		result = append(result, dto.OpenAIModels{Id: line.PublicModel, Object: "model", Created: 0, OwnedBy: "pikno"})
	}
	return result, nil
}

func callablePiknoModelIDs(c *gin.Context) ([]string, error) {
	models, err := callablePiknoModels(c)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(models))
	for _, item := range models {
		result = append(result, item.Id)
	}
	return result, nil
}

// PiknoUserModels preserves the legacy user-model response shape while only
// exposing published PIKNO aliases. The key editor therefore cannot select a
// provider model ID by accident.
func PiknoUserModels(c *gin.Context) {
	models, err := callablePiknoModelIDs(c)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "Published model list is unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "", "data": models})
}

// PiknoDashboardModels keeps the dashboard endpoint compatible without
// leaking NEW API's built-in or provider-specific model catalogue.
func PiknoDashboardModels(c *gin.Context) {
	models, err := callablePiknoModelIDs(c)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "message": "Published model list is unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    map[int][]string{constant.ChannelTypeOpenAI: models},
	})
}

func PiknoListPublishedModels(c *gin.Context) {
	models, err := callablePiknoModels(c)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"message": "Published model list is unavailable", "type": "server_error"}})
		return
	}
	if c.FullPath() == "/v1/models" && piknoArkChatDiscoverable(c) && !slices.ContainsFunc(models, func(item dto.OpenAIModels) bool { return item.Id == model.PiknoLLMArkModel }) {
		models = append(models, dto.OpenAIModels{Id: model.PiknoLLMArkModel, Object: "model", OwnedBy: "pikno"})
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": models, "object": "list"})
}

func PiknoRetrievePublishedModel(c *gin.Context) {
	modelName := c.Param("model")
	if modelName == model.PiknoLLMArkModel && c.FullPath() == "/v1/models/:model" && piknoArkChatDiscoverable(c) {
		c.JSON(http.StatusOK, dto.OpenAIModels{Id: modelName, Object: "model", OwnedBy: "pikno"})
		return
	}
	models, err := callablePiknoModels(c)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": gin.H{"message": "Published model list is unavailable", "type": "server_error"}})
		return
	}
	for _, item := range models {
		if item.Id == modelName {
			c.JSON(http.StatusOK, item)
			return
		}
	}
	c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"message": fmt.Sprintf("The model '%s' does not exist", modelName), "type": "invalid_request_error", "param": "model", "code": "model_not_found"}})
}

func piknoArkChatDiscoverable(c *gin.Context) bool {
	return common.GetContextKeyString(c, constant.ContextKeyTokenGroup) == model.PiknoLLMGroup &&
		piknoTokenCanUseModel(c, model.PiknoLLMArkModel) && piknoLLMArkChannel(piknoLLMSettings()) != nil
}
