package controller

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

type piknoPublicPrice struct {
	Resolution string `json:"resolution"`
	Unit       string `json:"unit"`
	RetailCNY  string `json:"retail_cny"`
}

type piknoCustomerQuote struct {
	QuoteID            string `json:"quote_id"`
	Name               string `json:"name"`
	Revision           int64  `json:"line_revision"`
	Currency           string `json:"currency"`
	Unit               string `json:"unit"`
	UnitPrice          string `json:"unit_price_cny"`
	Units              int    `json:"units"`
	ReferenceSurcharge string `json:"reference_surcharge_cny"`
	PerItem            string `json:"per_item_cny"`
	Quantity           int    `json:"quantity"`
	Total              string `json:"total_cny"`
	Expires            int64  `json:"expires_at"`
	BalanceChecked     bool   `json:"balance_checked,omitempty"`
}

func piknoQuoteError(c *gin.Context, code string, status int, slot *model.PiknoPriceQuoteSlot) {
	message := "Unable to confirm this quote; obtain and confirm a new quote"
	state := "not_submitted"
	switch code {
	case "insufficient_balance":
		message = "Insufficient wallet balance for this quote"
	case service.PiknoImageUpgradeCode:
		message = service.PiknoImageUpgradeMessage
	}
	if slot != nil {
		message, state = "This quote slot was already used; query the original task", "pending"
		if slot.OrderID != "" {
			state = "accepted"
		}
	}
	result := gin.H{"code": code, "message": message, "submission_state": state}
	if slot != nil && strings.HasPrefix(slot.OrderID, "task_") {
		result["task_id"] = slot.OrderID
	}
	c.AbortWithStatusJSON(status, gin.H{"error": result})
}

// Uses published prices and optionally checks the wallet. No media inspection,
// tool status request, upload, reservation, task insertion or upstream request.
func PiknoPriceQuote(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	if c.GetInt("id") < 1 || c.GetInt("token_id") < 1 {
		piknoQuoteError(c, "quote_invalid", 401, nil)
		return
	}
	if !service.PiknoSettlementEnabled() {
		piknoQuoteError(c, "quote_unavailable", 503, nil)
		return
	}
	ct, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || ct != "application/json" {
		piknoQuoteError(c, "quote_invalid", 415, nil)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10))
	var params model.PiknoPriceParameters
	if err != nil || common.Unmarshal(raw, &params) != nil {
		piknoQuoteError(c, "quote_invalid", 400, nil)
		return
	}
	line, err := model.GetPublishedPiknoLine(params.Model)
	if err != nil {
		piknoQuoteError(c, "quote_changed", 409, nil)
		return
	}
	if !piknoPriceAccess(c, line, params.Operation) {
		piknoQuoteError(c, "quote_forbidden", 403, nil)
		return
	}
	if service.PiknoImageUsageAvailable(line) {
		piknoQuoteError(c, service.PiknoImageUpgradeCode, http.StatusConflict, nil)
		return
	}
	quote, price, units, err := piknoPriceForParameters(line, params)
	if err != nil {
		piknoQuoteError(c, "quote_invalid", 400, nil)
		return
	}
	if quote.Quota > common.MaxQuota/params.Quantity {
		piknoQuoteError(c, "quote_invalid", 400, nil)
		return
	}
	totalQuota := quote.Quota * params.Quantity
	balanceChecked := c.GetHeader(service.PiknoBalanceCheckHeader) == "1"
	if balanceChecked {
		balance, err := model.GetUserQuota(c.GetInt("id"), true)
		if err != nil {
			piknoQuoteError(c, "quote_unavailable", http.StatusServiceUnavailable, nil)
			return
		}
		if balance < totalQuota {
			piknoQuoteError(c, "insufficient_balance", http.StatusPaymentRequired, nil)
			return
		}
	}
	token, err := model.SignPiknoPriceContext(model.PiknoPriceContext{UserID: c.GetInt("id"), TokenID: c.GetInt("token_id"), Revision: line.Revision, Quota: quote.Quota, Parameters: params})
	if err != nil {
		piknoQuoteError(c, "quote_unavailable", 503, nil)
		return
	}
	context, err := model.ParsePiknoPriceContext(token)
	if err != nil {
		piknoQuoteError(c, "quote_unavailable", 503, nil)
		return
	}
	data := piknoCustomerQuote{
		QuoteID:            token,
		Name:               model.PiknoCustomerLineName(line),
		Revision:           line.Revision,
		Currency:           "CNY",
		Unit:               price.Unit,
		UnitPrice:          model.PiknoCNY(price.RetailQuota),
		Units:              units,
		ReferenceSurcharge: model.PiknoCNY(quote.Quota - price.RetailQuota*units),
		PerItem:            model.PiknoCNY(quote.Quota),
		Quantity:           params.Quantity,
		Total:              model.PiknoCNY(totalQuota),
		Expires:            context.Expires,
		BalanceChecked:     balanceChecked,
	}
	c.JSON(200, gin.H{"success": true, "data": data})
}

