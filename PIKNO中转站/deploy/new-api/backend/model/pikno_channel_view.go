package model

// Preserve the original channel API for other callers. The PIKNO general view
// supplies exclusions before matching, tag aggregation, ordering and pagination.
func SearchChannels(keyword, group, model string, idSort bool, sortOptions ...ChannelSortOptions) ([]*Channel, error) {
	return SearchChannelsInPiknoView(keyword, group, model, idSort, nil, sortOptions...)
}

func SearchTags(keyword, group, model string, idSort bool) ([]*string, error) {
	return SearchTagsInPiknoView(keyword, group, model, idSort, nil)
}
