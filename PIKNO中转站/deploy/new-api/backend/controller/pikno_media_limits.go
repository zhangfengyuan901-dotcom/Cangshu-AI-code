package controller

import "github.com/QuantumNous/new-api/model"

func piknoMediaCountsAllowed(line *model.PiknoLineConfig, images, videos, audio int) bool {
	if line == nil || images < 0 || videos < 0 || audio < 0 || images > model.PiknoMaxReferenceAssets || videos > model.PiknoMaxReferenceAssets || audio > model.PiknoMaxReferenceAssets {
		return false
	}
	return images <= line.MaxImages && videos <= line.MaxVideos && audio <= line.MaxAudio && images+videos+audio <= line.MediaTotalLimit()
}
