package controller

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/gin-gonic/gin"
)

func piknoReadDirectImage(c *gin.Context) (map[string]json.RawMessage, error) {
	invalid := errors.New("invalid direct image multipart")
	_, parameters, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || parameters["boundary"] == "" || c.GetHeader("Content-Encoding") != "" {
		return nil, invalid
	}
	storage, err := common.GetBodyStorage(c)
	if err != nil {
		return nil, invalid
	}
	form, err := multipart.NewReader(storage, parameters["boundary"]).ReadForm(1 << 20)
	if err != nil {
		return nil, invalid
	}
	accepted := false
	defer func() {
		if !accepted {
			_ = form.RemoveAll()
		}
	}()
	body := make(map[string]json.RawMessage)
	textBytes := 0
	for field, values := range form.Value {
		if len(values) != 1 || len(values[0]) > 64<<10 {
			return nil, invalid
		}
		textBytes += len(field) + len(values[0])
		if textBytes > 64<<10 {
			return nil, invalid
		}
		var value any = values[0]
		if field == "n" || field == "output_compression" {
			value, err = strconv.Atoi(values[0])
			if err != nil {
				return nil, invalid
			}
		}
		body[field], err = common.Marshal(value)
		if err != nil {
			return nil, invalid
		}
	}
	images := form.File["image"]
	if len(images) == 0 {
		images = form.File["image[]"]
	}
	if len(images) < 1 || len(images) > 20 || len(form.File) != 1 {
		return nil, invalid
	}
	for _, file := range images {
		if file.Size < 12 || file.Size > 30<<20 || !strings.HasPrefix(file.Header.Get("Content-Type"), "image/") {
			return nil, invalid
		}
		reader, openErr := file.Open()
		if openErr != nil {
			return nil, invalid
		}
		var prefix [16]byte
		count, readErr := io.ReadFull(reader, prefix[:])
		_ = reader.Close()
		if readErr != nil && readErr != io.ErrUnexpectedEOF || !piknoDirectMIMEMatches(file.Header.Get("Content-Type"), prefix[:count]) {
			return nil, invalid
		}
	}
	// Quote matching uses actual parsed file counts, never client-supplied counts.
	if body["images"] != nil {
		return nil, invalid
	}
	body["images"], err = common.Marshal(make([]string, len(images)))
	if err != nil {
		return nil, invalid
	}
	_, err = storage.Seek(0, io.SeekStart)
	if err != nil {
		return nil, invalid
	}
	c.Request.Body = io.NopCloser(storage)
	c.Request.MultipartForm = form
	c.Request.PostForm = url.Values(form.Value)
	c.Set("_original_multipart_ct", c.GetHeader("Content-Type"))
	c.Set("pikno_direct_multipart", true)
	accepted = true
	return body, nil
}

func piknoDirectMIMEMatches(contentType string, prefix []byte) bool {
	switch contentType {
	case "image/png":
		return bytes.HasPrefix(prefix, []byte{137, 80, 78, 71, 13, 10, 26, 10})
	case "image/jpeg":
		return bytes.HasPrefix(prefix, []byte{255, 216, 255})
	case "image/webp":
		return len(prefix) >= 12 && string(prefix[:4]) == "RIFF" && string(prefix[8:12]) == "WEBP"
	case "audio/wav":
		return len(prefix) >= 12 && string(prefix[:4]) == "RIFF" && string(prefix[8:12]) == "WAVE"
	case "video/mp4", "video/quicktime", "audio/mp4":
		return len(prefix) >= 12 && string(prefix[4:8]) == "ftyp"
	case "video/webm":
		return bytes.HasPrefix(prefix, []byte{26, 69, 223, 163})
	case "audio/mpeg":
		return bytes.HasPrefix(prefix, []byte("ID3")) || len(prefix) >= 2 && prefix[0] == 255 && prefix[1]&224 == 224
	case "audio/aac":
		return len(prefix) >= 2 && prefix[0] == 255 && prefix[1]&246 == 240
	}
	return false
}

type piknoToolInputTicket struct {
	Version           int    `json:"v"`
	Audience          string `json:"aud"`
	UserID            int    `json:"uid"`
	ID                string `json:"id"`
	Issued            int64  `json:"iat"`
	Expires           int64  `json:"exp"`
	MIME              string `json:"mime"`
	Size              int64  `json:"size"`
	Filename          string `json:"filename"`
	CredentialVersion string `json:"credential_version"`
}

