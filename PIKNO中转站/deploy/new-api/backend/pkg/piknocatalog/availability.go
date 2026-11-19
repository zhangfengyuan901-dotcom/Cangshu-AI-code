package piknocatalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
)

// AvailabilityClosures contains close-only facts. An empty or absent list never
// means that a model is missing or available and cannot reopen any line.
type AvailabilityClosures struct {
	Provider  string   `json:"provider"`
	ClosedIDs []string `json:"closed_ids"`
}

func availabilityPrefix(provider string) string {
	switch provider {
	case "sanbao":
		return "sanbao/"
	case "canseedream":
		return "canseedream/video/"
	default:
		return ""
	}
}

func ValidAvailabilityClosures(value *AvailabilityClosures) bool {
	if value == nil || len(value.ClosedIDs) > 500 {
		return false
	}
	prefix := availabilityPrefix(value.Provider)
	if prefix == "" {
		return false
	}
	seen := map[string]bool{}
	for _, id := range value.ClosedIDs {
		if len(id) <= len(prefix) || id[:len(prefix)] != prefix || !modelID.MatchString(id[len(prefix):]) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

// Decode separately from the full catalog. Duplicate keys, excessive nesting,
// trailing JSON, and an invalid envelope cannot supply a shutdown fact.
func availabilityJSON(decoder *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, errors.New("availability_json_depth")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, container := token.(json.Delim)
	if !container {
		return token, nil
	}
	switch delimiter {
	case '{':
		value := map[string]any{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, errors.New("availability_json_key")
			}
			if _, duplicate := value[name]; duplicate {
				return nil, errors.New("availability_duplicate_key")
			}
			child, err := availabilityJSON(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			value[name] = child
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
			return nil, errors.New("availability_json_object")
		}
		return value, nil
	case '[':
		value := []any{}
		for decoder.More() {
			child, err := availabilityJSON(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			value = append(value, child)
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim(']') {
			return nil, errors.New("availability_json_array")
		}
		return value, nil
	default:
		return nil, errors.New("availability_json_delimiter")
	}
}

// The reviewed provider endpoints return one complete non-paginated directory.
// A new pagination envelope is an unknown contract, never authority to delete
// the routes omitted from its first page. Shutdown facts remain independent.
func validateCompleteCatalog(provider string, body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	value, err := availabilityJSON(decoder, 0)
	if err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("catalog_json_trailing")
	}
	root, ok := value.(map[string]any)
	if !ok {
		return errors.New("catalog_envelope")
	}
	envelopes := []map[string]any{root}
	if provider == "canseedream" {
		defaults, ok := root["defaults"].(map[string]any)
		if !ok {
			return errors.New("catalog_envelope")
		}
		envelopes = append(envelopes, defaults)
	}
	normalize := strings.NewReplacer("_", "", "-", "")
	for i := 0; i < len(envelopes); i++ {
		envelope := envelopes[i]
		for name := range envelope {
			field := strings.ToLower(normalize.Replace(name))
			switch field {
			case "pagination", "paging", "page", "pagenumber", "pagesize", "perpage", "totalpages", "cursor", "next", "nextpage", "nextcursor", "hasmore", "hasnext", "continuationtoken", "offset", "limit", "total", "totalcount", "totalitems":
				return errors.New("catalog_pagination_unverified")
			case "meta", "metadata", "links", "pageinfo":
				if nested, ok := envelope[name].(map[string]any); ok {
					envelopes = append(envelopes, nested)
				}
			}
		}
	}
	return nil
}

func ParseAvailabilityClosures(provider string, body []byte) (*AvailabilityClosures, error) {
	prefix := availabilityPrefix(provider)
	if prefix == "" || len(body) > 2*1024*1024 {
		return nil, errors.New("availability_provider_or_size")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	value, err := availabilityJSON(decoder, 0)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("availability_json_trailing")
	}
	root, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("availability_envelope")
	}
	items, ok := root["data"].([]any)
	if provider == "canseedream" {
		defaults, _ := root["defaults"].(map[string]any)
		items, ok = defaults["videoProviders"].([]any)
	}
	if !ok || len(items) > 500 {
		return nil, errors.New("availability_envelope")
	}
	counts := map[string]int{}
	closed := map[string]bool{}
	for _, item := range items {
		raw, ok := item.(map[string]any)
		if !ok || provider == "sanbao" && raw["type"] != "video" {
			continue
		}
		id, ok := raw["id"].(string)
		if !ok || !modelID.MatchString(id) {
			continue
		}
		counts[id]++
		valid, disabled := true, false
		for _, field := range []string{"enabled", "available", "disabled"} {
			if value, present := raw[field]; present {
				flag, ok := value.(bool)
				if !ok {
					valid = false
					continue
				}
				disabled = disabled || field == "disabled" && flag || field != "disabled" && !flag
			}
		}
		if valid && disabled {
			closed[id] = true
		}
	}
	result := &AvailabilityClosures{Provider: provider, ClosedIDs: []string{}}
	for id := range closed {
		// Duplicate identities are ambiguous even when only one row is closed.
		if counts[id] == 1 {
			result.ClosedIDs = append(result.ClosedIDs, prefix+id)
		}
	}
	slices.Sort(result.ClosedIDs)
	return result, nil
}
