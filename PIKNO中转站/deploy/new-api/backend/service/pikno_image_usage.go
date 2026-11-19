package service

import (
	"errors"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

// PiknoImageUsageQuota prices actual, normalized OpenAI image usage in CNY.
// Keep unclassified cache in the aggregate cache bucket when the categories fit.
func PiknoImageUsageQuota(usage *dto.Usage) (int, error) {
	if usage == nil {
		return 0, errors.New("missing actual image usage")
	}
	input, output := usage.PromptTokens, usage.CompletionTokens
	if input < 0 || input > common.MaxQuota || output <= 0 || output > common.MaxQuota ||
		usage.TotalTokens != 0 && int64(usage.TotalTokens) != int64(input)+int64(output) {
		return 0, errors.New("invalid actual image token totals")
	}
	details := usage.PromptTokensDetails
	cached, image := details.CachedTokens, details.ImageTokens
	if cached < 0 || cached > input || image < 0 || image > input ||
		details.TextTokens < 0 || details.TextTokens > input-image ||
		details.AudioTokens != 0 || details.CacheWriteTokens != 0 || details.CachedCreationTokens != 0 {
		return 0, errors.New("invalid image input token details")
	}

	cachedImage := 0
	cacheDetails := details.CachedTokensDetails
	if cacheDetails != nil && cacheDetails.ImageTokens != nil {
		cachedImage = *cacheDetails.ImageTokens
	}
	if cachedImage < 0 || cachedImage > cached || cachedImage > image || cached-cachedImage > input-image {
		return 0, errors.New("invalid cached image token count")
	}
	if cacheDetails != nil {
		if count := cacheDetails.TextTokens; count != nil && (*count < 0 || *count > cached-cachedImage ||
			details.TextTokens > 0 && *count > details.TextTokens) {
			return 0, errors.New("invalid cached text token count")
		}
		if count := cacheDetails.AudioTokens; count != nil && *count != 0 {
			return 0, errors.New("unexpected cached audio tokens on image usage")
		}
	}

	tokens := BuildTieredTokenParams(usage, false, map[string]bool{"cr": true, "img": true, "img_cr": true})
	// PIKNO uses 1,000,000 quota per CNY: rates in CNY per million
	// tokens are numerically the quota per token. Round the whole charge once.
	cost := tokens.P*50 + tokens.CR*12.5 + tokens.Img*80 + tokens.ImgCR*20 + tokens.C*300
	return common.QuotaRoundStrict(cost)
}