func piknoValidateToolInput(raw string, uid int, kind string) (piknoToolInputTicket, error) {
	var ticket piknoToolInputTicket
	invalid := errors.New("invalid direct tool reference")
	secret := os.Getenv("PIKNO_MEDIA_TICKET_KEY")
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 4096 || len(secret) < 32 || os.Getenv("PIKNO_MEDIA_ENABLED") != "true" || u.Scheme != "https" || u.Host != "www.piknoai.com" || u.User != nil || u.Fragment != "" || u.RawPath != "" {
		return ticket, invalid
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(query) != 1 || len(query["ticket"]) != 1 {
		return ticket, invalid
	}
	parts := strings.Split(query.Get("ticket"), ".")
	if len(parts) != 2 {
		return ticket, invalid
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0]))
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(signature, mac.Sum(nil)) {
		return ticket, invalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || common.Unmarshal(payload, &ticket) != nil {
		return ticket, invalid
	}
	id, idErr := hex.DecodeString(ticket.ID)
	version, versionErr := hex.DecodeString(ticket.CredentialVersion)
	now := time.Now().Unix()
	limit := int64(50 << 20)
	if kind == "image" {
		limit = 30 << 20
	}
	if idErr != nil || len(id) != 16 || ticket.ID != strings.ToLower(ticket.ID) || u.Path != "/media/v1/tool-inputs/"+ticket.ID || ticket.Version != 1 || ticket.Audience != "pikno-tool-input" || uid < 1 || ticket.UserID != uid || ticket.Issued > now+30 || ticket.Expires <= now || ticket.Expires <= ticket.Issued || ticket.Expires-ticket.Issued > 7200 || !strings.HasPrefix(ticket.MIME, kind+"/") || !piknoDirectMIMEAllowed(ticket.MIME) || ticket.Size < 12 || ticket.Size > limit || ticket.CredentialVersion != "legacy" && (versionErr != nil || len(version) != 16) || len(ticket.Filename) < 1 || len(ticket.Filename) > 512 || path.IsAbs(ticket.Filename) || path.Clean(ticket.Filename) != ticket.Filename || strings.Contains(ticket.Filename, "\\") || strings.Contains(ticket.Filename, ":") || strings.HasPrefix(ticket.Filename, ".") || strings.ContainsAny(ticket.Filename, "\r\n\x00") {
		return ticket, invalid
	}
	for _, char := range ticket.Filename {
		if !(char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || strings.ContainsRune("_./-", char)) {
			return ticket, invalid
		}
	}
	return ticket, nil
}

func piknoDirectMIMEAllowed(contentType string) bool {
	return contentType == "image/png" || contentType == "image/jpeg" || contentType == "image/webp" || contentType == "video/mp4" || contentType == "video/webm" || contentType == "video/quicktime" || contentType == "audio/mpeg" || contentType == "audio/wav" || contentType == "audio/mp4" || contentType == "audio/aac"
}

// Tool credentials are retained by the execution service. File bytes stream
// through the authenticated relay and never enter the media object bucket.
func PiknoDirectMediaUpload(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	uid := c.GetInt("id")
	secret := os.Getenv("PIKNO_TOOLS_BRIDGE_SECRET")
	if uid < 1 || common.GetContextKeyString(c, constant.ContextKeyTokenGroup) != "tool-standard" {
		c.JSON(403, gin.H{"error": "A tool key is required"})
		return
	}
	if os.Getenv("PIKNO_TOOLS_ENABLED") != "true" || os.Getenv("PIKNO_MEDIA_ENABLED") != "true" || len(os.Getenv("PIKNO_MEDIA_TICKET_KEY")) < 32 || len(secret) < 32 || len(secret) > 400 || strings.ContainsAny(secret, "\r\n") {
		c.JSON(503, gin.H{"error": "Direct tool upload unavailable"})
		return
	}
	contentType := c.GetHeader("Content-Type")
	limit := int64(50 << 20)
	if strings.HasPrefix(contentType, "image/") {
		limit = 30 << 20
	}
	size := c.Request.ContentLength
	if !piknoDirectMIMEAllowed(contentType) || size < 12 || size > limit || c.GetHeader("Content-Encoding") != "" {
		c.JSON(400, gin.H{"error": "Unsupported direct media type or size"})
		return
	}
	reader := http.MaxBytesReader(c.Writer, c.Request.Body, size)
	var prefix [16]byte
	count, err := io.ReadFull(reader, prefix[:])
	if err != nil && err != io.ErrUnexpectedEOF || !piknoDirectMIMEMatches(contentType, prefix[:count]) {
		c.JSON(400, gin.H{"error": "Invalid direct media format"})
		return
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, "https://www.piknoai.com/media/v1/tools/uploads", io.MultiReader(bytes.NewReader(prefix[:count]), reader))
	if err != nil {
		c.JSON(503, gin.H{"error": "Direct tool upload unavailable"})
		return
	}
	req.ContentLength = size
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Pikno-User", strconv.Itoa(uid))
	client := &http.Client{Timeout: 180 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		c.JSON(503, gin.H{"error": "Direct media upload unconfirmed; select the file again"})
		return
	}
	defer response.Body.Close()
	var result struct {
		URL     string `json:"url"`
		Expires int64  `json:"expires_at"`
	}
	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusOK || common.DecodeJson(io.LimitReader(response.Body, 8192), &result) != nil {
		c.JSON(502, gin.H{"error": "Direct media upload unconfirmed; select the file again"})
		return
	}
	ticket, err := piknoValidateToolInput(result.URL, uid, strings.Split(contentType, "/")[0])
	if err != nil || ticket.MIME != contentType || ticket.Size != size || result.Expires != ticket.Expires {
		c.JSON(502, gin.H{"error": "Invalid direct media authorization"})
		return
	}
	c.JSON(201, gin.H{"file": gin.H{"url": result.URL, "expires_at": result.Expires}, "url": result.URL, "expires_at": result.Expires})
}