func piknoPriceAccess(c *gin.Context, line *model.PiknoLineConfig, operation string) bool {
	group := "video-standard"
	switch operation {
	case "image", "image_edit":
		if line.Kind != "image" || line.Provider == "hamster-tools" {
			return false
		}
		group = "image-standard"
	case "video":
		if line.Kind != "video" || line.Provider == "hamster-tools" {
			return false
		}
	case "digital", "depth":
		if line.PublicModel != "pikno-tool-"+operation || line.Provider != "hamster-tools" {
			return false
		}
		group = "tool-standard"
	default:
		return false
	}
	if common.GetContextKeyString(c, constant.ContextKeyTokenGroup) != group || !piknoTokenCanUseModel(c, line.PublicModel) {
		return false
	}
	enabled, err := model.EnabledPiknoLineModelsForGroups([]string{group})
	return err == nil && enabled[line.PublicModel]
}

func piknoPriceForParameters(line *model.PiknoLineConfig, p model.PiknoPriceParameters) (*model.PiknoLineQuote, *model.PiknoLinePrice, int, error) {
	invalid := model.ErrPiknoQuoteParameters
	if p.Model != line.PublicModel || (p.Quantity != 1 && p.Quantity != 2 && p.Quantity != 4) || !piknoMediaCountsAllowed(line, p.ReferenceImages, p.ReferenceVideos, p.ReferenceAudio) {
		return nil, nil, 0, invalid
	}
	usage := model.PiknoLineUsage{Resolution: p.Resolution, Requests: 1, Images: 1}
	switch p.Operation {
	case "image", "image_edit":
		if line.Kind != "image" || p.Seconds != 0 || p.Ratio != "" || p.ReferenceVideos != 0 || p.ReferenceAudio != 0 || !slices.Contains(line.Resolutions, p.Resolution) || (p.Quality != "" && (!slices.Contains([]string{"auto", "low", "medium", "high"}, p.Quality) || len(line.Qualities) > 0 && !slices.Contains(line.Qualities, p.Quality))) || (p.Operation == "image" && p.ReferenceImages != 0) || (p.Operation == "image_edit" && p.ReferenceImages < 1) {
			return nil, nil, 0, invalid
		}
	case "video":
		if line.Kind != "video" || p.Seconds <= 0 || p.Seconds > relaycommon.MaxTaskDurationSeconds || p.Quality != "" || !slices.Contains(line.Resolutions, p.Resolution) || !slices.Contains(line.Ratios, p.Ratio) || !slices.Contains(line.Durations, float64(p.Seconds)) {
			return nil, nil, 0, invalid
		}
		usage.Seconds, usage.ReferenceImages = p.Seconds, p.ReferenceImages
	case "digital", "depth":
		if line.PublicModel != "pikno-tool-"+p.Operation || p.Quantity != 1 || p.Seconds != 0 || p.Resolution != "" || p.Quality != "" || p.Ratio != "" {
			return nil, nil, 0, invalid
		}
		if p.Operation == "digital" && (p.ReferenceImages != 1 || p.ReferenceAudio != 1 || p.ReferenceVideos != 0) || p.Operation == "depth" && (p.ReferenceImages != 0 || p.ReferenceAudio != 0 || p.ReferenceVideos != 1) {
			return nil, nil, 0, invalid
		}
	default:
		return nil, nil, 0, invalid
	}
	quote, err := model.QuotePublishedPiknoLine(line.PublicModel, line.ChannelID, usage)
	if err != nil {
		return nil, nil, 0, invalid
	}
	var selected *model.PiknoLinePrice
	for i := range line.Prices {
		price := &line.Prices[i]
		resolution := strings.ToLower(strings.TrimSpace(price.Resolution))
		requested := strings.ToLower(strings.TrimSpace(p.Resolution))
		if resolution == requested || resolution == "default" && selected == nil {
			selected = price
			if resolution == requested {
				break
			}
		}
	}
	if selected == nil && len(line.Prices) == 1 && (p.Resolution == "" || p.Resolution == "auto" || p.Resolution == "unspecified") {
		selected = &line.Prices[0]
	}
	if selected == nil {
		return nil, nil, 0, invalid
	}
	units := 1
	if selected.Unit == "second" {
		units = p.Seconds
	}
	return quote, selected, units, nil
}

// Called by the existing JSON generation guard before channel selection. Old
// clients without either header retain their original behavior.
func piknoGuardConfirmedPrice(c *gin.Context, line *model.PiknoLineConfig, body map[string]json.RawMessage, path string) bool {
	quoteValues, indexValues := c.Request.Header.Values("X-PIKNO-Quote"), c.Request.Header.Values("X-PIKNO-Quote-Index")
	if len(quoteValues) == 0 && len(indexValues) == 0 {
		return true
	}
	if len(quoteValues) != 1 || len(indexValues) != 1 {
		piknoQuoteError(c, "quote_invalid", 409, nil)
		return false
	}
	token, indexText := quoteValues[0], indexValues[0]
	if !service.PiknoSettlementEnabled() {
		piknoQuoteError(c, "quote_unavailable", 503, nil)
		return false
	}
	context, err := model.ParsePiknoPriceContext(token)
	index, indexErr := strconv.Atoi(indexText)
	if err != nil || indexErr != nil || indexText != strconv.Itoa(index) || context.UserID != c.GetInt("id") || context.TokenID != c.GetInt("token_id") {
		piknoQuoteError(c, "quote_invalid", 409, nil)
		return false
	}
	id, err := model.PiknoPriceSlotID(context, index)
	if err != nil {
		piknoQuoteError(c, "quote_invalid", 409, nil)
		return false
	}
	slot, err := model.FindPiknoPriceSlot(id)
	if err != nil {
		piknoQuoteError(c, "quote_unavailable", 503, nil)
		return false
	}
	if slot != nil {
		piknoQuoteError(c, "quote_already_submitted", 409, slot)
		return false
	}
	if context.Expires <= time.Now().Unix() {
		piknoQuoteError(c, "quote_expired", 409, nil)
		return false
	}
	if context.Parameters.Model != line.PublicModel || context.Revision != line.Revision {
		piknoQuoteError(c, "quote_changed", 409, nil)
		return false
	}
	p := model.PiknoPriceParameters{Model: line.PublicModel, Quantity: context.Parameters.Quantity}
	switch path {
	case "/v1/images/generations":
		p.Operation = "image"
	case "/v1/images/edits":
		p.Operation = "image_edit"
	case "/v1/tools/digital":
		p.Operation = "digital"
	case "/v1/tools/depth":
		p.Operation = "depth"
	default:
		p.Operation = "video"
	}
	fields := map[string]*string{"resolution": &p.Resolution, "aspect_ratio": &p.Ratio, "quality": &p.Quality}
	if line.Kind == "image" {
		delete(fields, "resolution")
		fields["size"] = &p.Resolution
	}
	for field, target := range fields {
		if body[field] != nil && common.Unmarshal(body[field], target) != nil {
			piknoQuoteError(c, "quote_parameters_changed", 409, nil)
			return false
		}
	}
	if body["seconds"] != nil && common.Unmarshal(body["seconds"], &p.Seconds) != nil {
		piknoQuoteError(c, "quote_parameters_changed", 409, nil)
		return false
	}
	for field, target := range map[string]*int{"images": &p.ReferenceImages, "image_urls": &p.ReferenceImages, "videos": &p.ReferenceVideos, "video_urls": &p.ReferenceVideos, "audios": &p.ReferenceAudio, "audio_urls": &p.ReferenceAudio} {
		if body[field] == nil {
			continue
		}
		var items []json.RawMessage
		if bytes.Equal(bytes.TrimSpace(body[field]), []byte("null")) || common.Unmarshal(body[field], &items) != nil {
			piknoQuoteError(c, "quote_parameters_changed", 409, nil)
			return false
		}
		*target += len(items)
	}
	if p != context.Parameters {
		piknoQuoteError(c, "quote_parameters_changed", 409, nil)
		return false
	}
	if !piknoPriceAccess(c, line, p.Operation) {
		piknoQuoteError(c, "quote_forbidden", 403, nil)
		return false
	}
	quote, _, _, err := piknoPriceForParameters(line, p)
	if err != nil || quote.Quota != context.Quota {
		piknoQuoteError(c, "quote_changed", 409, nil)
		return false
	}
	slot, err = model.ClaimPiknoPriceSlot(context, index)
	if errors.Is(err, model.ErrPiknoQuoteUsed) {
		piknoQuoteError(c, "quote_already_submitted", 409, slot)
		return false
	}
	if err != nil {
		piknoQuoteError(c, "quote_unavailable", 503, nil)
		return false
	}
	c.Set("pikno_price_slot", slot.ID)
	c.Set("pikno_price_revision", context.Revision)
	c.Set("pikno_price_quota", context.Quota)
	c.Set("pikno_price_expires", context.Expires)
	c.Request.Header.Del("X-PIKNO-Quote")
	c.Request.Header.Del("X-PIKNO-Quote-Index")
	return true
}
